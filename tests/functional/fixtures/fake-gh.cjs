// Stand-in GitHub CLI for functional tests. Keeps one PR per test in a JSON
// state file ($FAKE_GH_STATE) and logs every invocation ($FAKE_GH_LOG).
// Implements just what core/ship.ts calls: pr view / pr create / pr merge,
// including GitHub's --match-head-commit refusal.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\n');
const statePath = process.env.FAKE_GH_STATE;
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf-8')) : { pr: null };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).trim();

if (args[0] === 'pr' && args[1] === 'view') {
  if (!state.pr) {
    process.stderr.write(`no pull requests found for branch "${args[2]}"\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ ...state.pr, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }));
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  state.pr = {
    number: 42,
    url: 'https://github.com/acme/app/pull/42',
    state: 'OPEN',
    isDraft: args.includes('--draft'),
    mergeStateStatus: 'CLEAN',
    headRefOid: head(),
  };
  save();
  process.stdout.write(state.pr.url + '\n');
  process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'merge') {
  const sha = args[args.indexOf('--match-head-commit') + 1];
  if (!state.pr || sha !== state.pr.headRefOid) {
    process.stderr.write('Head branch was modified. Review and try the merge again.\n');
    process.exit(1);
  }
  state.pr.state = 'MERGED';
  save();
  process.exit(0);
}
process.stderr.write('fake gh: unsupported ' + args.join(' ') + '\n');
process.exit(2);
