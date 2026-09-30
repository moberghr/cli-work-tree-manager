using System.Text;

namespace WorkDesktop.Terminal;

/// <summary>
/// A VT/xterm screen: parser + grid + scrollback. Covers what Claude Code's UI (Ink) and the PTY
/// host's replay snapshot use: cursor movement, erase, insert/delete, scroll regions, SGR with
/// 16/256/true colour, the alternate screen, bracketed paste, application cursor keys, DSR/DA
/// replies, OSC titles, and wide characters. Not covered: mouse reporting, charsets, sixel.
/// <para>
/// Not thread-safe: callers hold <see cref="Sync"/> around <see cref="Feed"/>, <see cref="Resize"/>
/// and any read. The connection feeds it on its socket thread; the view reads it while rendering.
/// </para>
/// </summary>
public sealed class VtTerminal
{
    public const int MaxScrollback = 5000;

    public object Sync { get; } = new();
    public int Cols { get; private set; }
    public int Rows { get; private set; }
    public int CursorX { get; private set; }
    public int CursorY { get; private set; }
    public bool CursorVisible { get; private set; } = true;
    public bool AppCursorKeys { get; private set; }
    public bool BracketedPaste { get; private set; }
    public bool AltScreen { get; private set; }
    public string Title { get; private set; } = "";
    /// <summary>Bumped on every change: a cheap "anything new?" for the view.</summary>
    public int Version { get; private set; }

    /// <summary>Bytes the terminal answers with (DSR, DA): send them back as input.</summary>
    public Action<string>? Reply { get; set; }

    private Line[] _main;
    private Line[]? _alt;
    private readonly List<Line> _scrollback = new();
    private Attr _attr = Attr.Default;
    private bool _wrapPending;
    private bool _autoWrap = true;
    private int _top, _bottom;
    private (int X, int Y, Attr Attr) _saved, _savedMain;
    private string? _lastPrinted;

    // Parser state.
    private enum State { Ground, Esc, EscInter, Csi, Osc, OscEsc, Str, StrEsc }
    private State _state = State.Ground;
    private readonly List<int> _params = new();
    private readonly List<bool> _colon = new();
    private int _cur = -1;
    private bool _curColon;
    private char _private;
    private readonly StringBuilder _inter = new();
    private readonly StringBuilder _osc = new();
    private char _highSurrogate;

    public VtTerminal(int cols, int rows)
    {
        Cols = Math.Max(1, cols);
        Rows = Math.Max(1, rows);
        _main = NewScreen();
        _bottom = Rows - 1;
    }

    private Line[] Screen => AltScreen ? _alt! : _main;
    public int ScrollbackCount => _scrollback.Count;

    /// <summary>Row <paramref name="row"/> of the view scrolled <paramref name="offset"/> lines into the scrollback.</summary>
    public Line GetViewLine(int row, int offset)
    {
        if (AltScreen || offset <= 0) return Screen[row];
        var fromTop = _scrollback.Count - offset + row;
        return fromTop < _scrollback.Count ? _scrollback[Math.Max(0, fromTop)] : Screen[fromTop - _scrollback.Count];
    }

    public Line GetLine(int row) => Screen[row];

    private Line[] NewScreen()
    {
        var s = new Line[Rows];
        for (var i = 0; i < Rows; i++) s[i] = new Line(Cols, Attr.Default);
        return s;
    }

    // ---------------------------------------------------------------- input

    public void Feed(string data)
    {
        foreach (var ch in data) Step(ch);
        Version++;
    }

