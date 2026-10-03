/** Words that say what kind of change it is, and the branch prefix each means. */
const KIND: Array<[RegExp, string]> = [
  [/^(fix|fixes|fixed|repair|resolve|correct|bug)$/, 'fix'],
  [/^(update|upgrade|bump|clean|cleanup|tidy|chore|rename|move|remove|delete|drop)$/, 'chore'],
  [/^(document|docs|doc|readme)$/, 'docs'],
  [/^(refactor|simplify|restructure|extract|split)$/, 'refactor'],
  [/^(test|tests)$/, 'test'],
];
/** Leading verbs that say nothing a branch name needs ("Add …", "Please make …"). */
const FILLER_VERBS = new Set([
  'add',
  'adds',
  'implement',
  'create',
  'make',
  'build',
  'support',
  'introduce',
  'please',
  'let',
  'lets',
  "let's",
  'can',
  'you',
  'we',
  'should',
  'i',
  'want',
]);
const STOP = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'for',
  'in',
  'on',
  'at',
  'and',
  'or',
  'with',
  'by',
  'from',
  'into',
  'that',
  'this',
  'it',
  'its',
  'is',
  'are',
  'be',
  'so',
  'when',
  'our',
  'my',
  'your',
  'all',
  'some',
  'new',
]);
const MAX_WORDS = 3;
const MAX_LEN = 40;

/**
 * A branch name from what you asked Claude to do: "Add CSV export to the
 * invoices endpoint" → `feat/csv-export-invoices`, "Fix the redirect loop
 * after login" → `fix/redirect-loop-after`. The kind comes from the first
 * word (fix/, chore/, docs/, refactor/, test/, else feat/); filler verbs and
 * small words go; three words at most. Empty for an empty prompt. Pure.
 */
export function suggestBranch(prompt: string): string {
  const words = (prompt.split('\n')[0] ?? '')
    .toLowerCase()
    // é → e: accents folded, not dropped with the letter.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean);
  if (words.length === 0) return '';
  let kind = 'feat';
  const first = words[0];
  const matched = KIND.find(([re]) => re.test(first));
  if (matched) kind = matched[1];
  let i = 0;
  while (i < words.length && (FILLER_VERBS.has(words[i]) || (i === 0 && matched))) i++;
  const picked = words
    .slice(i)
    .map((w) => w.replace(/'/g, ''))
    .filter((w) => w && !STOP.has(w))
    .slice(0, MAX_WORDS);
  if (picked.length === 0) return '';
  const slug = picked.join('-').replace(/-+/g, '-').slice(0, MAX_LEN).replace(/-+$/, '');
  return `${kind}/${slug}`;
}
