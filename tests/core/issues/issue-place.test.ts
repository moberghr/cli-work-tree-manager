import { describe, expect, it } from 'vitest';
import { parseIssueRule, placeIssue, ruleText, issueRules, type IssueRule } from '../../../src/core/issues/issue-place.js';
import { jiraPlaced, placeJira } from '../../../src/core/issues/jira-placed.js';
import { checkSetting, SETTING_PATTERNS, settingAt } from '../../../src/core/settings/settings-schema.js';

/** Where an issue's work starts: your rules from where issues come from to one of your projects. */
const rule = (line: string): IssueRule => {
  const r = parseIssueRule(line);
  if (!r.ok) throw new Error(r.error);
  return r.rule;
};
const PROJECTS = ['shop', 'api', 'web'];

describe('parseIssueRule', () => {
  it('a line is a source, a scope, optionally what narrows it, and the project it starts in', () => {
    expect(rule('jira:PAY -> api')).toEqual({ source: 'jira', scope: 'PAY', target: 'api' });
    expect(rule('  Jira : SHOP / checkout  =>  shop ')).toEqual({ source: 'jira', scope: 'SHOP', facet: 'checkout', target: 'shop' });
    expect(rule('azure:Payments/Core\\API → api')).toEqual({ source: 'azure', scope: 'Payments', facet: 'Core\\API', target: 'api' });
    // A GitHub scope is owner/repo whole: the slash is part of it, not a facet.
    expect(rule('github:acme/web -> shop')).toEqual({ source: 'github', scope: 'acme/web', target: 'shop' });
    expect(ruleText(rule('jira:SHOP/checkout -> shop'))).toBe('jira:SHOP/checkout -> shop');
  });

  it('what isn’t a rule says why', () => {
    const why = (line: string) => {
      const r = parseIssueRule(line);
      return r.ok ? null : r.error;
    };
    expect(why('PAY api')).toContain('source:scope -> project');
    expect(why('trello:BOARD -> api')).toContain("isn't an issue source");
    expect(why('github:web -> shop')).toBe('a GitHub scope is owner/repo');
    expect(why('jira:PAY/ -> api')).toBe('nothing follows the slash');
  });

  it('the setting’s lines: rules, and the ones that aren’t with why; blanks and non-text skipped', () => {
    const r = issueRules(['jira:PAY -> api', '', '  ', 7, 'nonsense', 'github:acme/web -> shop']);
    expect(r.rules.map(ruleText)).toEqual(['jira:PAY -> api', 'github:acme/web -> shop']);
    expect(r.invalid).toEqual([{ line: 'nonsense', error: expect.stringContaining('source:scope -> project') }]);
    expect(issueRules(undefined)).toEqual({ rules: [], invalid: [] });
  });

  it('the Settings page accepts exactly the lines the parser reads', () => {
    const field = settingAt('issues.rules')!;
    const re = new RegExp(SETTING_PATTERNS.issueRule);
    for (const line of ['jira:PAY -> api', 'jira:SHOP/checkout => shop', 'github:acme/web -> shop', 'azure:Payments/Core\\API → api']) {
      expect(re.test(line), line).toBe(true);
      expect(parseIssueRule(line).ok, line).toBe(true);
    }
    for (const line of ['PAY api', 'trello:B -> api', 'github:web -> shop', 'jira:PAY ->', 'jira:PAY/ -> api']) {
      expect(re.test(line), line).toBe(false);
      expect(parseIssueRule(line).ok, line).toBe(false);
    }
    expect(checkSetting(field, ['jira:PAY -> api', '  '])).toEqual({ ok: true, value: ['jira:PAY -> api'] });
    expect(checkSetting(field, ['PAY api'])).toMatchObject({ ok: false, error: expect.stringContaining('isn’t a rule') });
  });
});

