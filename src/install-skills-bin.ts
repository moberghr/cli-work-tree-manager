// npm's postinstall (scripts/postinstall.mjs) runs this, not the whole CLI:
// the CLI's startup installs its logger and writes ~/.work/debug.log, which
// an install must not (`sudo npm i -g` would leave ~/.work owned by root).
import { runInstallSkills } from './commands/install-skills.js';

await runInstallSkills();
