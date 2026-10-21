import { describe, expect, it } from 'vitest';
import { recordedRepos, sessionAliases, sessionRepos } from '../../../src/core/sessions/session-repos.js';

const config = {
  repos: { api: '/src/api-service', web: '/src/web-app', docs: '/src/Docs' },
  groups: { shop: ['api', 'web'] },
};
const group = (paths: string[], repos?: string[]) => ({ target: 'shop', isGroup: true, paths, ...(repos ? { repos } : {}) });

describe('sessionRepos: a session owns its repos', () => {
  it('a recorded list is zipped with the paths, in order, whatever the group config says', () => {
    const s = group(['/w/shop/feat/api-service', '/w/shop/feat/web-app', '/w/shop/feat/Docs'], ['api', 'web', 'docs']);
    expect(sessionRepos(s, config)).toEqual([
      { alias: 'api', path: '/w/shop/feat/api-service' },
      { alias: 'web', path: '/w/shop/feat/web-app' },
      { alias: 'docs', path: '/w/shop/feat/Docs' },
    ]);
    expect(sessionAliases(s, config)).toEqual(['api', 'web', 'docs']);
    // A repo its group lost stays the session's.
    expect(sessionAliases(s, { groups: { shop: ['api'] } })).toEqual(['api', 'web', 'docs']);
  });

  it('a row from before (no repos): a group folder maps to the member named like it (case-blind), else its own name', () => {
    const s = group(['/w/shop/feat/WEB-APP', '/w/shop/feat/api-service', '/w/shop/feat/stray']);
    expect(sessionRepos(s, config)).toEqual([
      { alias: 'web', path: '/w/shop/feat/WEB-APP' },
      { alias: 'api', path: '/w/shop/feat/api-service' },
      { alias: 'stray', path: '/w/shop/feat/stray', guessed: true },
    ]);
    // Only the group's members: docs isn't one, so its folder is guessed.
    expect(sessionRepos(group(['/w/shop/feat/Docs']), config)).toEqual([{ alias: 'Docs', path: '/w/shop/feat/Docs', guessed: true }]);
    // The aliases it acts over are the group's config, as before.
    expect(sessionAliases(s, config)).toEqual(['api', 'web']);
    expect(sessionAliases(group([]), { groups: {} })).toEqual([]);
    expect(sessionAliases(s, null)).toEqual([]);
  });

  it('a single-repo row from before is its target at its first path', () => {
    const s = { target: 'api', isGroup: false, paths: ['/w/api-service/feat'] };
    expect(sessionRepos(s, config)).toEqual([{ alias: 'api', path: '/w/api-service/feat' }]);
    expect(sessionAliases(s, config)).toEqual(['api']);
    expect(sessionRepos({ ...s, paths: [] }, config)).toEqual([]);
  });

  it('a recorded list that does not match the paths (length, empty, not strings) is ignored: the legacy reading', () => {
    const paths = ['/w/shop/feat/api-service', '/w/shop/feat/web-app'];
    expect(recordedRepos({ paths, repos: ['api'] })).toBeNull();
    expect(recordedRepos({ paths: [], repos: [] })).toBeNull();
    expect(recordedRepos({ paths, repos: ['api', ''] })).toBeNull();
    expect(recordedRepos({ paths, repos: ['api', 7 as unknown as string] })).toBeNull();
    expect(sessionRepos(group(paths, ['docs']), config)).toEqual([
      { alias: 'api', path: paths[0] },
      { alias: 'web', path: paths[1] },
    ]);
    expect(sessionAliases(group(paths, ['docs']), config)).toEqual(['api', 'web']);
  });
});
