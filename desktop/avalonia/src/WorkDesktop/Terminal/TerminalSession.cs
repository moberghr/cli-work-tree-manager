using System.Diagnostics;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace WorkDesktop.Terminal;

public enum SessionPhase { Connecting, Starting, Ready, Exited, Elsewhere, Closed }

/// <summary>
/// One session's terminal: the work web WebSocket (/ws/sessions/&lt;id&gt;/terminal, the same one the
/// browser's PtyView uses) feeding a <see cref="VtTerminal"/>. Output is parsed on the socket's
/// thread, not the UI thread; the view is only told that something changed.
/// <para>
/// Protocol (see src/core/terminal-ws.ts): binary frames are PTY output; text frames are control
/// JSON — the first is always <c>replay</c> (the screen as the host has it). We send
/// <c>{type:'input'}</c> and <c>{type:'resize'}</c>, and nothing before the replay has been drawn.
/// </para>
/// </summary>
public sealed class TerminalSession : IDisposable
{
    private readonly Uri _wsUri;
    private ClientWebSocket? _ws;
    private CancellationTokenSource? _cts;
    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly Queue<string> _pendingInput = new();
    private Decoder _utf8 = new UTF8Encoding(false).GetDecoder();
    private int _wantCols = 120, _wantRows = 32;
    private (int Cols, int Rows) _sent;

    public string Id { get; }
    public VtTerminal Terminal { get; private set; } = new(120, 32);
    public SessionPhase Phase { get; private set; } = SessionPhase.Connecting;
    public string? Message { get; private set; }

    /// <summary>Raised (on a background thread) when the screen or the phase changed.</summary>
    public event Action? Changed;

    public LatencyProbe Latency { get; } = new();

    public TerminalSession(string id, Uri webBase)
    {
        Id = id;
        var ws = new UriBuilder(webBase) { Scheme = webBase.Scheme == "https" ? "wss" : "ws", Path = $"/ws/sessions/{Uri.EscapeDataString(id)}/terminal" };
        _wsUri = ws.Uri;
    }

    public void Start() => _ = RunAsync();

    private async Task RunAsync()
    {
        _cts?.Cancel();
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        var ws = new ClientWebSocket();
        _ws = ws;
        lock (Terminal.Sync)
        {
            Terminal = new VtTerminal(_wantCols, _wantRows) { Reply = SendInput };
            _utf8 = new UTF8Encoding(false).GetDecoder();
            _sent = default;
        }
        SetPhase(SessionPhase.Connecting, null);
        var slow = Task.Delay(700, ct).ContinueWith(t =>
        {
            if (!t.IsCanceled && Phase == SessionPhase.Connecting) SetPhase(SessionPhase.Starting, null);
        }, TaskScheduler.Default);

        try
        {
            await ws.ConnectAsync(_wsUri, ct);
            await ReceiveLoopAsync(ws, ct);
        }
        catch (OperationCanceledException) { return; }
        catch (Exception ex)
        {
            SetPhase(SessionPhase.Closed, $"Connection failed: {ex.Message}");
            return;
        }
        if (Phase is not (SessionPhase.Exited or SessionPhase.Elsewhere))
            SetPhase(SessionPhase.Closed, "Connection closed — press Enter to reconnect");
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        var message = new MemoryStream();
        while (ws.State == WebSocketState.Open && !ct.IsCancellationRequested)
        {
            message.SetLength(0);
            WebSocketReceiveResult r;
            do
            {
                r = await ws.ReceiveAsync(buffer, ct);
                if (r.MessageType == WebSocketMessageType.Close) return;
                message.Write(buffer, 0, r.Count);
            } while (!r.EndOfMessage);

            if (r.MessageType == WebSocketMessageType.Binary) OnOutput(message.GetBuffer().AsSpan(0, (int)message.Length));
            else OnControl(Encoding.UTF8.GetString(message.GetBuffer(), 0, (int)message.Length));
        }
    }

    private void OnOutput(ReadOnlySpan<byte> bytes)
    {
        var chars = new char[_utf8.GetCharCount(bytes, flush: false)];
        var n = _utf8.GetChars(bytes, chars, flush: false);
        lock (Terminal.Sync) Terminal.Feed(new string(chars, 0, n));
        Latency.Received();
        Changed?.Invoke();
    }

