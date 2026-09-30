using System.Globalization;
using System.Runtime.CompilerServices;
using Avalonia;
using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Input.Platform;
using Avalonia.Media;
using Avalonia.Media.Immutable;
using Avalonia.Threading;

namespace WorkDesktop.Terminal;

/// <summary>
/// Draws a <see cref="TerminalSession"/>'s grid (Skia, through Avalonia's DrawingContext) and turns
/// keys into the bytes a terminal sends. Each row's text runs are cached until that row changes,
/// so a spinner redrawing one line re-lays out one line.
/// </summary>
public sealed class TerminalView : Control
{
    public static readonly StyledProperty<TerminalSession?> SessionProperty =
        AvaloniaProperty.Register<TerminalView, TerminalSession?>(nameof(Session));

    public TerminalSession? Session
    {
        get => GetValue(SessionProperty);
        set => SetValue(SessionProperty, value);
    }

    /// <summary>Raised on the UI thread after a frame that completed a latency sample.</summary>
    public event Action? LatencyUpdated;

    private const double FontSize = 13;
    private const double Pad = 8;
    private static readonly FontFamily Mono = new("Cascadia Mono, Cascadia Code, Consolas, Courier New");
    private static readonly Typeface[] Faces =
    {
        new(Mono), new(Mono, FontStyle.Normal, FontWeight.Bold),
        new(Mono, FontStyle.Italic), new(Mono, FontStyle.Italic, FontWeight.Bold),
    };
    private static readonly Color DefaultFg = Color.Parse("#d4d4d4");
    private static readonly Color DefaultBg = Color.Parse("#1e1e1e");
    private static readonly Color[] Palette = BuildPalette();

    private double _cellW = 8, _cellH = 17;
    private int _scrollOffset;
    private int _invalidateQueued;
    private readonly ConditionalWeakTable<Line, RowCache> _rows = new();
    private readonly Dictionary<uint, IBrush> _brushes = new();

    private sealed class RowCache
    {
        public int Version = -1;
        public List<RunOp> Ops = new();
    }

    private readonly record struct RunOp(double X, double Width, IBrush? Bg, FormattedText? Text, IBrush Fg, bool Underline, bool Strike);

    static TerminalView()
    {
        FocusableProperty.OverrideDefaultValue<TerminalView>(true);
        ClipToBoundsProperty.OverrideDefaultValue<TerminalView>(true);
    }

    public TerminalView()
    {
        var probe = new FormattedText(new string('W', 20), CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Faces[0], FontSize, Brushes.White);
        _cellW = probe.WidthIncludingTrailingWhitespace / 20;
        _cellH = Math.Ceiling(probe.Height);
    }

    protected override void OnPropertyChanged(AvaloniaPropertyChangedEventArgs change)
    {
        base.OnPropertyChanged(change);
        if (change.Property != SessionProperty) return;
        if (change.OldValue is TerminalSession old) old.Changed -= OnSessionChanged;
        if (change.NewValue is TerminalSession now)
        {
            now.Changed += OnSessionChanged;
            _scrollOffset = 0;
            FitToBounds();
        }
        InvalidateVisual();
    }

    protected override void OnDetachedFromVisualTree(VisualTreeAttachmentEventArgs e)
    {
        base.OnDetachedFromVisualTree(e);
        if (Session is { } s) s.Changed -= OnSessionChanged;
    }

    /// <summary>From the socket thread: coalesce into one redraw per UI frame.</summary>
    private void OnSessionChanged()
    {
        if (Interlocked.Exchange(ref _invalidateQueued, 1) == 1) return;
        Dispatcher.UIThread.Post(() =>
        {
            Interlocked.Exchange(ref _invalidateQueued, 0);
            InvalidateVisual();
        }, DispatcherPriority.Render);
    }

    protected override void OnSizeChanged(SizeChangedEventArgs e)
    {
        base.OnSizeChanged(e);
        FitToBounds();
    }

    private void FitToBounds()
    {
        if (Session is not { } s || Bounds.Width < 20 || Bounds.Height < 20) return;
        var cols = Math.Max(20, (int)((Bounds.Width - 2 * Pad) / _cellW));
        var rows = Math.Max(5, (int)((Bounds.Height - 2 * Pad) / _cellH));
        s.Resize(cols, rows);
    }

    // ------------------------------------------------------------------ render

