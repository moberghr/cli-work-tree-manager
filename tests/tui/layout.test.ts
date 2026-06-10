import { describe, it, expect } from 'vitest';
import { buildSessionRows, buildProjectRows, computeScrollOffset, visualRowToCursor, type SidebarRow } from '../../src/tui-ink/Sidebar.js';
import type { WorktreeSession } from '../../src/core/history.js';

function makeSession(target: string, branch: string, isGroup = false): WorktreeSession {
  return {
    target,
    branch,
    isGroup,
    paths: ['/tmp/test'],
    lastAccessedAt: Date.now(),
  };
}

describe('buildSessionRows', () => {
  it('returns empty array for empty sessions', () => {
    expect(buildSessionRows([])).toEqual([]);
  });

  it('groups sessions by target with headers', () => {
    const sessions = [
      makeSession('api', 'feature-a'),
      makeSession('api', 'feature-b'),
      makeSession('frontend', 'main'),
    ];
    const rows = buildSessionRows(sessions);

    expect(rows).toHaveLength(5); // 2 headers + 3 sessions
    expect(rows[0]).toEqual({ type: 'header', label: 'api (repo)' });
    expect(rows[1]).toMatchObject({ type: 'session', session: sessions[0] });
    expect(rows[2]).toMatchObject({ type: 'session', session: sessions[1] });
    expect(rows[3]).toEqual({ type: 'header', label: 'frontend (repo)' });
    expect(rows[4]).toMatchObject({ type: 'session', session: sessions[2] });
  });

  it('labels groups correctly', () => {
    const sessions = [makeSession('fullstack', 'dev', true)];
    const rows = buildSessionRows(sessions);

    expect(rows[0]).toEqual({ type: 'header', label: 'fullstack (group)' });
  });

  it('preserves session objects across groups', () => {
    const sessions = [
      makeSession('a', 'b1'),
      makeSession('b', 'b2'),
      makeSession('b', 'b3'),
    ];
    const rows = buildSessionRows(sessions);
    const sessionRows = rows
      .filter((r): r is Extract<typeof r, { type: 'session' }> => r.type === 'session');
    expect(sessionRows.map((r) => r.session)).toEqual([sessions[0], sessions[1], sessions[2]]);
  });
});

describe('buildProjectRows', () => {
  it('returns empty array for empty projects', () => {
    expect(buildProjectRows([])).toEqual([]);
  });

  it('includes header and project entries', () => {
    const projects = [
      { name: 'api', isGroup: false },
      { name: 'fullstack', isGroup: true },
    ];
    const rows = buildProjectRows(projects);

    expect(rows).toHaveLength(3); // 1 header + 2 projects
    expect(rows[0]).toEqual({ type: 'header', label: 'Select project' });
    expect(rows[1]).toMatchObject({ type: 'project', name: 'api', isGroup: false });
    expect(rows[2]).toMatchObject({ type: 'project', name: 'fullstack', isGroup: true });
  });
});

describe('computeScrollOffset', () => {
  function makeRows(count: number, headerEvery = 0): SidebarRow[] {
    const rows: SidebarRow[] = [];
    for (let i = 0; i < count; i++) {
      if (headerEvery > 0 && i % headerEvery === 0) {
        rows.push({ type: 'header', label: `h${i}` });
      }
      rows.push({ type: 'session', session: makeSession('t', `b${i}`) });
    }
    return rows;
  }

  it('returns 0 when everything fits', () => {
    expect(computeScrollOffset(makeRows(3), 2, 10)).toBe(0);
  });

  it('returns 0 when the cursor is near the top', () => {
    expect(computeScrollOffset(makeRows(20), 0, 5)).toBe(0);
  });

  it('scrolls to keep a far cursor visible', () => {
    const rows = makeRows(20);
    const offset = computeScrollOffset(rows, 10, 5);
    // cursor row index 10 must fall inside [offset, offset + 5)
    expect(10).toBeGreaterThanOrEqual(offset);
    expect(10).toBeLessThan(offset + 5);
  });

  it('never scrolls past the end', () => {
    const rows = makeRows(20);
    expect(computeScrollOffset(rows, 19, 5)).toBe(rows.length - 5);
  });

  it('accounts for header rows when locating the cursor', () => {
    const rows = makeRows(20, 4); // headers interleaved
    const offset = computeScrollOffset(rows, 10, 6);
    // find actual row index of selectable #10
    let idx = -1, sel = -1;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].type !== 'header') {
        sel++;
        if (sel === 10) { idx = i; break; }
      }
    }
    expect(idx).toBeGreaterThanOrEqual(offset);
    expect(idx).toBeLessThan(offset + 6);
  });

  it('round-trips with visualRowToCursor for clicked rows', () => {
    const rows = makeRows(30, 5);
    const contentHeight = 8;
    for (const cursor of [0, 5, 12, 20]) {
      const offset = computeScrollOffset(rows, cursor, contentHeight);
      // Click each visible selectable row and verify mapping is identity
      for (let visual = 0; visual < contentHeight; visual++) {
        const actualIdx = offset + visual;
        if (actualIdx >= rows.length || rows[actualIdx].type === 'header') continue;
        const mapped = visualRowToCursor(rows, actualIdx);
        // mapped cursor must point back at this exact row
        let sel = -1, found = -1;
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].type !== 'header') {
            sel++;
            if (sel === mapped) { found = i; break; }
          }
        }
        expect(found).toBe(actualIdx);
      }
    }
  });
});
