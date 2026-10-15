/**
 * A branch name from what you asked Claude to do. Prompts are written as
 * they come — a question, a pasted error, a Jira link, "we should…", in
 * Croatian too — so the name is read from what the prompt says, not from
 * its first three words:
 *
 *   - a Jira key or link (SSD-2493, …/browse/SSD-2493): `feat/SSD-2493`,
 *     the branch Jira's own Start makes, so the session is the issue's;
 *   - a pasted exception: `fix/invalid-operation-exception`;
 *   - a question or an investigation (why…, what…, check…, "provjeri"):
 *     `tmp/` — something to look into, not a feature;
 *   - failure words anywhere (fails, broken, error, wrong…): `fix/`;
 *   - a leading kind word (update, refactor, docs, test): that kind;
 *   - else `feat/`.
 *
 * Then up to three words that say what it's about, in order, without URLs,
 * code, filler, pronouns, helper verbs and small words (English and
 * Croatian). A prompt with nothing to name it by still gets a branch of its
 * own, `<kind>/work-MMDD-HHmm`: with a prompt the dialog always makes a new
 * worktree. Empty only for an empty prompt. Pure.
 */

/** A leading word that says what kind of change it is. */
const KIND: Array<[RegExp, string]> = [
  [/^(fix|fixes|fixed|repair|resolve|correct|bug|popravi|ispravi)$/, 'fix'],
  [/^(update|upgrade|bump|clean|cleanup|tidy|chore|rename|move|remove|delete|drop)$/, 'chore'],
  [/^(document|docs|doc|readme)$/, 'docs'],
  [/^(refactor|simplify|restructure|extract|split)$/, 'refactor'],
  [/^(test|tests)$/, 'test'],
];
/** Words anywhere that say something is broken. */
const FAILURE =
  /^(bug|bugs|broken|break|breaks|fail|fails|failed|failing|failure|failures|error|errors|crash|crashes|crashing|wrong|exception|regression|greska|greske|puca|ne-radi)$/;
/** A first word that asks or looks into something: a question, an investigation. */
const ASKING =
  /^(why|what|whats|how|when|where|which|who|does|do|did|is|are|was|were|can|could|should|would|will|has|have|check|investigate|inspect|analyze|analyse|explore|look|find|figure|see|tell|show|give|list|compare|verify|review|explain|zasto|sto|kako|koji|koja|koje|gdje|kada|provjeri|provjeriti|pogledaj|mozes|mozete|daj)$/;
