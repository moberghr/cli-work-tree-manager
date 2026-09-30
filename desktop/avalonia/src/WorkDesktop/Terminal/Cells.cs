namespace WorkDesktop.Terminal;

[Flags]
public enum CellFlags : ushort
{
    None = 0,
    Bold = 1,
    Dim = 2,
    Italic = 4,
    Underline = 8,
    Inverse = 16,
    Hidden = 32,
    Strike = 64,
}

/// <summary>
/// A cell's colours and style. Colours: 0 = the default, 1..256 = palette index + 1,
/// <see cref="TrueColor"/> | 0xRRGGBB = a 24-bit colour.
/// </summary>
public readonly record struct Attr(uint Fg, uint Bg, CellFlags Flags)
{
    public const uint TrueColor = 0x0100_0000;
    public static readonly Attr Default = new(0, 0, CellFlags.None);

    public static uint Palette(int index) => (uint)index + 1;
    public static uint Rgb(int r, int g, int b) => TrueColor | ((uint)(r & 0xFF) << 16) | ((uint)(g & 0xFF) << 8) | (uint)(b & 0xFF);
}

/// <summary>
/// One grid cell. <see cref="Text"/> is the grapheme drawn there (null = blank);
/// <see cref="Width"/> is 1, 2 for the left half of a wide character, 0 for its right half.
/// </summary>
public struct Cell
{
    public string? Text;
    public Attr Attr;
    public byte Width;

    public static Cell Blank(Attr attr) => new() { Text = null, Attr = attr with { Flags = CellFlags.None }, Width = 1 };
}

/// <summary>A row of the grid. <see cref="Version"/> changes whenever a cell does, so a renderer can cache per row.</summary>
public sealed class Line
{
    public Cell[] Cells;
    public bool Wrapped;
    public int Version;

    public Line(int cols, Attr fill)
    {
        Cells = new Cell[cols];
        Array.Fill(Cells, Cell.Blank(fill));
    }

    public void Touch() => Version++;

    public string ToText()
    {
        var sb = new System.Text.StringBuilder(Cells.Length);
        foreach (var c in Cells)
        {
            if (c.Width == 0) continue;
            sb.Append(c.Text ?? " ");
        }
        return sb.ToString().TrimEnd();
    }
}

internal static class CharWidth
{
    /// <summary>
    /// Combining marks, joiners and variation selectors: drawn with the previous character.
    /// </summary>
    public static bool IsCombining(int cp) =>
        cp is (>= 0x0300 and <= 0x036F) or (>= 0x1AB0 and <= 0x1AFF) or (>= 0x1DC0 and <= 0x1DFF)
            or (>= 0x20D0 and <= 0x20FF) or 0x200D or (>= 0xFE00 and <= 0xFE0F) or (>= 0xFE20 and <= 0xFE2F)
            or (>= 0x1F3FB and <= 0x1F3FF) or (>= 0xE0020 and <= 0xE007F);

    /// <summary>
    /// East Asian Wide/Fullwidth and emoji presentation, roughly Unicode 11's table (what the
    /// browser terminal uses via xterm's unicode11 addon, so both agree on where columns fall).
    /// </summary>
    public static bool IsWide(int cp) =>
        cp is (>= 0x1100 and <= 0x115F) or 0x231A or 0x231B or 0x2329 or 0x232A or (>= 0x23E9 and <= 0x23EC)
            or 0x23F0 or 0x23F3 or 0x25FD or 0x25FE or 0x2614 or 0x2615 or (>= 0x2648 and <= 0x2653)
            or 0x267F or 0x2693 or 0x26A1 or 0x26AA or 0x26AB or 0x26BD or 0x26BE or 0x26C4 or 0x26C5
            or 0x26CE or 0x26D4 or 0x26EA or 0x26F2 or 0x26F3 or 0x26F5 or 0x26FA or 0x26FD or 0x2705
            or 0x270A or 0x270B or 0x2728 or 0x274C or 0x274E or (>= 0x2753 and <= 0x2755) or 0x2757
            or (>= 0x2795 and <= 0x2797) or 0x27B0 or 0x27BF or 0x2B1B or 0x2B1C or 0x2B50 or 0x2B55
            or (>= 0x2E80 and <= 0x303E) or (>= 0x3041 and <= 0x33FF) or (>= 0x3400 and <= 0x4DBF)
            or (>= 0x4E00 and <= 0x9FFF) or (>= 0xA000 and <= 0xA4CF) or (>= 0xA960 and <= 0xA97F)
            or (>= 0xAC00 and <= 0xD7A3) or (>= 0xF900 and <= 0xFAFF) or (>= 0xFE10 and <= 0xFE19)
            or (>= 0xFE30 and <= 0xFE6F) or (>= 0xFF00 and <= 0xFF60) or (>= 0xFFE0 and <= 0xFFE6)
            or (>= 0x16FE0 and <= 0x18AFF) or (>= 0x1B000 and <= 0x1B2FF) or 0x1F004 or 0x1F0CF or 0x1F18E
            or (>= 0x1F191 and <= 0x1F19A) or (>= 0x1F200 and <= 0x1F251) or (>= 0x1F300 and <= 0x1F320)
            or (>= 0x1F32D and <= 0x1F335) or (>= 0x1F337 and <= 0x1F37C) or (>= 0x1F37E and <= 0x1F393)
            or (>= 0x1F3A0 and <= 0x1F3CA) or (>= 0x1F3CF and <= 0x1F3D3) or (>= 0x1F3E0 and <= 0x1F3F0)
            or 0x1F3F4 or (>= 0x1F3F8 and <= 0x1F43E) or 0x1F440 or (>= 0x1F442 and <= 0x1F4FC)
            or (>= 0x1F4FF and <= 0x1F53D) or (>= 0x1F54B and <= 0x1F54E) or (>= 0x1F550 and <= 0x1F567)
            or 0x1F57A or 0x1F595 or 0x1F596 or 0x1F5A4 or (>= 0x1F5FB and <= 0x1F64F)
            or (>= 0x1F680 and <= 0x1F6C5) or 0x1F6CC or (>= 0x1F6D0 and <= 0x1F6D2) or (>= 0x1F6D5 and <= 0x1F6D7)
            or (>= 0x1F6EB and <= 0x1F6EC) or (>= 0x1F6F4 and <= 0x1F6FC) or (>= 0x1F7E0 and <= 0x1F7EB)
            or (>= 0x1F90C and <= 0x1F93A) or (>= 0x1F93C and <= 0x1F945) or (>= 0x1F947 and <= 0x1F9FF)
            or (>= 0x1FA70 and <= 0x1FAFF) or (>= 0x20000 and <= 0x3FFFD);
}