    private void Step(char ch)
    {
        switch (_state)
        {
            case State.Ground:
                if (ch == '\x1b') { _state = State.Esc; return; }
                if (ch < 0x20) { Execute(ch); return; }
                if (ch == 0x7F) return;
                if (char.IsHighSurrogate(ch)) { _highSurrogate = ch; return; }
                if (char.IsLowSurrogate(ch) && _highSurrogate != 0)
                {
                    var s = new string(new[] { _highSurrogate, ch });
                    _highSurrogate = '\0';
                    Print(s, char.ConvertToUtf32(s, 0));
                    return;
                }
                _highSurrogate = '\0';
                Print(Interned(ch), ch);
                return;

            case State.Esc:
                switch (ch)
                {
                    case '[':
                        _params.Clear(); _colon.Clear(); _cur = -1; _curColon = false; _private = '\0'; _inter.Clear();
                        _state = State.Csi;
                        return;
                    case ']': _osc.Clear(); _state = State.Osc; return;
                    case 'P' or 'X' or '^' or '_': _state = State.Str; return;
                    case >= ' ' and <= '/': _inter.Clear(); _inter.Append(ch); _state = State.EscInter; return;
                }
                EscDispatch(ch);
                _state = State.Ground;
                return;

            case State.EscInter:
                if (ch is >= ' ' and <= '/') { _inter.Append(ch); return; }
                _state = State.Ground; // charset designations etc.: ignored
                return;

            case State.Csi:
                if (ch is >= '0' and <= '9') { _cur = (_cur < 0 ? 0 : _cur) * 10 + (ch - '0'); if (_cur > 99999) _cur = 99999; return; }
                if (ch == ';' || ch == ':') { PushParam(); _curColon = ch == ':'; return; }
                if (ch is '?' or '>' or '=' or '<') { _private = ch; return; }
                if (ch is >= ' ' and <= '/') { _inter.Append(ch); return; }
                if (ch is >= '@' and <= '~') { PushParam(); _state = State.Ground; CsiDispatch(ch); return; }
                if (ch == '\x1b') { _state = State.Esc; return; }
                if (ch < 0x20) Execute(ch);
                return;

            case State.Osc:
                if (ch == '\x07') { OscDispatch(); _state = State.Ground; return; }
                if (ch == '\x1b') { _state = State.OscEsc; return; }
                if (_osc.Length < 4096) _osc.Append(ch);
                return;

            case State.OscEsc:
                OscDispatch();
                _state = State.Ground;
                if (ch != '\\') Step('\x1b'); // not ST: treat as a fresh escape
                if (ch != '\\') Step(ch);
                return;

            case State.Str:
                if (ch == '\x1b') _state = State.StrEsc;
                else if (ch == '\x07') _state = State.Ground;
                return;

            case State.StrEsc:
                _state = ch == '\\' ? State.Ground : State.Str;
                return;
        }
    }

    private static readonly string[] Ascii = Enumerable.Range(0, 128).Select(i => ((char)i).ToString()).ToArray();
    private static string Interned(char ch) => ch < 128 ? Ascii[ch] : ch.ToString();

    private void PushParam()
    {
        _params.Add(_cur);
        _colon.Add(_curColon);
        _cur = -1;
        _curColon = false;
    }

    private int P(int i, int dflt) => i < _params.Count && _params[i] > 0 ? _params[i] : dflt;
    private int P0(int i) => i < _params.Count && _params[i] >= 0 ? _params[i] : 0;

    // ------------------------------------------------------------- C0 / ESC

    private void Execute(char ch)
    {
        switch (ch)
        {
            case '\b': if (CursorX > 0) CursorX--; _wrapPending = false; break;
            case '\t': CursorX = Math.Min(Cols - 1, (CursorX / 8 + 1) * 8); _wrapPending = false; break;
            case '\n' or '\v' or '\f': LineFeed(); break;
            case '\r': CursorX = 0; _wrapPending = false; break;
        }
    }

    private void EscDispatch(char ch)
    {
        switch (ch)
        {
            case '7': _saved = (CursorX, CursorY, _attr); break;
            case '8': RestoreCursor(_saved); break;
            case 'D': LineFeed(); break;
            case 'E': CursorX = 0; LineFeed(); break;
            case 'M': ReverseIndex(); break;
            case 'c': FullReset(); break;
        }
    }

    private void OscDispatch()
    {
        var s = _osc.ToString();
        var semi = s.IndexOf(';');
        if (semi < 0) return;
        if (s[..semi] is "0" or "2") Title = s[(semi + 1)..];
    }

    // ------------------------------------------------------------------ CSI

