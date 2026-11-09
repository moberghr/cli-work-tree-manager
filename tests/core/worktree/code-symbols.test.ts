import { describe, expect, it } from 'vitest';
import {
  declarationOf,
  matchSymbols,
  nameParts,
  nameScore,
  parseGrepLine,
  prepareSymbols,
  startsOfParts,
} from '../../../src/core/worktree/code-symbols.js';
import type { CodeSymbol } from '../../../src/core/api-types.js';

describe('declarationOf: a declaration on a line, by language', () => {
  it('C#: types with their modifiers, methods and properties with an access modifier — not calls or statements', () => {
    expect(declarationOf('a.cs', 'public sealed partial class AccountingKeys')).toEqual({ name: 'AccountingKeys', kind: 'class' });
    expect(declarationOf('a.cs', '    internal record struct Money(decimal Amount);')).toEqual({ name: 'Money', kind: 'record' });
    expect(declarationOf('a.cs', 'public interface IJobStore')).toEqual({ name: 'IJobStore', kind: 'interface' });
    expect(declarationOf('a.cs', '  public enum Status { A, B }')).toEqual({ name: 'Status', kind: 'enum' });
    expect(declarationOf('a.cs', '    public async Task<List<Job>> GetPendingJobs(int max)')).toEqual({
      name: 'GetPendingJobs',
      kind: 'method',
    });
    expect(declarationOf('a.cs', '    private static T Parse<T>(string s) where T : new()')).toEqual({ name: 'Parse', kind: 'method' });
    expect(declarationOf('a.cs', '    public string Name { get; set; }')).toEqual({ name: 'Name', kind: 'property' });
    expect(declarationOf('a.cs', '    public int Count => items.Count;')).toEqual({ name: 'Count', kind: 'property' });
    expect(declarationOf('a.cs', '        var jobs = await store.GetPendingJobs(10);')).toBeNull();
    expect(declarationOf('a.cs', '        if (x) return;')).toBeNull();
  });

  it('TypeScript / JavaScript and Python', () => {
    expect(declarationOf('a.ts', 'export async function loadHistory() {')).toEqual({ name: 'loadHistory', kind: 'function' });
    expect(declarationOf('a.tsx', 'export default class Dashboard extends X {')).toEqual({ name: 'Dashboard', kind: 'class' });
    expect(declarationOf('a.ts', 'export interface CodeEntry {')).toEqual({ name: 'CodeEntry', kind: 'interface' });
    expect(declarationOf('a.ts', 'type Sort = "a" | "b";')).toEqual({ name: 'Sort', kind: 'type' });
    expect(declarationOf('a.ts', 'export const MAX_FILES = 5;')).toEqual({ name: 'MAX_FILES', kind: 'const' });
    expect(declarationOf('a.ts', '  const local = 1;')).toBeNull();
    expect(declarationOf('a.py', 'async def fetch_all(self):')).toEqual({ name: 'fetch_all', kind: 'function' });
    expect(declarationOf('a.py', 'class Parser:')).toEqual({ name: 'Parser', kind: 'class' });
  });

  it("Python: classes, functions and methods (indented, async, decorated below), stubs, and a module's constants", () => {
    expect(declarationOf('svc.py', '    def get_pending_jobs(self, limit: int = 10) -> list[Job]:')).toEqual({
      name: 'get_pending_jobs',
      kind: 'function',
    });
    expect(declarationOf('svc.py', '    async def fetch(self):')).toEqual({ name: 'fetch', kind: 'function' });
    expect(declarationOf('svc.py', 'class JobStore(Base, metaclass=ABCMeta):')).toEqual({ name: 'JobStore', kind: 'class' });
    expect(declarationOf('svc.pyi', 'def parse(text: str) -> Doc: ...')).toEqual({ name: 'parse', kind: 'function' });
    expect(declarationOf('settings.py', 'MAX_RETRIES = 3')).toEqual({ name: 'MAX_RETRIES', kind: 'const' });
    expect(declarationOf('settings.py', 'TIMEOUT: int = 30')).toEqual({ name: 'TIMEOUT', kind: 'const' });
    // Not constants: a comparison, a lower-case variable, one inside a function.
    expect(declarationOf('settings.py', 'DEBUG == True')).toBeNull();
    expect(declarationOf('settings.py', 'retries = 3')).toBeNull();
    expect(declarationOf('settings.py', '    LIMIT = 5')).toBeNull();
    expect(declarationOf('settings.py', '@dataclass')).toBeNull();
  });

  it("only a language's own patterns: a C# line in a .md is nothing", () => {
    expect(declarationOf('README.md', 'public class Example')).toBeNull();
  });
});

