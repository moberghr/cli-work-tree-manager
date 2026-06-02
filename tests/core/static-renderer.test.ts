import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parse as acornParse } from 'acorn';
import {
  escapeForScriptTag,
  renderStatic,
} from '../../src/core/static-renderer.js';
import { resolveWebRoot } from '../../src/core/web-static.js';

let tmpDir: string;
let webDir: string;
let repoDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-static-test-'));

  // Build a synthetic dist/web/ that mirrors what Vite ships, containing
  // the failure-mode strings that broke the inliner: a literal `</head>`
  // and a literal `</script>` inside the JavaScript bundle.
  webDir = path.join(tmpDir, 'dist', 'web');
  fs.mkdirSync(path.join(webDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(webDir, 'assets', 'index-fake.js'),
    // Valid ESM that exercises both adversarial substrings.
    [
      'export const html = "<html><head></head><body></body></html>";',
      'export const closer = "</script>";',
      'window.__bootProbe = typeof window.__WD_BOOT__;',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(webDir, 'assets', 'index-fake.css'),
    'body { color: red; }',
  );
  fs.writeFileSync(
    path.join(webDir, 'index.html'),
    [
      '<!doctype html>',
      '<html><head>',
      '<title>t</title>',
      '<script type="module" crossorigin src="/assets/index-fake.js"></script>',
      '<link rel="stylesheet" crossorigin href="/assets/index-fake.css">',
      '</head><body><div id="root"></div></body></html>',
    ].join('\n'),
  );

  // resolveWebRoot() finds dist/web/ by walking up from the running CLI
  // entrypoint. We force it onto our synthetic dir by pointing process.argv[1]
  // at <tmpDir>/dist/bin.js (which doesn't have to exist).
  const fakeBin = path.join(tmpDir, 'dist', 'bin.js');
  vi.spyOn(process, 'argv', 'get').mockReturnValue([
    process.execPath,
    fakeBin,
  ]);

  // Tiny git working tree so computeDiff has something to read. The repo
  // produces one modified file: README.md.
  repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  const { execSync } = require('node:child_process') as typeof import('node:child_process');
  execSync('git init -q', { cwd: repoDir });
  execSync('git config user.email t@t.t', { cwd: repoDir });
  execSync('git config user.name t', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'original\n');
  execSync('git add . && git commit -q -m init', { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, 'README.md'), 'changed\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function extractFirstModuleScript(html: string): string {
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no module script found');
  return m[1];
}

function extractBootJson(html: string): unknown {
  const m = html.match(/<script>window\.__WD_BOOT__=([\s\S]*?);<\/script>/);
  if (!m) throw new Error('no boot script found');
  return JSON.parse(m[1]);
}

describe('renderStatic', () => {
  it('discovers the synthetic web root', () => {
    // Sanity-check the harness before running the actual renderer.
    expect(resolveWebRoot()).toBe(webDir);
  });

  it('produces HTML whose inlined JS is valid ES module syntax', () => {
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    const body = extractFirstModuleScript(html);
    // This is the regression test for the `</head>` / `</script>` injection
    // bugs — if either escape is missing, acorn throws.
    expect(() =>
      acornParse(body, { ecmaVersion: 'latest', sourceType: 'module' }),
    ).not.toThrow();
  });

  it('inlines the bundle byte-for-byte (modulo the </script escape)', () => {
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    const body = extractFirstModuleScript(html);
    const original = fs.readFileSync(
      path.join(webDir, 'assets', 'index-fake.js'),
      'utf-8',
    );
    // The only difference should be `</script` → `<\/script`. The
    // production code uses /gi so it catches mixed-case variants like
    // </SCRIPT>; the test's un-escape captures the literal case to keep
    // the byte-for-byte comparison honest under any casing.
    expect(body.replace(/<\\\/(script)/gi, '</$1')).toBe(original);
  });

  it('injects boot data with scopeLabel, diff repos, and static flags', () => {
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    const boot = extractBootJson(html) as {
      context: {
        scopeLabel: string;
        staticMode: boolean;
        readOnly: boolean;
        repos: { name: string }[];
      };
      diff: { repos: { name: string; files: { path: string }[] }[] };
    };
    expect(boot.context.scopeLabel).toBe('repo · HEAD');
    expect(boot.context.staticMode).toBe(true);
    expect(boot.context.readOnly).toBe(true);
    expect(boot.context.repos).toEqual([{ name: 'repo' }]);
    expect(boot.diff.repos).toHaveLength(1);
    expect(boot.diff.repos[0].files.some((f) => f.path === 'README.md')).toBe(
      true,
    );
  });

  it('boot script lands outside the bundle, not inside it', () => {
    // The original bug: my <\/head> injection regex matched the first
    // `</head>` in the document, which after inlining was a literal string
    // *inside* the bundle (some HTML template helper in marked / react-dom
    // contains the substring). That spliced JSON into the middle of JS.
    //
    // We can't search for the real document `<body>` with indexOf because
    // the bundle string contains a `<body>` of its own — that's exactly
    // the failure mode this test is guarding against. The right invariant:
    // the boot script must be wholly outside the module-script tag.
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    const bootStart = html.indexOf('<script>window.__WD_BOOT__=');
    expect(bootStart).toBeGreaterThan(0);

    const moduleOpen = html.indexOf('<script type="module">');
    const moduleClose = html.indexOf('</script>', moduleOpen);
    expect(moduleOpen).toBeGreaterThan(0);
    expect(moduleClose).toBeGreaterThan(moduleOpen);
    // Boot tag is before the module script or after it, never inside.
    const insideBundle = bootStart > moduleOpen && bootStart < moduleClose;
    expect(insideBundle).toBe(false);
  });

  it('inlines the stylesheet so the file works offline', () => {
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    expect(html).toContain('<style>body { color: red; }</style>');
    expect(html).not.toMatch(/<link rel="stylesheet"/);
  });

  it('survives adversarial diff content: </script>, <!--, U+2028, U+2029', () => {
    // A real-world bug: a diff that contained `</script>` (or one of the
    // other characters listed in escapeForScriptTag's docstring) inside a
    // file's text would land verbatim in the boot JSON and break the
    // wrapping <script> tag or the JS parse.
    fs.writeFileSync(
      path.join(repoDir, 'README.md'),
      [
        'innocent line',
        '</script>',
        '<!--',
        // U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR.
        // JSON allows them inside strings but legacy JS treats them as
        // line terminators inside string literals.
        'before after',
        'before after',
        '',
      ].join('\n'),
    );
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });

    // Every boot script must parse as JS.
    const boot = html.match(
      /<script>window\.__WD_BOOT__=([\s\S]*?);<\/script>/,
    );
    expect(boot).not.toBeNull();
    expect(() =>
      acornParse(`(${boot![1]})`, { ecmaVersion: 'latest' }),
    ).not.toThrow();

    // The literal `</script` must not appear inside the boot tag — it
    // would close the wrapper.
    const bootBody = boot![1];
    expect(bootBody).not.toMatch(/<\/script/i);

    // And the line separators must be escaped, not raw.
    expect(bootBody).not.toContain(' ');
    expect(bootBody).not.toContain(' ');
    // Parsing the JSON yields the original content back unchanged.
    const parsed = JSON.parse(bootBody) as {
      diff: { repos: { files: { hunks: { lines: { content: string }[] }[] }[] }[] };
    };
    const allContent = parsed.diff.repos
      .flatMap((r) => r.files)
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .map((l) => l.content)
      .join('\n');
    expect(allContent).toContain('</script>');
    expect(allContent).toContain('<!--');
    expect(allContent).toContain(' ');
    expect(allContent).toContain(' ');
  });

  it('escapeForScriptTag re-escapes raw control chars and round-trips', () => {
    // Regression: a real `wd` run on a CI-deploy-logs diff produced a
    // boot JSON with raw LFs mid-string that JSON.parse rejected with
    // "Bad control character in string literal". The upstream cause
    // (something handing JSON.stringify a string masquerading as a
    // pre-built JSON fragment, or a Node oddity we couldn't reproduce
    // synthetically) is unclear — so the renderer defends by re-escaping
    // every raw control char regardless of how it appeared.
    //
    // This test feeds escapeForScriptTag a payload that's already
    // technically invalid JSON (raw LFs inside a string value) and
    // confirms the output is now valid JSON that round-trips.
    const malformed =
      '{"a":"line1\nline2","b":"with\rcr","c":"with\x00nul","d":"with\x0bvt","e":"normal"}';
    const escaped = escapeForScriptTag(malformed);
    expect(escaped).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/);
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\r');
    const parsed = JSON.parse(escaped) as Record<string, string>;
    expect(parsed.a).toBe('line1\nline2');
    expect(parsed.b).toBe('with\rcr');
    expect(parsed.c).toBe('with\x00nul');
    expect(parsed.d).toBe('with\x0bvt');
    expect(parsed.e).toBe('normal');
  });

  it('escapeForScriptTag still escapes </script, <!--, U+2028, U+2029', () => {
    const malformed =
      '{"x":"a</script>b<!--c","y":"line sep end"}';
    const escaped = escapeForScriptTag(malformed);
    expect(escaped).not.toMatch(/<\/script/i);
    expect(escaped).not.toContain('<!--');
    expect(escaped).not.toContain(' ');
    expect(escaped).not.toContain(' ');
    const parsed = JSON.parse(escaped) as Record<string, string>;
    expect(parsed.x).toBe('a</script>b<!--c');
    expect(parsed.y).toBe('line sep end');
  });

  it('boot JSON containing $\' is not corrupted by replace() $-magic', () => {
    // Regression: String.replace(regex, replacementString) treats `$'` in
    // the replacement as "substring after the match". Diff content that
    // contains `$'` (e.g. a shell regex like `'^(None)?$'`) used to splice
    // the SPA's body content into the middle of the boot JSON.
    fs.writeFileSync(
      path.join(repoDir, 'deploy.sh'),
      [
        '#!/bin/bash',
        // The minimum byte-sequence that triggered the bug.
        "task_arns=$(grep -vE '^(None)?$' | sort -u)",
        '',
      ].join('\n'),
    );
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    const boot = html.match(
      /<script>window\.__WD_BOOT__=([\s\S]*?);<\/script>/,
    );
    expect(boot).not.toBeNull();
    // Must be valid strict JSON — the bug produced unbalanced strings.
    const parsed = JSON.parse(boot![1]) as {
      diff: { repos: { files: { hunks: { lines: { content: string }[] }[] }[] }[] };
    };
    const allContent = parsed.diff.repos
      .flatMap((r) => r.files)
      .flatMap((f) => f.hunks)
      .flatMap((h) => h.lines)
      .map((l) => l.content)
      .join('\n');
    // The shell regex must survive intact — and nothing from the SPA's
    // shell (`<body>`, `<div id="root">`) must leak into it.
    expect(allContent).toContain("'^(None)?$'");
    expect(allContent).not.toContain('<body>');
    expect(allContent).not.toContain('<div id="root">');
  });

  it('does not leave any <script src=> references behind', () => {
    const html = renderStatic({ scopeLabel: 'repo · HEAD', uncommitted: [{ name: 'repo', root: repoDir, diffArg: 'HEAD' }] });
    // Static files break over file:// when they try to fetch sibling assets.
    expect(html).not.toMatch(/<script[^>]*\bsrc=/);
  });
});
