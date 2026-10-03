/** Words that say what kind of change it is, and the branch prefix each means. */
const KIND: Array<[RegExp, string]> = [
  [/^(fix|fixes|fixed|repair|resolve|correct|bug)$/, 'fix'],
  [/^(update|upgrade|bump|clean|cleanup|tidy|chore|rename|move|remove|delete|drop)$/, 'chore'],
  [/^(document|docs|doc|readme)$/, 'docs'],
  [/^(refactor|simplify|restructure|extract|split)$/, 'refactor'],
  [/^(test|tests)$/, 'test'],
];
/** Leading words that say nothing a branch name needs ("Add …", "Please make …"). */
// prettier-ignore
const FILLER = new Set([
  'add', 'adds', 'implement', 'create', 'make', 'build', 'support', 'introduce', 'please', 'let', 'lets', 'can', 'could',
  'you', 'we', 'should', 'i', 'want', 'need', 'to', 'go', 'ahead', 'and',
]);
// prettier-ignore
const STOP = new Set([
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'and', 'or', 'with', 'by', 'from', 'into', 'that', 'this', 'it', 'its',
  'is', 'are', 'be', 'so', 'when', 'our', 'my', 'your', 'all', 'some', 'new',
]);
/** Letters NFD doesn't take apart (đ, ß, ø…): what they read as in a branch name. */
const LETTERS: Record<string, string> = { đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', þ: 'th', ı: 'i' };
const MAX_WORDS = 3;
const MAX_LEN = 40;

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A branch name from what you asked Claude to do: "Add CSV export to the
 * invoices endpoint" → `feat/csv-export-invoices`, "Please fix the redirect
 * loop" → `fix/redirect-loop`. Filler ("please", "add", "can you") goes
 * first; the next word picks the kind (fix/, chore/, docs/, refactor/,
 * test/, else feat/); small words go; three words at most, from the first
 * line with text. A prompt with nothing to name it by ("Do it", Cyrillic)
 * still gets a branch of its own, `feat/work-MMDD-HHmm`: with a prompt the
 * dialog always makes a new worktree. Empty only for an empty prompt. Pure.
 */
export function suggestBranch(prompt: string, now: Date = new Date()): string {
  const line = prompt.split('\n').find((l) => l.trim()) ?? '';
  if (!line) return '';
  const words = line
    .toLowerCase()
    .replace(/[đðßæœøłþı]/g, (c) => LETTERS[c] ?? c)
    // é → e: accents folded, not dropped with the letter.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/'/g, '').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  let i = 0;
  while (i < words.length && FILLER.has(words[i])) i++;
  let kind = 'feat';
  const matched = i < words.length ? KIND.find(([re]) => re.test(words[i])) : undefined;
  if (matched) {
    kind = matched[1];
    i++;
  }
  const picked = words
    .slice(i)
    .filter((w) => !STOP.has(w))
    .slice(0, MAX_WORDS);
  const slug = picked.join('-').slice(0, MAX_LEN).replace(/-+$/, '');
  if (slug) return `${kind}/${slug}`;
  return `${kind}/work-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
