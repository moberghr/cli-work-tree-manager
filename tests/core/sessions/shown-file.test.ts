import { describe, expect, it } from 'vitest';
import { createShownFiles, imageType, locateInSession, shownKind } from '../../../src/core/sessions/shown-file.js';

/** A file a session shows beside its terminal (asked for: a spec to approve had to be read in another tab). */
describe('shownKind', () => {
  it('Markdown is rendered, an image is drawn, the rest is text; an SVG is text (it could carry a script)', () => {
    expect(shownKind('docs/specs/2026-11-18-thing.md')).toBe('markdown');
    expect(shownKind('README.MARKDOWN')).toBe('markdown');
    expect(shownKind('shot.PNG')).toBe('image');
    expect(shownKind('a/b/photo.jpeg')).toBe('image');
    expect(shownKind('logo.svg')).toBe('text');
    expect(shownKind('src/app.ts')).toBe('text');
    expect(shownKind('Makefile')).toBe('text');
    expect(imageType('shot.png')).toBe('image/png');
    expect(imageType('a.jpg')).toBe('image/jpeg');
    expect(imageType('logo.svg')).toBeNull();
    expect(imageType('notes.md')).toBeNull();
  });
});

describe('locateInSession', () => {
  const single = { paths: ['/wt/api'], isGroup: false };
  const group = { paths: ['/wt/feat-x/api', '/wt/feat-x/web'], isGroup: true };

  it('a file in one of its repos: the repo’s folder name and the path under it', () => {
    expect(locateInSession(single, '/wt/api/docs/specs/a.md')).toEqual({ repo: 'api', path: 'docs/specs/a.md' });
    expect(locateInSession(group, '/wt/feat-x/web/src/page.tsx')).toEqual({ repo: 'web', path: 'src/page.tsx' });
    expect(locateInSession(single, '\\wt\\api\\docs\\a.md'.replace(/\\/g, '/'))).toEqual({ repo: 'api', path: 'docs/a.md' });
  });

  it('a session folder’s own file is repo ""; one in a subfolder that is no repo isn’t its', () => {
    expect(locateInSession(group, '/wt/feat-x/CLAUDE.md')).toEqual({ repo: '', path: 'CLAUDE.md' });
    expect(locateInSession(group, '/wt/feat-x/notes/a.md')).toBeNull();
    // A single repo has no folder of its own beside it.
    expect(locateInSession(single, '/wt/other.md')).toBeNull();
  });

  it('none of its folders: no; a folder that only starts the same isn’t it; the folder itself is no file', () => {
    expect(locateInSession(single, '/etc/passwd')).toBeNull();
    expect(locateInSession(single, '/wt/api-secrets/key.pem')).toBeNull();
    expect(locateInSession(single, '/wt/api/../other/x.md')).toBeNull();
    expect(locateInSession(single, '/wt/api')).toBeNull();
  });
});

describe('createShownFiles', () => {
  it('one a session; showing another replaces it; each change is announced; closing nothing announces nothing', () => {
    const changed: string[] = [];
    const now = new Date('2026-11-18T10:00:00Z');
    const shown = createShownFiles({ onChange: (id) => void changed.push(id), now: () => now });
    expect(shown.get('s1')).toBeNull();
    expect(shown.show('s1', { repo: 'api', path: 'a.md' })).toEqual({ repo: 'api', path: 'a.md', at: now.toISOString() });
    shown.show('s1', { repo: 'api', path: 'b.md' });
    expect(shown.get('s1')?.path).toBe('b.md');
    expect(shown.get('s2')).toBeNull();
    expect(shown.close('s1')).toBe(true);
    expect(shown.close('s1')).toBe(false);
    expect(shown.get('s1')).toBeNull();
    expect(changed).toEqual(['s1', 's1', 's1']);
  });
});