/** Leading words that say nothing a branch name needs ("Add …", "Please make …", "we should …"). */
// prettier-ignore
const FILLER = new Set([
  'add', 'adds', 'implement', 'create', 'make', 'build', 'support', 'introduce', 'please', 'let', 'lets', 'can', 'could',
  'you', 'we', 'should', 'i', 'want', 'need', 'to', 'go', 'ahead', 'and', 'so', 'ok', 'okay', 'hey', 'hi', 'now', 'also',
  'molim', 'te', 'mi', 'trebamo', 'treba', 'ajde', 'hajde',
]);
/** Words that say nothing about what it is, anywhere. */
// prettier-ignore
const STOP = new Set([
  // small words
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'and', 'or', 'with', 'by', 'from', 'into', 'that', 'this', 'these',
  'those', 'it', 'its', 'is', 'are', 'be', 'been', 'being', 'was', 'were', 'so', 'when', 'our', 'my', 'your', 'their', 'all',
  'some', 'any', 'new', 'old', 'as', 'if', 'then', 'than', 'but', 'not', 'no', 'yes', 'up', 'out', 'about', 'over', 'after',
  'before', 'like', 'just', 'only', 'really', 'very', 'still', 'also', 'maybe', 'somehow', 'something', 'somewhere',
  'actually', 'directly', 'basically', 'probably', 'currently', 'always', 'never', 'sometimes', 'twice', 'once',
  'per', 'via', 'without', 'within', 'between', 'during', 'through',
  'anything', 'everything', 'there', 'here', 'now', 'way', 'thing', 'things', 'stuff', 'bit', 'one', 'each', 'other', 'more',
  'most', 'much', 'many', 'too', 'again', 'even', 'ever', 'why', 'what', 'whats', 'how', 'where', 'which', 'who', 'whom',
  // people
  'i', 'me', 'we', 'us', 'you', 'they', 'them', 'he', 'she', 'him', 'her', 'im', 'ive', 'were', 'youre', 'theyre', 'lets',
  // helper and generic verbs
  'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'get', 'gets', 'got', 'getting', 'can', 'could', 'should',
  'would', 'will', 'may', 'might', 'must', 'need', 'needs', 'want', 'wants', 'make', 'makes', 'put', 'take', 'takes', 'took',
  'use', 'used', 'using', 'try', 'see', 'look', 'check', 'find', 'give', 'show', 'tell', 'know', 'think', 'seems', 'seem',
  'run', 'runs', 'running', 'work', 'works', 'working', 'happen', 'happens', 'happened', 'go', 'goes', 'going', 'come',
  'please', 'investigate', 'inspect', 'figure', 'explain', 'verify', 'review', 'compare', 'list',
  // Croatian
  'je', 'su', 'da', 'li', 'se', 'sa', 's', 'za', 'na', 'u', 'i', 'od', 'do', 'iz', 'po', 'kod', 'o', 'a', 'ali', 'pa', 'jer',
  'ako', 'bi', 'smo', 'ste', 'sam', 'si', 'nije', 'nisu', 'ne', 'to', 'ovo', 'ono', 'taj', 'ta', 'te', 'ti', 'mi', 'vi',
  'oni', 'mozes', 'mozete', 'moze', 'molim', 'kako', 'zasto', 'sto', 'koji', 'koja', 'koje', 'gdje', 'kada', 'provjeri',
  'provjeriti', 'pogledaj', 'dobili', 'dobio', 'imamo', 'ima', 'nema', 'treba', 'trebamo', 'jos', 'sve', 'neki', 'neka',
]);
/** Letters NFD doesn't take apart (đ, ß, ø…): what they read as in a branch name. */
const LETTERS: Record<string, string> = { đ: 'd', ð: 'd', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', ł: 'l', þ: 'th', ı: 'i' };
const MAX_WORDS = 3;
const MAX_LEN = 40;

const pad = (n: number) => String(n).padStart(2, '0');

/** A URL's last part that names something (not a number, not empty): …/api/authorizations?x=1 → authorizations. */
function lastPathPart(url: string): string {
  const parts = url
    .replace(/[?#].*$/, '')
    .split('/')
    .slice(3)
    .filter((p) => p && !/^\d+$/.test(p));
  return parts[parts.length - 1] ?? '';
}

/** "InvalidOperationException" → "invalid-operation-exception". */
const kebab = (name: string) =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();

/** A line as words: lower case, accents folded, URLs and code left out. */
function wordsOf(line: string): string[] {
  return (
    line
      // A URL by its last named part (…/api/authorizations?… → authorizations); a Jira link is read before this.
      .replace(/\bhttps?:\/\/\S+/gi, (url) => ` ${lastPathPart(url)} `)
      // Code: dotted names, calls, assignments (`ISettlementJobs.TransferSettlementPayment`, `a=b`).
      .replace(/\S*[.(=<>{}[\]\\/]\S*/g, (t) => (/^[\w-]+[.,!?:;]?$/.test(t) ? t : ' '))
      .toLowerCase()
      .replace(/[đðßæœøłþı]/g, (c) => LETTERS[c] ?? c)
      // é → e: accents folded, not dropped with the letter.
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9\s'-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.replace(/'/g, '').replace(/^-+|-+$/g, ''))
      .filter(Boolean)
  );
}

export function suggestBranch(prompt: string, now: Date = new Date()): string {
  const line = prompt.split('\n').find((l) => l.trim()) ?? '';
  if (!line) return '';
  const head = prompt.slice(0, 600);

  // A Jira issue: its own branch, as Jira's Start makes it.
  const jira = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/.exec(head);
  if (jira) return `feat/${jira[1]}`;
  // A pasted exception: what broke.
  const exception = /\b([A-Z][A-Za-z0-9]*(?:Exception|Error))\b/.exec(head);
  if (exception) return `fix/${kebab(exception[1])}`.slice(0, MAX_LEN + 4).replace(/-+$/, '');

  const words = wordsOf(line);
  let i = 0;
  while (i < words.length && FILLER.has(words[i])) i++;
  const first = words[i];
  const leading = first ? KIND.find(([re]) => re.test(first)) : undefined;
  let kind = 'feat';
  if (leading) {
    kind = leading[1];
    i++;
  } else if (first && ASKING.test(first)) kind = 'tmp';
  else if (words.some((w) => FAILURE.test(w))) kind = 'fix';
  else if (/\?\s*$/.test(line.trim())) kind = 'tmp';

  const picked = [
    ...new Set(
      words
        .slice(i)
        // Not an id or a code (P-496079-31-A, JVRN7KPJD45NXVQ9, 538): a word with digits beyond a short one (v2, s3).
        .filter((w) => !STOP.has(w) && !FAILURE.test(w) && w.length > 1 && w.length <= 24 && !(/\d/.test(w) && w.length > 3)),
    ),
  ].slice(0, MAX_WORDS);
  const slug = picked.join('-').slice(0, MAX_LEN).replace(/-+$/, '');
  if (slug) return `${kind}/${slug}`;
  return `${kind}/work-${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