    private void OnControl(string json)
    {
        JsonElement msg;
        try { msg = JsonDocument.Parse(json).RootElement; }
        catch (JsonException) { return; }
        var type = msg.TryGetProperty("type", out var t) ? t.GetString() : null;
        switch (type)
        {
            case "replay":
                lock (Terminal.Sync)
                {
                    // Draw the snapshot at the grid it was serialized for, then take our own size.
                    if (msg.TryGetProperty("cols", out var c) && msg.TryGetProperty("rows", out var rw) && c.TryGetInt32(out var cols) && rw.TryGetInt32(out var rows))
                        Terminal.Resize(cols, rows);
                    if (msg.TryGetProperty("data", out var d) && d.GetString() is { Length: > 0 } data) Terminal.Feed(data);
                    Terminal.Resize(_wantCols, _wantRows);
                }
                SetPhase(SessionPhase.Ready, null);
                SendResizeIfChanged();
                while (_pendingInput.TryDequeue(out var queued)) Send(new { type = "input", data = queued });
                break;
            case "exit":
                var code = msg.TryGetProperty("code", out var ec) && ec.TryGetInt32(out var n) ? n : 0;
                SetPhase(SessionPhase.Exited, $"Session exited{(code != 0 ? $" with code {code}" : "")} — press Enter to start it again");
                break;
            case "error":
                SetPhase(Phase, msg.TryGetProperty("message", out var m) ? m.GetString() : "error");
                break;
            case "elsewhere":
                SetPhase(SessionPhase.Elsewhere, "This session's Claude runs in another terminal (started with --no-host). Use it there, or restart it with `work tree … --host`.");
                break;
        }
    }

    private void SetPhase(SessionPhase phase, string? message)
    {
        Phase = phase;
        Message = message;
        Changed?.Invoke();
    }

    // ---------------------------------------------------------------- outgoing

    /// <summary>Keyboard input. After an exit or a drop, Enter reconnects (the server respawns Claude).</summary>
    public void SendInput(string data)
    {
        if (Phase is SessionPhase.Exited or SessionPhase.Closed)
        {
            if (data == "\r") Start();
            return;
        }
        if (Phase != SessionPhase.Ready)
        {
            _pendingInput.Enqueue(data);
            return;
        }
        Send(new { type = "input", data });
    }

    /// <summary>The size the view has room for. Only the view showing this session calls it: on a
    /// shared PTY the last resize wins for every client, the real terminal included.</summary>
    public void Resize(int cols, int rows)
    {
        _wantCols = cols;
        _wantRows = rows;
        lock (Terminal.Sync) Terminal.Resize(cols, rows);
        if (Phase == SessionPhase.Ready) SendResizeIfChanged();
        Changed?.Invoke();
    }

    private void SendResizeIfChanged()
    {
        if (_sent == (_wantCols, _wantRows)) return;
        _sent = (_wantCols, _wantRows);
        Send(new { type = "resize", cols = _wantCols, rows = _wantRows });
    }

    private void Send(object frame)
    {
        var ws = _ws;
        if (ws is not { State: WebSocketState.Open }) return;
        var bytes = JsonSerializer.SerializeToUtf8Bytes(frame);
        _ = Task.Run(async () =>
        {
            await _sendLock.WaitAsync();
            try { await ws.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
            catch (WebSocketException) { /* the receive loop reports the drop */ }
            catch (ObjectDisposedException) { }
            finally { _sendLock.Release(); }
        });
    }

    public void Dispose()
    {
        _cts?.Cancel();
        try { _ws?.Abort(); } catch { /* closing anyway */ }
        _ws?.Dispose();
    }
}

/// <summary>
/// Keystroke → echo received → drawn, like scripts/terminal-latency.ts measures in the browser.
/// </summary>
public sealed class LatencyProbe
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly List<double> _samples = new();
    private double _keyAt = -1, _recvAt = -1;

    public void Key()
    {
        _keyAt = _clock.Elapsed.TotalMilliseconds;
        _recvAt = -1;
    }

    public void Received()
    {
        if (_keyAt >= 0 && _recvAt < 0) _recvAt = _clock.Elapsed.TotalMilliseconds;
    }

    /// <summary>Called when a frame was drawn; true when that completed a sample.</summary>
    public bool Drawn()
    {
        if (_keyAt < 0 || _recvAt < 0) return false;
        var total = _clock.Elapsed.TotalMilliseconds - _keyAt;
        _keyAt = _recvAt = -1;
        if (total > 1000) return false; // not an echo of that key
        lock (_samples)
        {
            _samples.Add(total);
            if (_samples.Count > 200) _samples.RemoveAt(0);
        }
        return true;
    }

    public void Reset()
    {
        lock (_samples) _samples.Clear();
        _keyAt = _recvAt = -1;
    }

    public double[] Samples()
    {
        lock (_samples) return _samples.ToArray();
    }

    public (double P50, double P95, int Count)? Summary()
    {
        lock (_samples)
        {
            if (_samples.Count == 0) return null;
            var s = _samples.Order().ToArray();
            return (s[s.Length / 2], s[Math.Min(s.Length - 1, (int)(s.Length * 0.95))], s.Length);
        }
    }
}