    public override void Render(DrawingContext ctx)
    {
        ctx.FillRectangle(Brush(0, bg: true), new Rect(Bounds.Size));
        if (Session is not { } session) return;
        var term = session.Terminal;
        lock (term.Sync)
        {
            _scrollOffset = Math.Min(_scrollOffset, term.ScrollbackCount);
            for (var row = 0; row < term.Rows; row++)
            {
                var line = term.GetViewLine(row, _scrollOffset);
                var y = Pad + row * _cellH;
                foreach (var op in OpsFor(line))
                {
                    if (op.Bg != null) ctx.FillRectangle(op.Bg, new Rect(Pad + op.X, y, op.Width, _cellH));
                    if (op.Text != null) ctx.DrawText(op.Text, new Point(Pad + op.X, y));
                    if (op.Underline) ctx.DrawLine(new Pen(op.Fg, 1), new Point(Pad + op.X, y + _cellH - 1.5), new Point(Pad + op.X + op.Width, y + _cellH - 1.5));
                    if (op.Strike) ctx.DrawLine(new Pen(op.Fg, 1), new Point(Pad + op.X, y + _cellH / 2), new Point(Pad + op.X + op.Width, y + _cellH / 2));
                }
            }
            if (_scrollOffset == 0 && term.CursorVisible && session.Phase == SessionPhase.Ready) DrawCursor(ctx, term);
        }
        DrawOverlay(ctx, session);
        HasDrawnReady = session.Phase == SessionPhase.Ready;
        if (session.Latency.Drawn()) Dispatcher.UIThread.Post(() => LatencyUpdated?.Invoke(), DispatcherPriority.Background);
    }

    private void DrawCursor(DrawingContext ctx, VtTerminal term)
    {
        var line = term.GetLine(term.CursorY);
        var cell = line.Cells[Math.Min(term.CursorX, line.Cells.Length - 1)];
        var rect = new Rect(Pad + term.CursorX * _cellW, Pad + term.CursorY * _cellH, _cellW * (cell.Width == 2 ? 2 : 1), _cellH);
        var brush = Brush(0, bg: false);
        if (!IsFocused)
        {
            ctx.DrawRectangle(null, new Pen(brush, 1), rect.Deflate(0.5));
            return;
        }
        ctx.FillRectangle(brush, rect);
        if (cell.Text != null)
            ctx.DrawText(new FormattedText(cell.Text, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, Faces[0], FontSize, Brush(0, bg: true)), rect.TopLeft);
    }

    private void DrawOverlay(DrawingContext ctx, TerminalSession session)
    {
        var text = session.Phase switch
        {
            SessionPhase.Connecting => "Connecting…",
            SessionPhase.Starting => "Starting Claude — resuming the conversation…",
            _ => session.Message,
        };
        if (string.IsNullOrEmpty(text)) return;
        var ft = new FormattedText(text, CultureInfo.CurrentCulture, FlowDirection.LeftToRight, new Typeface("Inter"), 13, new SolidColorBrush(Color.Parse("#9da5b4")))
        {
            MaxTextWidth = Math.Max(100, Bounds.Width - 80),
            TextAlignment = TextAlignment.Center,
        };
        var origin = new Point((Bounds.Width - ft.MaxTextWidth) / 2, Bounds.Height / 2 - ft.Height / 2);
        if (session.Phase is SessionPhase.Connecting or SessionPhase.Starting)
            ctx.FillRectangle(Brush(0, bg: true), new Rect(Bounds.Size));
        else
            ctx.FillRectangle(new SolidColorBrush(Color.FromArgb(0xE0, 0x1e, 0x1e, 0x1e)), new Rect(0, origin.Y - 12, Bounds.Width, ft.Height + 24));
        ctx.DrawText(ft, origin);
    }

    private List<RunOp> OpsFor(Line line)
    {
        var cache = _rows.GetOrCreateValue(line);
        if (cache.Version == line.Version) return cache.Ops;
        cache.Version = line.Version;
        cache.Ops = BuildOps(line.Cells);
        return cache.Ops;
    }

