// Stand-in GitHub CLI for functional and e2e tests. Keeps one PR per
// repository — keyed by the repo's working directory, so each repo of a
// group has its own — in a JSON state file ($FAKE_GH_STATE), and logs every
// invocation ($FAKE_GH_LOG: argv per line; $FAKE_GH_LOG.cwd: cwd per line).
// Implements just what core/ship.ts calls: pr view / pr create / pr merge,
// including GitHub's --match-head-commit refusal.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
fs.appendFileSync(process.env.FAKE_GH_LOG + '.cwd', process.cwd() + '\n');
const statePath = process.env.FAKE_GH_STATE;
const all = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf-8')) : {};
const key = process.cwd().toLowerCase();
let pr = all[key] ?? null;
const save = () => {
  all[key] = pr;
  fs.writeFileSync(statePath, JSON.stringify(all));
};
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8', timeout: 30_000 }).trim();

if (args[0] === 'pr' && args[1] === 'view') {
  if (!pr) {
    process.stderr.write(`no pull requests found for branch "${args[2]}"\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ...pr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const number = 42 + Object.keys(all).length;
  pr = {
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    state: 'OPEN',
    isDraft: args.includes('--draft'),
    mergeStateStatus: 'CLEAN',
    headRefOid: head(),
  };
  save();
  process.stdout.write(pr.url + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const sha = args[args.indexOf('--match-head-commit') + 1];
  if (!pr || sha !== pr.headRefOid) {
    process.stderr.write('Head branch was modified. Review and try the merge again.\n');
    process.exit(1);
  }
  pr.state = 'MERGED';
  pr.mergedAt = new Date().toISOString();
  save();
  process.exit(0);
}
process.stderr.write('fake gh: unsupported ' + args.join(' ') + '\n');
process.exit(2);
