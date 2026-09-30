using Avalonia.Input;
using WorkDesktop.Terminal;
using Xunit;

namespace WorkDesktop.Tests;

public class VtTerminalTests
{
    private static VtTerminal Term(int cols = 20, int rows = 5) => new(cols, rows);

    [Fact]
    public void Prints_text_and_moves_to_the_next_line_on_crlf()
    {
        var t = Term();
        t.Feed("hello\r\nworld");
        Assert.Equal(new[] { "hello", "world", "", "", "" }, t.ScreenText());
        Assert.Equal((5, 1), (t.CursorX, t.CursorY));
    }

    [Fact]
    public void Wraps_at_the_last_column_only_when_the_next_character_arrives()
    {
        var t = Term(cols: 5);
        t.Feed("abcde");
        Assert.Equal((4, 0), (t.CursorX, t.CursorY)); // pending wrap: still on row 0
        t.Feed("f");
        Assert.Equal("abcde", t.ScreenText()[0]);
        Assert.Equal("f", t.ScreenText()[1]);
        Assert.True(t.GetLine(0).Wrapped);
    }

    [Fact]
    public void Scrolls_full_screen_output_into_the_scrollback()
    {
        var t = Term(rows: 3);
        t.Feed("1\r\n2\r\n3\r\n4");
        Assert.Equal(new[] { "2", "3", "4" }, t.ScreenText());
        Assert.Equal(1, t.ScrollbackCount);
        Assert.Equal("1", t.GetViewLine(0, 1).ToText());
    }

    [Fact]
    public void Cursor_positioning_and_erasing()
    {
        var t = Term();
        t.Feed("aaaaaaaaaa\r\nbbbbbbbbbb");
        t.Feed("\x1b[1;4H\x1b[K");       // row 1 col 4, erase to end of line
        t.Feed("\x1b[2;3H\x1b[1K");      // row 2 col 3, erase to start
        Assert.Equal("aaa", t.ScreenText()[0]);
        Assert.Equal("   bbbbbbb", t.ScreenText()[1]);
        t.Feed("\x1b[2J");
        Assert.All(t.ScreenText(), l => Assert.Equal("", l));
    }

    [Fact]
    public void Redraws_a_line_in_place_like_a_spinner()
    {
        var t = Term();
        t.Feed("⠋ working\r\n> ");
        t.Feed("\x1b[1A\r\x1b[2K⠙ working");
        Assert.Equal("⠙ working", t.ScreenText()[0]);
        Assert.Equal("> ", t.ScreenText()[1] + " ");
    }

    [Fact]
    public void Sgr_sets_palette_256_and_true_colours_and_resets()
    {
        var t = Term();
        t.Feed("\x1b[1;31ma\x1b[38;5;208mb\x1b[38;2;10;20;30mc\x1b[48:2::1:2:3md\x1b[0me");
        var c = t.GetLine(0).Cells;
        Assert.Equal(Attr.Palette(1), c[0].Attr.Fg);
        Assert.True(c[0].Attr.Flags.HasFlag(CellFlags.Bold));
        Assert.Equal(Attr.Palette(208), c[1].Attr.Fg);
        Assert.Equal(Attr.Rgb(10, 20, 30), c[2].Attr.Fg);
        Assert.Equal(Attr.Rgb(1, 2, 3), c[3].Attr.Bg);
        Assert.Equal(Attr.Default, c[4].Attr);
    }

    [Fact]
    public void Wide_characters_take_two_cells_and_combining_marks_join_the_previous_one()
    {
        var t = Term();
        t.Feed("a✅b");
        var c = t.GetLine(0).Cells;
        Assert.Equal(("✅", (byte)2), (c[1].Text, c[1].Width));
        Assert.Equal((byte)0, c[2].Width);
        Assert.Equal("b", c[3].Text);
        Assert.Equal(4, t.CursorX);

        t.Feed("\r\né");
        Assert.Equal("é", t.GetLine(1).Cells[0].Text);
        Assert.Equal(1, t.CursorX);
    }