    private void CsiDispatch(char final)
    {
        if (_inter.Length > 0)
        {
            if (_inter.ToString() == "!" && final == 'p') SoftReset();
            return; // cursor style (SP q), DECRQM ($p), … : ignored
        }
        if (_private == '?')
        {
            if (final is 'h' or 'l') foreach (var m in _params) SetPrivateMode(m, final == 'h');
            return;
        }
        if (_private == '>')
        {
            if (final == 'c') Reply?.Invoke("\x1b[>0;276;0c");
            return; // modifyOtherKeys (>m) etc.
        }
        if (_private != '\0') return;

        switch (final)
        {
            case '@': InsertChars(P(0, 1)); break;
            case 'A': MoveTo(CursorX, Math.Max(CursorY >= _top ? _top : 0, CursorY - P(0, 1))); break;
            case 'B' or 'e': MoveTo(CursorX, Math.Min(CursorY <= _bottom ? _bottom : Rows - 1, CursorY + P(0, 1))); break;
            case 'C' or 'a': MoveTo(CursorX + P(0, 1), CursorY); break;
            case 'D': MoveTo(CursorX - P(0, 1), CursorY); break;
            case 'E': MoveTo(0, Math.Min(_bottom, CursorY + P(0, 1))); break;
            case 'F': MoveTo(0, Math.Max(_top, CursorY - P(0, 1))); break;
            case 'G' or '`': MoveTo(P(0, 1) - 1, CursorY); break;
            case 'H' or 'f': MoveTo(P(1, 1) - 1, P(0, 1) - 1); break;
            case 'd': MoveTo(CursorX, P(0, 1) - 1); break;
            case 'J': EraseDisplay(P0(0)); break;
            case 'K': EraseLine(P0(0)); break;
            case 'L': InsertLines(P(0, 1)); break;
            case 'M': DeleteLines(P(0, 1)); break;
            case 'P': DeleteChars(P(0, 1)); break;
            case 'X': EraseChars(P(0, 1)); break;
            case 'S': ScrollUp(P(0, 1)); break;
            case 'T': if (_params.Count <= 1) ScrollDown(P(0, 1)); break;
            case 'b': if (_lastPrinted != null) for (var i = Math.Min(P(0, 1), Cols * Rows); i > 0; i--) Print(_lastPrinted, char.ConvertToUtf32(_lastPrinted, 0)); break;
            case 'm': Sgr(); break;
            case 'r':
                {
                    var top = P(0, 1) - 1;
                    var bottom = P(1, Rows) - 1;
                    if (top < bottom && bottom < Rows) { _top = top; _bottom = bottom; MoveTo(0, 0); }
                    break;
                }
            case 's': _saved = (CursorX, CursorY, _attr); break;
            case 'u': RestoreCursor(_saved); break;
            case 'n':
                if (P0(0) == 5) Reply?.Invoke("\x1b[0n");
                else if (P0(0) == 6) Reply?.Invoke($"\x1b[{CursorY + 1};{CursorX + 1}R");
                break;
            case 'c': if (P0(0) == 0) Reply?.Invoke("\x1b[?1;2c"); break;
        }
    }

    private void SetPrivateMode(int mode, bool on)
    {
        switch (mode)
        {
            case 1: AppCursorKeys = on; break;
            case 7: _autoWrap = on; break;
            case 25: CursorVisible = on; break;
            case 2004: BracketedPaste = on; break;
            case 47 or 1047: SwitchScreen(on, saveCursor: false); break;
            case 1049: SwitchScreen(on, saveCursor: true); break;
        }
    }

    private void SwitchScreen(bool alt, bool saveCursor)
    {
        if (alt == AltScreen) return;
        if (alt)
        {
            if (saveCursor) _savedMain = (CursorX, CursorY, _attr);
            _alt = NewScreen();
            AltScreen = true;
        }
        else
        {
            AltScreen = false;
            _alt = null;
            if (saveCursor) RestoreCursor(_savedMain);
        }
        foreach (var l in Screen) l.Touch();
    }

