using System.Collections.ObjectModel;
using Avalonia.Media;
using Avalonia.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using WorkDesktop.Services;
using WorkDesktop.Terminal;

namespace WorkDesktop.ViewModels;

public sealed partial class SessionItem : ObservableObject
{
    public string Id { get; }
    public string Branch { get; }
    public string Target { get; }
    [ObservableProperty] private string _status = "";
    [ObservableProperty] private IBrush _statusBrush = Brushes.Gray;

    public SessionItem(SessionInfo info)
    {
        Id = info.Id;
        Branch = info.Branch;
        Target = info.Target;
        Update(info);
    }

    public void Update(SessionInfo info)
    {
        Status = info.Status switch
        {
            "needs_input" => "needs input",
            "working" => "working",
            "idle" => "done",
            "active" => "active",
            "open" => "open",
            _ => "",
        };
        StatusBrush = new SolidColorBrush(Color.Parse(info.Status switch
        {
            "needs_input" => "#E3B457",
            "working" or "active" => "#35D0BE",
            "idle" => "#98BB6C",
            _ => "#4E5865",
        }));
    }
}

/// <summary>
/// The session list (polled from work web) and the terminal being shown. The last few terminals
/// stay connected, as in the browser's terminal deck, so switching back is instant.
/// </summary>
public sealed partial class MainViewModel : ObservableObject
{
    private const int KeepAlive = 5;
    private WorkWeb? _web;
    private readonly List<TerminalSession> _recent = new();

    public ObservableCollection<SessionItem> Sessions { get; } = new();

    [ObservableProperty] private SessionItem? _selected;
    [ObservableProperty] private TerminalSession? _terminal;
    [ObservableProperty] private string _status = "Looking for work web…";
    [ObservableProperty] private string _latency = "type to measure key → drawn";

    /// <summary>Completes once work web was found (or could not be).</summary>
    public Task Started => _started.Task;
    private readonly TaskCompletionSource _started = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public async Task StartAsync()
    {
        try
        {
            _web = await WorkWeb.FindOrStartAsync(s => Status = s);
            _started.TrySetResult();
            Status = $"work web at {_web.Base}";
            await RefreshAsync();
            var timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
            timer.Tick += async (_, _) => await RefreshAsync();
            timer.Start();
        }
        catch (Exception ex)
        {
            Status = ex.Message;
            _started.TrySetException(ex);
        }
    }

    private async Task RefreshAsync()
    {
        if (_web == null) return;
        IReadOnlyList<SessionInfo> rows;
        try { rows = await _web.SessionsAsync(); }
        catch (Exception ex) { Status = $"work web not answering: {ex.Message}"; return; }

        var byId = Sessions.ToDictionary(s => s.Id);
        for (var i = 0; i < rows.Count; i++)
        {
            if (byId.Remove(rows[i].Id, out var existing))
            {
                existing.Update(rows[i]);
                var at = Sessions.IndexOf(existing);
                if (at != i) Sessions.Move(at, i);
            }
            else Sessions.Insert(i, new SessionItem(rows[i]));
        }
        foreach (var gone in byId.Values) Sessions.Remove(gone);
    }

    partial void OnSelectedChanged(SessionItem? value)
    {
        if (value != null) Open(value.Id);
    }

    /// <summary>Shows a session's terminal, reusing a connection that is still alive.</summary>
    public void Open(string id)
    {
        if (_web == null) return;
        var term = _recent.FirstOrDefault(t => t.Id == id);
        if (term == null)
        {
            term = new TerminalSession(id, _web.Base);
            term.Start();
        }
        _recent.Remove(term);
        _recent.Insert(0, term);
        while (_recent.Count > KeepAlive)
        {
            _recent[^1].Dispose();
            _recent.RemoveAt(_recent.Count - 1);
        }
        Terminal = term;
    }

    public void UpdateLatency()
    {
        if (Terminal?.Latency.Summary() is { } s)
            Latency = $"key → drawn  p50 {s.P50:0.0} ms · p95 {s.P95:0.0} ms  ({s.Count} keys)";
    }
}
