# Git & Workflow (§8)

- **§8.1** [CONVENTION] Branches use hierarchical `type/slug` names: `feat/`, `fix/`, `docs/`, `feature/`. Evidence: `git branch -a` (`feat/copy-dot-files`, `docs/readme-and-github-pages`, `feature/resume-expanded`).
- **§8.2** [CONVENTION] Work merges to `main` via PR (`git log` shows "Merge pull request #N from …").
- **§8.3** [CONVENTION] Commit subjects are imperative and descriptive ("Add interactive review mode", "Fix concurrent history wipe"); conventional `type:` prefixes are not used in history — match the existing imperative style.
- **§8.4** [CONVENTION] Version bumps accompany feature commits (`bump to 1.3.0`); keep `package.json` version in step when shipping user-facing changes.
