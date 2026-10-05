# Git & Workflow (§8)

- **§8.1** [CONVENTION] Branches use hierarchical `type/slug` names: `feat/`, `fix/`, `docs/`, `feature/`. Evidence: `git branch -a` (`feat/copy-dot-files`, `docs/readme-and-github-pages`, `feature/resume-expanded`).
- **§8.2** [CONVENTION] Work merges to `main` via PR (`git log` shows "Merge pull request #N from …").
- **§8.3** [CONVENTION] Commit subjects are imperative and descriptive ("Add interactive review mode", "Fix concurrent history wipe"); conventional `type:` prefixes are not used in history — match the existing imperative style.
- **§8.4** [ENFORCED] The release tag is the version (`scripts/version.mjs`, like bearing's MinVer): DO NOT edit `package.json`'s version (it stays `0.0.0-dev`, `tests/packaging/version.test.ts`). `release.yml` sets it from the tag; a local build takes it from `git describe` (`2.0.2-dev.3+sha` past `v2.0.1`).