    private void Sgr()
    {
        if (_params.Count == 0) { _attr = Attr.Default; return; }
        for (var i = 0; i < _params.Count; i++)
        {
            var p = Math.Max(0, _params[i]);
            var f = _attr.Flags;
            switch (p)
            {
                case 0: _attr = Attr.Default; continue;
                case 1: f |= CellFlags.Bold; break;
                case 2: f |= CellFlags.Dim; break;
                case 3: f |= CellFlags.Italic; break;
                case 4: f = SubParam(i) == 0 ? f & ~CellFlags.Underline : f | CellFlags.Underline; SkipColonGroup(ref i); break;
                case 7: f |= CellFlags.Inverse; break;
                case 8: f |= CellFlags.Hidden; break;
                case 9: f |= CellFlags.Strike; break;
                case 21: f |= CellFlags.Underline; break;
                case 22: f &= ~(CellFlags.Bold | CellFlags.Dim); break;
                case 23: f &= ~CellFlags.Italic; break;
                case 24: f &= ~CellFlags.Underline; break;
                case 27: f &= ~CellFlags.Inverse; break;
                case 28: f &= ~CellFlags.Hidden; break;
                case 29: f &= ~CellFlags.Strike; break;
                case >= 30 and <= 37: _attr = _attr with { Fg = Attr.Palette(p - 30) }; continue;
                case 38: _attr = _attr with { Fg = ExtendedColor(ref i) ?? _attr.Fg }; continue;
                case 39: _attr = _attr with { Fg = 0 }; continue;
                case >= 40 and <= 47: _attr = _attr with { Bg = Attr.Palette(p - 40) }; continue;
                case 48: _attr = _attr with { Bg = ExtendedColor(ref i) ?? _attr.Bg }; continue;
                case 49: _attr = _attr with { Bg = 0 }; continue;
                case 58: ExtendedColor(ref i); continue; // underline colour: consumed, not drawn
                case >= 90 and <= 97: _attr = _attr with { Fg = Attr.Palette(p - 90 + 8) }; continue;
                case >= 100 and <= 107: _attr = _attr with { Bg = Attr.Palette(p - 100 + 8) }; continue;
                default: continue;
            }
            _attr = _attr with { Flags = f };
        }
    }

    private int SubParam(int i) => i + 1 < _params.Count && _colon[i + 1] ? Math.Max(0, _params[i + 1]) : 1;

    private void SkipColonGroup(ref int i)
    {
        while (i + 1 < _params.Count && _colon[i + 1]) i++;
    }

    /// <summary>38/48/58 ;5;n | ;2;r;g;b | :5:n | :2:[cs]:r:g:b</summary>
    private uint? ExtendedColor(ref int i)
    {
        if (i + 1 < _params.Count && _colon[i + 1])
        {
            var group = new List<int>();
            while (i + 1 < _params.Count && _colon[i + 1]) group.Add(Math.Max(0, _params[++i]));
            if (group.Count >= 2 && group[0] == 5) return Attr.Palette(Math.Clamp(group[1], 0, 255));
            if (group.Count >= 4 && group[0] == 2)
            {
                var o = group.Count >= 5 ? 2 : 1; // with or without the colour-space id
                return Attr.Rgb(group[o], group[o + 1], group[o + 2]);
            }
            return null;
        }
        if (i + 2 < _params.Count && _params[i + 1] == 5)
        {
            var n = Math.Clamp(_params[i + 2], 0, 255);
            i += 2;
            return Attr.Palette(n);
        }
        if (i + 4 < _params.Count && _params[i + 1] == 2)
        {
            var c = Attr.Rgb(Math.Max(0, _params[i + 2]), Math.Max(0, _params[i + 3]), Math.Max(0, _params[i + 4]));
            i += 4;
            return c;
        }
        return null;
    }

    // ---------------------------------------------------------------- grid ops

    private void Print(string g, int cp)
    {
        if (CharWidth.IsCombining(cp) || (_lastPrinted != null && _lastPrinted.EndsWith('‍')))
        {
            AppendToPrevious(g);
            return;
        }
        var width = CharWidth.IsWide(cp) ? 2 : 1;
        if (_wrapPending && _autoWrap)
        {
            Screen[CursorY].Wrapped = true;
            CursorX = 0;
            LineFeed();
        }
        _wrapPending = false;
        if (width == 2 && CursorX == Cols - 1)
        {
            if (!_autoWrap) return;
            PutCell(CursorX, new Cell { Text = null, Attr = _attr, Width = 1 });
            Screen[CursorY].Wrapped = true;
            CursorX = 0;
            LineFeed();
        }
        PutCell(CursorX, new Cell { Text = g, Attr = _attr, Width = (byte)width });
        if (width == 2) PutCell(CursorX + 1, new Cell { Text = null, Attr = _attr, Width = 0 });
        _lastPrinted = g;
        CursorX += width;
        if (CursorX >= Cols)
        {
            CursorX = Cols - 1;
            _wrapPending = true;
        }
    }