    /// <summary>
    /// Runs of cells with the same style. Plain text (ASCII, Latin, box drawing) is laid out as one
    /// string per run; anything else — emoji, CJK, symbols a fallback font draws — is placed on its
    /// own cell so a glyph of a different width can't shift the rest of the row.
    /// </summary>
    private List<RunOp> BuildOps(Cell[] cells)
    {
        var ops = new List<RunOp>();
        var x = 0;
        while (x < cells.Length)
        {
            var attr = cells[x].Attr;
            var start = x;
            while (x < cells.Length && cells[x].Attr == attr) x++;
            var (fg, bg) = Colors(attr);
            var bgBrush = bg == 0 ? null : Brush(bg, bg: true);
            var fgBrush = Brush(fg, bg: false, dim: attr.Flags.HasFlag(CellFlags.Dim));
            var face = Faces[(attr.Flags.HasFlag(CellFlags.Bold) ? 1 : 0) + (attr.Flags.HasFlag(CellFlags.Italic) ? 2 : 0)];
            var underline = attr.Flags.HasFlag(CellFlags.Underline);
            var strike = attr.Flags.HasFlag(CellFlags.Strike);
            ops.Add(new RunOp(start * _cellW, (x - start) * _cellW, bgBrush, null, fgBrush, underline, strike));
            if (attr.Flags.HasFlag(CellFlags.Hidden)) continue;

            var sb = new System.Text.StringBuilder();
            var textStart = start;
            void Flush(int end)
            {
                var s = sb.ToString().TrimEnd();
                if (s.Length > 0)
                    ops.Add(new RunOp(textStart * _cellW, (end - textStart) * _cellW, null, Text(s, face, fgBrush), fgBrush, false, false));
                sb.Clear();
            }
            for (var i = start; i < x; i++)
            {
                var c = cells[i];
                if (c.Width == 0) continue;
                if (c.Text == null || IsGridSafe(c.Text))
                {
                    if (sb.Length == 0) textStart = i;
                    sb.Append(c.Text ?? " ");
                    continue;
                }
                Flush(i);
                ops.Add(new RunOp(i * _cellW, c.Width * _cellW, null, Text(c.Text, face, fgBrush), fgBrush, false, false));
            }
            Flush(x);
        }
        return ops;
    }

    private static bool IsGridSafe(string s) =>
        s.Length == 1 && s[0] is (>= ' ' and <= '~') or (>= ' ' and <= 'ɏ') or (>= '─' and <= '▟');

    private static FormattedText Text(string s, Typeface face, IBrush fg) =>
        new(s, CultureInfo.InvariantCulture, FlowDirection.LeftToRight, face, FontSize, fg);

    // ------------------------------------------------------------------ colour

    /// <summary>Resolved (fg, bg) colour keys after bold-is-bright and inverse, like xterm.js.</summary>
    private static (uint Fg, uint Bg) Colors(Attr a)
    {
        var fg = a.Fg;
        if (a.Flags.HasFlag(CellFlags.Bold) && fg is >= 1 and <= 8) fg += 8;
        var bg = a.Bg;
        if (!a.Flags.HasFlag(CellFlags.Inverse)) return (fg, bg);
        return (bg == 0 ? Attr.Rgb(DefaultBg.R, DefaultBg.G, DefaultBg.B) : bg, fg == 0 ? Attr.Rgb(DefaultFg.R, DefaultFg.G, DefaultFg.B) : fg);
    }

    private IBrush Brush(uint key, bool bg, bool dim = false)
    {
        var cacheKey = key * 4 + (bg ? 1u : 0u) + (dim ? 2u : 0u);
        if (_brushes.TryGetValue(cacheKey, out var b)) return b;
        var color = key == 0 ? (bg ? DefaultBg : DefaultFg)
            : (key & Attr.TrueColor) != 0 ? Color.FromRgb((byte)(key >> 16), (byte)(key >> 8), (byte)key)
            : Palette[(int)key - 1];
        if (dim) color = Color.FromArgb(0x90, color.R, color.G, color.B);
        return _brushes[cacheKey] = new ImmutableSolidColorBrush(color);
    }

    /// <summary>xterm.js's default 16 colours (so both terminals look the same), then the 256 cube.</summary>
    private static Color[] BuildPalette()
    {
        var p = new Color[256];
        string[] ansi = { "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
                          "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec" };
        for (var i = 0; i < 16; i++) p[i] = Color.Parse(ansi[i]);
        int[] steps = { 0, 95, 135, 175, 215, 255 };
        for (var i = 0; i < 216; i++) p[16 + i] = Color.FromRgb((byte)steps[i / 36], (byte)steps[i / 6 % 6], (byte)steps[i % 6]);
        for (var i = 0; i < 24; i++) { var v = (byte)(8 + i * 10); p[232 + i] = Color.FromRgb(v, v, v); }
        return p;
    }

    // ------------------------------------------------------------------- input

    protected override void OnPointerPressed(PointerPressedEventArgs e)
    {
        base.OnPointerPressed(e);
        Focus();
    }

    protected override void OnPointerWheelChanged(PointerWheelEventArgs e)
    {
        base.OnPointerWheelChanged(e);
        if (Session is not { } s) return;
        int max;
        lock (s.Terminal.Sync) max = s.Terminal.ScrollbackCount;
        _scrollOffset = Math.Clamp(_scrollOffset + (int)Math.Round(e.Delta.Y * 3), 0, max);
        InvalidateVisual();
        e.Handled = true;
    }