describe('matching names as Visual Studio does', () => {
  it('words of a name: capitals, runs of capitals, underscores and digits', () => {
    expect(nameParts('GetPendingJobs')).toEqual(['Get', 'Pending', 'Jobs']);
    expect(nameParts('HTTPClient2')).toEqual(['HTTP', 'Client', '2']);
    expect(nameParts('fetch_all_items')).toEqual(['fetch', 'all', 'items']);
  });

  it('the starts of its words, in order, any case — words may be skipped', () => {
    expect(startsOfParts(['get', 'pending', 'jobs'], 'gpj')).toBe(true);
    expect(startsOfParts(['accounting', 'keys'], 'acckeys')).toBe(true);
    expect(startsOfParts(['accounting', 'keys'], 'akeys')).toBe(true);
    expect(startsOfParts(['get', 'pending', 'jobs'], 'gj')).toBe(true);
    expect(startsOfParts(['get', 'pending', 'jobs'], 'jpg')).toBe(false); // out of order
  });

  it('exact, then a prefix, then a word start, then inside, then the starts of words', () => {
    expect(nameScore('AccountingKeys', 'accountingkeys')).toBe(0);
    expect(nameScore('AccountingKeys', 'Account')).toBe(1);
    expect(nameScore('AccountingKeys', 'Keys')).toBe(2);
    expect(nameScore('AccountingKeys', 'ntingK')).toBe(3);
    expect(nameScore('AccountingKeys', 'AccKeys')).toBe(4);
    expect(nameScore('AccountingKeys', 'acckeys')).toBe(4);
    expect(nameScore('AccountingKeys', 'zz')).toBeNull();
  });

  it('ranked: how well, then types before members, then the shorter name; prepared or not, the same', () => {
    const sym = (name: string, kind: CodeSymbol['kind']): CodeSymbol => ({
      name,
      kind,
      repo: 'api',
      path: `${name}.cs`,
      line: 1,
      text: '',
    });
    const all = [
      sym('AccountingKeysTests', 'class'),
      sym('GetAccountingKeys', 'method'),
      sym('AccountingKeys', 'property'),
      sym('AccountingKeys', 'class'),
    ];
    const names = (q: string) => matchSymbols(all, q).map((s) => `${s.kind} ${s.name}`);
    expect(names('AccountingKeys')).toEqual([
      'class AccountingKeys',
      'property AccountingKeys',
      'class AccountingKeysTests',
      'method GetAccountingKeys',
    ]);
    expect(matchSymbols(prepareSymbols(all), 'AccountingKeys')).toEqual(matchSymbols(all, 'AccountingKeys'));
    expect(matchSymbols(all, '   ')).toEqual([]);
    // Names that differ only in case have their own words: each scored for itself.
    const cased = [sym('Getstatus', 'method'), sym('GetStatus', 'method')];
    expect(matchSymbols(cased, 'gs').map((s) => s.name)).toEqual(['GetStatus']);
  });
});

describe('parseGrepLine', () => {
  it('with -z: the path verbatim, a non-ASCII or colon one too (git quotes it otherwise)', () => {
    expect(parseGrepLine('src/Računi.cs\u000012\u0000public class Računi')).toEqual({
      path: 'src/Računi.cs',
      line: 12,
      text: 'public class Računi',
    });
    expect(parseGrepLine('a:b.txt\u00003\u0000x: y')).toEqual({ path: 'a:b.txt', line: 3, text: 'x: y' });
  });

  it('path, line and text — a colon in the text stays in the text', () => {
    expect(parseGrepLine('src/a.ts:12:const x = { a: 1 };')).toEqual({ path: 'src/a.ts', line: 12, text: 'const x = { a: 1 };' });
    expect(parseGrepLine('no colons here')).toBeNull();
  });
});