    /// <summary>Writes one cell, blanking the other half of any wide character it overlaps.</summary>
    private void PutCell(int x, Cell cell)
    {
        if (x < 0 || x >= Cols) return;
        var line = Screen[CursorY];
        var cells = line.Cells;
        if (cells[x].Width == 0 && x > 0 && cell.Width != 0) cells[x - 1] = Cell.Blank(cells[x - 1].Attr);
        if (cells[x].Width == 2 && cell.Width != 2 && x + 1 < Cols) cells[x + 1] = Cell.Blank(cells[x + 1].Attr);
        cells[x] = cell;
        line.Touch();
    }

    private void AppendToPrevious(string g)
    {
        var line = Screen[CursorY];
        var x = _wrapPending ? CursorX : CursorX - 1;
        if (x >= 0 && line.Cells[x].Width == 0 && x > 0) x--;
        if (x < 0 || line.Cells[x].Text == null) return;
        line.Cells[x].Text += g;
        _lastPrinted = line.Cells[x].Text;
        line.Touch();
    }

    private void MoveTo(int x, int y)
    {
        CursorX = Math.Clamp(x, 0, Cols - 1);
        CursorY = Math.Clamp(y, 0, Rows - 1);
        _wrapPending = false;
    }

    private void RestoreCursor((int X, int Y, Attr Attr) s)
    {
        _attr = s.Attr;
        MoveTo(s.X, s.Y);
    }

    private void LineFeed()
    {
        _wrapPending = false;
        if (CursorY == _bottom) ScrollUp(1);
        else if (CursorY < Rows - 1) CursorY++;
    }

    private void ReverseIndex()
    {
        _wrapPending = false;
        if (CursorY == _top) ScrollDown(1);
        else if (CursorY > 0) CursorY--;
    }

    private Line BlankLine() => new(Cols, _attr);

    private void ScrollUp(int n)
    {
        var s = Screen;
        n = Math.Min(n, _bottom - _top + 1);
        for (var k = 0; k < n; k++)
        {
            var gone = s[_top];
            if (!AltScreen && _top == 0)
            {
                _scrollback.Add(gone);
                if (_scrollback.Count > MaxScrollback) _scrollback.RemoveRange(0, _scrollback.Count - MaxScrollback);
            }
            Array.Copy(s, _top + 1, s, _top, _bottom - _top);
            s[_bottom] = BlankLine();
        }
    }

    private void ScrollDown(int n)
    {
        var s = Screen;
        n = Math.Min(n, _bottom - _top + 1);
        for (var k = 0; k < n; k++)
        {
            Array.Copy(s, _top, s, _top + 1, _bottom - _top);
            s[_top] = BlankLine();
        }
    }

    private void InsertLines(int n)
    {
        if (CursorY < _top || CursorY > _bottom) return;
        var s = Screen;
        n = Math.Min(n, _bottom - CursorY + 1);
        for (var k = 0; k < n; k++)
        {
            Array.Copy(s, CursorY, s, CursorY + 1, _bottom - CursorY);
            s[CursorY] = BlankLine();
        }
        CursorX = 0;
        _wrapPending = false;
    }

    private void DeleteLines(int n)
    {
        if (CursorY < _top || CursorY > _bottom) return;
        var s = Screen;
        n = Math.Min(n, _bottom - CursorY + 1);
        for (var k = 0; k < n; k++)
        {
            Array.Copy(s, CursorY + 1, s, CursorY, _bottom - CursorY);
            s[_bottom] = BlankLine();
        }
        CursorX = 0;
        _wrapPending = false;
    }

    private void InsertChars(int n)
    {
        var line = Screen[CursorY];
        var c = line.Cells;
        n = Math.Min(n, Cols - CursorX);
        Array.Copy(c, CursorX, c, CursorX + n, Cols - CursorX - n);
        for (var x = CursorX; x < CursorX + n; x++) c[x] = Cell.Blank(_attr);
        line.Touch();
        _wrapPending = false;
    }

    private void DeleteChars(int n)
    {
        var line = Screen[CursorY];
        var c = line.Cells;
        n = Math.Min(n, Cols - CursorX);
        Array.Copy(c, CursorX + n, c, CursorX, Cols - CursorX - n);
        for (var x = Cols - n; x < Cols; x++) c[x] = Cell.Blank(_attr);
        line.Touch();
        _wrapPending = false;
    }