    protected override void OnGotFocus(FocusChangedEventArgs e) { base.OnGotFocus(e); InvalidateVisual(); }
    protected override void OnLostFocus(FocusChangedEventArgs e) { base.OnLostFocus(e); InvalidateVisual(); }

    protected override void OnTextInput(TextInputEventArgs e)
    {
        base.OnTextInput(e);
        if (string.IsNullOrEmpty(e.Text) || Session is not { } s) return;
        Send(s, e.Text);
        e.Handled = true;
    }

    protected override async void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (Session is not { } s) return;
        var ctrl = e.KeyModifiers.HasFlag(KeyModifiers.Control);
        var shift = e.KeyModifiers.HasFlag(KeyModifiers.Shift);
        var alt = e.KeyModifiers.HasFlag(KeyModifiers.Alt);

        if ((ctrl && e.Key == Key.V) || (shift && e.Key == Key.Insert))
        {
            e.Handled = true;
            await PasteAsync(s);
            return;
        }
        var seq = KeyToSequence(e.Key, ctrl, shift, alt, s.Terminal.AppCursorKeys);
        if (seq == null) return;
        Send(s, seq);
        e.Handled = true; // Tab etc. must not move focus
    }

    /// <summary>Keys that don't arrive as text. Shift+Enter is ESC CR (a newline in Claude's prompt), as in the browser.</summary>
    internal static string? KeyToSequence(Key key, bool ctrl, bool shift, bool alt, bool appCursor)
    {
        var mod = 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
        string Arrow(char c) => mod > 1 ? $"\x1b[1;{mod}{c}" : appCursor ? $"\x1bO{c}" : $"\x1b[{c}";
        string Tilde(int n) => mod > 1 ? $"\x1b[{n};{mod}~" : $"\x1b[{n}~";
        switch (key)
        {
            case Key.Enter: return shift ? "\x1b\r" : alt ? "\x1b\r" : "\r";
            case Key.Back: return ctrl ? "\x08" : alt ? "\x1b\x7f" : "\x7f";
            case Key.Tab: return shift ? "\x1b[Z" : "\t";
            case Key.Escape: return "\x1b";
            case Key.Up: return Arrow('A');
            case Key.Down: return Arrow('B');
            case Key.Right: return Arrow('C');
            case Key.Left: return Arrow('D');
            case Key.Home: return Arrow('H');
            case Key.End: return Arrow('F');
            case Key.Insert: return Tilde(2);
            case Key.Delete: return Tilde(3);
            case Key.PageUp: return Tilde(5);
            case Key.PageDown: return Tilde(6);
            case >= Key.F1 and <= Key.F4: return $"\x1bO{(char)('P' + (key - Key.F1))}";
            case >= Key.F5 and <= Key.F12:
                int[] codes = { 15, 17, 18, 19, 20, 21, 23, 24 };
                return Tilde(codes[key - Key.F5]);
        }
        if (ctrl && !alt && key is >= Key.A and <= Key.Z) return ((char)(key - Key.A + 1)).ToString();
        if (ctrl && key == Key.Space) return "\0";
        if (ctrl && key == Key.OemOpenBrackets) return "\x1b";
        if (alt && !ctrl && key is >= Key.A and <= Key.Z) return "\x1b" + (char)((shift ? 'A' : 'a') + (key - Key.A));
        return null;
    }

    private async Task PasteAsync(TerminalSession s)
    {
        var clipboard = TopLevel.GetTopLevel(this)?.Clipboard;
        if (clipboard == null) return;
        string? text;
        try { text = await clipboard.TryGetTextAsync(); }
        catch { return; }
        if (string.IsNullOrEmpty(text)) return;
        text = text.Replace("\r\n", "\r").Replace('\n', '\r');
        Send(s, s.Terminal.BracketedPaste ? $"\x1b[200~{text}\x1b[201~" : text);
    }

    /// <summary>A keystroke through the same path a real one takes after the key event (the benchmark).</summary>
    internal void SimulateInput(string data)
    {
        if (Session is { } s) Send(s, data);
    }

    /// <summary>True once the session's first screen has been drawn.</summary>
    internal bool HasDrawnReady { get; private set; }

    private void Send(TerminalSession s, string data)
    {
        if (_scrollOffset != 0) { _scrollOffset = 0; InvalidateVisual(); }
        s.Latency.Key();
        s.SendInput(data);
    }
}