describe('placeIssue', () => {
  const rules = [rule('jira:PAY -> api'), rule('jira:SHOP -> web'), rule('jira:SHOP/checkout -> shop'), rule('github:acme/web -> shop')];

  it('a rule about its source and scope says where; the project’s own spelling is given back', () => {
    expect(placeIssue({ source: 'jira', scope: 'pay', facets: [] }, rules, ['Shop', 'API'])).toMatchObject({ target: 'API' });
    expect(placeIssue({ source: 'github', scope: 'acme/web', facets: [] }, rules, PROJECTS)).toMatchObject({ target: 'shop' });
    // Another source's rule, or another scope: none is about it.
    expect(placeIssue({ source: 'azure', scope: 'PAY', facets: [] }, rules, PROJECTS)).toBeNull();
    expect(placeIssue({ source: 'jira', scope: 'OPS', facets: [] }, rules, PROJECTS)).toBeNull();
  });

  it('the narrower rule wins: an issue with that component or label goes to its project, the others to the scope’s', () => {
    expect(placeIssue({ source: 'jira', scope: 'SHOP', facets: ['Checkout', 'urgent'] }, rules, PROJECTS)).toMatchObject({
      target: 'shop',
    });
    expect(placeIssue({ source: 'jira', scope: 'SHOP', facets: ['search'] }, rules, PROJECTS)).toMatchObject({ target: 'web' });
    // Only narrow rules for a scope, and none fits: nothing is about this issue.
    expect(placeIssue({ source: 'jira', scope: 'SHOP', facets: ['search'] }, [rule('jira:SHOP/checkout -> shop')], PROJECTS)).toBeNull();
  });

  it('rules that name several projects for it leave it to you, and say so; never a pick between them', () => {
    const both = [rule('jira:SHOP/checkout -> shop'), rule('jira:SHOP/payments -> api')];
    const r = placeIssue({ source: 'jira', scope: 'SHOP', facets: ['checkout', 'payments'] }, both, PROJECTS);
    expect(r).toEqual({ target: null, why: 'your issue rules name several projects for it (shop, api)' });
  });

  it('a project that isn’t yours is said, not started in', () => {
    const r = placeIssue({ source: 'jira', scope: 'PAY', facets: [] }, rules, ['web']);
    expect(r).toEqual({ target: null, why: 'your issue rule "jira:PAY -> api" names api, which isn\'t one of your projects' });
  });

  it('with what narrows it unknown (a list of issues), a scope is placed only when every rule about it agrees', () => {
    expect(placeIssue({ source: 'jira', scope: 'PAY' }, rules, PROJECTS)).toMatchObject({ target: 'api' });
    expect(placeIssue({ source: 'jira', scope: 'SHOP' }, rules, PROJECTS)).toEqual({
      target: null,
      why: 'your issue rules send jira:SHOP to web, shop, depending on what it is about',
    });
  });
});

describe('a Jira issue under your rules', () => {
  const cfg = {
    repos: { api: '/r/api', web: '/r/web' },
    groups: { shop: ['api', 'web'] },
    issues: { rules: ['jira:PAY -> api', 'jira:SHOP/checkout -> shop'] },
  };

  it('its project is its scope (the key’s, or the detail’s own), its components and labels what narrow it', () => {
    expect(jiraPlaced({ key: 'PAY-12' })).toEqual({ source: 'jira', scope: 'PAY' });
    expect(jiraPlaced({ key: 'OLD-3' }, { project: { key: 'SHOP', name: 'Shop' }, components: ['checkout'], labels: ['urgent'] })).toEqual({
      source: 'jira',
      scope: 'SHOP',
      facets: ['checkout', 'urgent'],
    });
  });

  it('placed with the rule as the reason; a group is a project; no config or no rule: not placed', () => {
    expect(placeJira({ key: 'PAY-12' }, null, cfg)).toEqual({ target: 'api', reason: 'your issue rule: jira:PAY -> api', auto: false });
    expect(placeJira({ key: 'SHOP-4' }, { project: null, components: ['checkout'], labels: [] }, cfg)).toEqual({
      target: 'shop',
      reason: 'your issue rule: jira:SHOP/checkout -> shop',
      auto: false,
    });
    expect(placeJira({ key: 'OPS-1' }, null, cfg)).toBeNull();
    expect(placeJira({ key: 'PAY-12' }, null, null)).toBeNull();
    expect(placeJira({ key: 'PAY-12' }, null, { ...cfg, issues: undefined })).toBeNull();
  });
});