    private void EraseChars(int n) => Fill(CursorY, CursorX, Math.Min(Cols, CursorX + n));

    private void Fill(int row, int from, int to)
    {
        var line = Screen[row];
        for (var x = Math.Max(0, from); x < Math.Min(Cols, to); x++) line.Cells[x] = Cell.Blank(_attr);
        if (to >= Cols) line.Wrapped = false;
        line.Touch();
    }

    private void EraseLine(int mode)
    {
        switch (mode)
        {
            case 0: Fill(CursorY, CursorX, Cols); break;
            case 1: Fill(CursorY, 0, CursorX + 1); break;
            case 2: Fill(CursorY, 0, Cols); break;
        }
        _wrapPending = false;
    }

    private void EraseDisplay(int mode)
    {
        switch (mode)
        {
            case 0:
                Fill(CursorY, CursorX, Cols);
                for (var y = CursorY + 1; y < Rows; y++) Fill(y, 0, Cols);
                break;
            case 1:
                for (var y = 0; y < CursorY; y++) Fill(y, 0, Cols);
                Fill(CursorY, 0, CursorX + 1);
                break;
            case 2:
                for (var y = 0; y < Rows; y++) Fill(y, 0, Cols);
                break;
            case 3:
                _scrollback.Clear();
                break;
        }
        _wrapPending = false;
    }

    private void SoftReset()
    {
        _attr = Attr.Default;
        _top = 0;
        _bottom = Rows - 1;
        CursorVisible = true;
        AppCursorKeys = false;
        _autoWrap = true;
        _wrapPending = false;
    }

    private void FullReset()
    {
        SoftReset();
        if (AltScreen) SwitchScreen(false, saveCursor: false);
        _main = NewScreen();
        _scrollback.Clear();
        BracketedPaste = false;
        MoveTo(0, 0);
    }

    // ----------------------------------------------------------------- resize

    /// <summary>
    /// New grid size. Rows that no longer fit above the cursor go to the scrollback; columns are
    /// cut or padded (no reflow: Claude redraws its UI on the resize anyway).
    /// </summary>
    public void Resize(int cols, int rows)
    {
        cols = Math.Max(1, cols);
        rows = Math.Max(1, rows);
        if (cols == Cols && rows == Rows) return;
        _main = ResizeScreen(_main, cols, rows, keepInScrollback: true, ref _savedMain);
        if (_alt != null)
        {
            var none = (0, 0, Attr.Default);
            _alt = ResizeScreen(_alt, cols, rows, keepInScrollback: false, ref none);
        }
        var cursorShift = Math.Max(0, CursorY + 1 - rows);
        Cols = cols;
        Rows = rows;
        _top = 0;
        _bottom = rows - 1;
        MoveTo(CursorX, CursorY - cursorShift);
        Version++;
    }

    private Line[] ResizeScreen(Line[] old, int cols, int rows, bool keepInScrollback, ref (int X, int Y, Attr Attr) saved)
    {
        var drop = Math.Max(0, CursorY + 1 - rows);
        if (keepInScrollback && !AltScreen)
            for (var i = 0; i < drop; i++) _scrollback.Add(old[i]);
        var next = new Line[rows];
        for (var y = 0; y < rows; y++)
        {
            var src = y + drop;
            var line = src < old.Length ? old[src] : new Line(cols, Attr.Default);
            if (line.Cells.Length != cols)
            {
                var cells = new Cell[cols];
                var keep = Math.Min(cols, line.Cells.Length);
                Array.Copy(line.Cells, cells, keep);
                for (var x = keep; x < cols; x++) cells[x] = Cell.Blank(Attr.Default);
                if (keep > 0 && cells[keep - 1].Width == 2) cells[keep - 1] = Cell.Blank(cells[keep - 1].Attr);
                line.Cells = cells;
            }
            line.Touch();
            next[y] = line;
        }
        saved = (Math.Min(saved.X, cols - 1), Math.Clamp(saved.Y - drop, 0, rows - 1), saved.Attr);
        return next;
    }

    /// <summary>The visible screen as text, one string per row (tests, debugging).</summary>
    public string[] ScreenText() => Screen.Select(l => l.ToText()).ToArray();

    public override string ToString() => string.Join('\n', ScreenText()).TrimEnd();
}
