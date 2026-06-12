import { describe, expect, it } from 'vitest';
import {
  highlightBlock,
  highlightToLines,
  resolveHighlightLang,
} from '../../src/web/src/utils/highlight.js';

// Strip hljs `<span>` markup to compare plain text content.
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

describe('highlightToLines', () => {
  it('returns one HTML string per source line', () => {
    const out = highlightToLines('const a = 1;\nconst b = 2;\n', 'javascript');
    // Trailing newline yields a final empty line, like String.split.
    expect(out).toHaveLength(3);
    expect(stripTags(out[0])).toBe('const a = 1;');
    expect(stripTags(out[1])).toBe('const b = 2;');
    expect(stripTags(out[2])).toBe('');
  });

  it('preserves plain text content exactly (escaped) across the split', () => {
    const src = 'a < b && c > d';
    const [line] = highlightToLines(src, 'javascript');
    // The rendered cell must round-trip to the original source text.
    const decoded = stripTags(line)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    expect(decoded).toBe(src);
  });

  it('keeps Razor @code C# context across lines (the per-line gap)', () => {
    const src = [
      '@code {',
      '    private int count;',
      '    protected override async Task OnInit()',
      '}',
    ].join('\n');
    const out = highlightToLines(src, 'cshtml-razor');
    // The standalone C# line (no opener on it) only highlights `private`,
    // `async`, etc. when the @code block state carried over from line 1.
    expect(out[1]).toContain('hljs-keyword');
    expect(out[2]).toContain('hljs-keyword');
  });

  it('re-balances spans that cross a line boundary', () => {
    const src = '@code {\n    var x = 1;\n}';
    for (const line of highlightToLines(src, 'cshtml-razor')) {
      const opens = (line.match(/<span\b/g) ?? []).length;
      const closes = (line.match(/<\/span>/g) ?? []).length;
      expect(opens).toBe(closes); // each emitted line is self-contained HTML
    }
  });

  it('does the same in highlightBlock, normalizing blanks to null', () => {
    const out = highlightBlock(
      ['@code {', '    private int count;', '', '}'],
      'cshtml-razor',
    );
    expect(out).toHaveLength(4);
    expect(out[1]).toContain('hljs-keyword'); // C# context carried over
    expect(out[2]).toBeNull(); // blank line → null (plain-render sentinel)
    expect(highlightBlock([], 'javascript')).toEqual([]);
  });

  it('registers the razor grammar via the language module side-effect', () => {
    expect(resolveHighlightLang('Foo.razor')).toBe('cshtml-razor');
    expect(resolveHighlightLang('Foo.cshtml')).toBe('cshtml-razor');
    expect(resolveHighlightLang('Foo.unknownext')).toBeNull();
  });

  it('highlights .NET/C# project & markup files as XML', () => {
    for (const f of [
      'Strings.resx',
      'MySolution.slnx',
      'MyProject.csproj',
      'Directory.Build.props',
      'Directory.Build.targets',
      'MyPackage.nuspec',
      'MainWindow.xaml',
      'MainWindow.axaml',
      'Resources.resw',
      'web.config',
    ]) {
      expect(resolveHighlightLang(f)).toBe('xml');
    }
  });

  it('highlights C# script files as csharp', () => {
    expect(resolveHighlightLang('build.csx')).toBe('csharp');
  });
});