describe('(auto): the watch may start an issue of the rule by itself', () => {
  it('a rule says it after its project; without it, or with (ask), it only says where', () => {
    expect(rule('jira:PAY -> api (auto)')).toEqual({ source: 'jira', scope: 'PAY', target: 'api', auto: true });
    expect(rule('jira:PAY -> api  ( AUTO ) ')).toMatchObject({ target: 'api', auto: true });
    expect(rule('github:acme/web => shop (auto)')).toEqual({ source: 'github', scope: 'acme/web', target: 'shop', auto: true });
    expect(rule('jira:PAY -> api (ask)')).toEqual({ source: 'jira', scope: 'PAY', target: 'api' });
    expect('auto' in rule('jira:PAY -> api')).toBe(false);
    expect(ruleText(rule('jira:SHOP/checkout -> shop (auto)'))).toBe('jira:SHOP/checkout -> shop (auto)');
    expect(ruleText(rule('jira:PAY -> api (ask)'))).toBe('jira:PAY -> api');
  });

  it('another word in the brackets, or brackets with no project, isn’t a rule', () => {
    const why = (line: string) => {
      const r = parseIssueRule(line);
      return r.ok ? null : r.error;
    };
    expect(why('jira:PAY -> api (always)')).toBe('"(always)" isn\'t something a rule says: (auto) or (ask)');
    expect(why('jira:PAY -> (auto)')).toBe('no project after the arrow');
  });

  it('placing gives the rule back, so the watch knows; rules for one project that disagree: the careful one holds', () => {
    const placed = placeIssue({ source: 'jira', scope: 'PAY', facets: [] }, [rule('jira:PAY -> api (auto)')], PROJECTS);
    expect(placed).toMatchObject({ target: 'api', rule: { auto: true } });
    const mixed = placeIssue(
      { source: 'jira', scope: 'PAY', facets: [] },
      [rule('jira:PAY -> api (auto)'), rule('jira:PAY -> api')],
      PROJECTS,
    );
    expect(mixed).toMatchObject({ target: 'api' });
    expect((mixed as { rule: IssueRule }).rule.auto).toBeUndefined();
    // The narrower rule's word is the one that counts for an issue it fits.
    const rules = [rule('jira:SHOP -> web (auto)'), rule('jira:SHOP/checkout -> shop')];
    expect(
      (placeIssue({ source: 'jira', scope: 'SHOP', facets: ['checkout'] }, rules, PROJECTS) as { rule: IssueRule }).rule.auto,
    ).toBeUndefined();
    expect((placeIssue({ source: 'jira', scope: 'SHOP', facets: ['search'] }, rules, PROJECTS) as { rule: IssueRule }).rule.auto).toBe(
      true,
    );
  });

  it('a Jira issue under your rules says whether it may start by itself; the Settings page takes the same lines', () => {
    const cfg = { repos: { api: '/r/api' }, groups: {}, issues: { rules: ['jira:PAY -> api (auto)', 'jira:OPS -> api'] } };
    expect(placeJira({ key: 'PAY-1' }, null, cfg)).toEqual({
      target: 'api',
      reason: 'your issue rule: jira:PAY -> api (auto)',
      auto: true,
    });
    expect(placeJira({ key: 'OPS-1' }, null, cfg)).toEqual({ target: 'api', reason: 'your issue rule: jira:OPS -> api', auto: false });
    const re = new RegExp(SETTING_PATTERNS.issueRule);
    for (const line of ['jira:PAY -> api (auto)', 'jira:PAY -> api (ask)', 'github:acme/web -> shop (AUTO)', 'jira:PAY -> api']) {
      expect(re.test(line), line).toBe(true);
      expect(parseIssueRule(line).ok, line).toBe(true);
    }
    for (const line of ['jira:PAY -> api (always)', 'jira:PAY -> (auto)']) {
      expect(re.test(line), line).toBe(false);
      expect(parseIssueRule(line).ok, line).toBe(false);
    }
  });
});