    [Fact]
    public void Scroll_region_keeps_lines_outside_it()
    {
        var t = Term(rows: 5);
        t.Feed("top\r\n1\r\n2\r\n3\r\nbottom");
        t.Feed("\x1b[2;4r\x1b[4;1H\n");  // region rows 2–4, LF at its bottom
        Assert.Equal(new[] { "top", "2", "3", "", "bottom" }, t.ScreenText());
        Assert.Equal(0, t.ScrollbackCount);
    }

    [Fact]
    public void Alternate_screen_is_separate_and_restores_the_main_one()
    {
        var t = Term();
        t.Feed("main");
        t.Feed("\x1b[?1049h");
        Assert.True(t.AltScreen);
        t.Feed("\x1b[Halt");
        Assert.Equal("alt", t.ScreenText()[0]);
        t.Feed("\x1b[?1049l");
        Assert.False(t.AltScreen);
        Assert.Equal("main", t.ScreenText()[0]);
        Assert.Equal(4, t.CursorX);
    }

    [Fact]
    public void Answers_cursor_position_reports()
    {
        var t = Term();
        string? reply = null;
        t.Reply = r => reply = r;
        t.Feed("\x1b[3;7H\x1b[6n");
        Assert.Equal("\x1b[3;7R", reply);
    }

    [Fact]
    public void Tracks_modes_Claude_uses()
    {
        var t = Term();
        t.Feed("\x1b[?2004h\x1b[?25l\x1b[?1h");
        Assert.True(t.BracketedPaste);
        Assert.False(t.CursorVisible);
        Assert.True(t.AppCursorKeys);
        t.Feed("\x1b]0;my title\x07x");
        Assert.Equal("my title", t.Title);
        Assert.Equal("x", t.ScreenText()[0]);
    }

    [Fact]
    public void Insert_and_delete_characters_and_lines()
    {
        var t = Term(rows: 4);
        t.Feed("abcdef\x1b[1;3H\x1b[2@");
        Assert.Equal("ab  cdef", t.ScreenText()[0]);
        t.Feed("\x1b[3P");
        Assert.Equal("abdef", t.ScreenText()[0]);
        t.Feed("\r\nline2\r\nline3\x1b[2;1H\x1b[L");
        Assert.Equal(new[] { "abdef", "", "line2", "line3" }, t.ScreenText());
        t.Feed("\x1b[M");
        Assert.Equal(new[] { "abdef", "line2", "line3", "" }, t.ScreenText());
    }

    [Fact]
    public void Resize_keeps_the_cursor_row_on_screen()
    {
        var t = Term(rows: 5);
        t.Feed("1\r\n2\r\n3\r\n4\r\n5");
        t.Resize(10, 3);
        Assert.Equal(new[] { "3", "4", "5" }, t.ScreenText());
        Assert.Equal(2, t.CursorY);
        Assert.Equal(2, t.ScrollbackCount);
    }

    [Theory]
    [InlineData(Key.Enter, false, false, "\r")]
    [InlineData(Key.Enter, false, true, "\x1b\r")]   // Shift+Enter: newline in Claude's prompt
    [InlineData(Key.Back, false, false, "\x7f")]
    [InlineData(Key.C, true, false, "\x03")]
    [InlineData(Key.Tab, false, true, "\x1b[Z")]
    [InlineData(Key.Up, false, false, "\x1b[A")]
    [InlineData(Key.Right, true, false, "\x1b[1;5C")]
    public void Keys_become_terminal_sequences(Key key, bool ctrl, bool shift, string expected) =>
        Assert.Equal(expected, TerminalView.KeyToSequence(key, ctrl, shift, alt: false, appCursor: false));

    [Fact]
    public void Arrows_follow_application_cursor_mode() =>
        Assert.Equal("\x1bOA", TerminalView.KeyToSequence(Key.Up, false, false, false, appCursor: true));
}
