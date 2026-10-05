# Distribution

Three install channels. `work.rb` and `work-desktop.rb` here are the **canonical source** of the
Homebrew formula and cask — the tap repo holds copies.

## 1. npm (baseline)

```bash
npm install -g @moberg_hr/work-tree     # installs `work` and `wd`
```

Publishing:

```bash
npm publish                  # prepublishOnly runs the build automatically
```

`files: ["dist"]` in package.json means only `dist/` (both bundled binaries +
the web SPA), `README.md`, and `LICENSE` ship — verify with
`npm pack --dry-run` before publishing.

> `node-pty` is a native addon. `npm install -g` compiles it on the user's
> machine unless a prebuilt binary matches their platform/arch/Node version.
> Users without a C/C++ toolchain (Xcode Command Line Tools / build-essential /
> VS Build Tools) may see an install failure here.

## 2. Homebrew tap (macOS / Linux)

End users:

```bash
brew install moberghr/work-tree/work    # provides `work` and `wd`
```

### One-time: create the tap repo

The tap must be a GitHub repo named `homebrew-work-tree` under the `moberghr`
org (the `homebrew-` prefix is required; `brew` strips it).

```bash
gh repo create moberghr/homebrew-work-tree --public
git clone https://github.com/moberghr/homebrew-work-tree
mkdir -p homebrew-work-tree/Formula
cp packaging/homebrew/work.rb homebrew-work-tree/Formula/work.rb
```

### Each release: publish to npm, then update the formula

The formula installs the **published npm tarball**, so publish first, then point
the formula at the new version and its sha256:

```bash
# 1. publish (see channel 1 above)
npm publish

# 2. compute the sha256 of the published tarball
VERSION=$(node -p "require('./package.json').version")
URL="https://registry.npmjs.org/@moberg_hr/work-tree/-/work-tree-${VERSION}.tgz"
SHA=$(curl -sL "$URL" | shasum -a 256 | cut -d' ' -f1)
echo "url $URL"
echo "sha256 $SHA"

# 3. edit Formula/work.rb in the tap with the new url + sha256, commit, push.
# 4. verify:
brew install --build-from-source moberghr/work-tree/work
brew test work
brew audit --strict --online work
```

Because the formula `depends_on "node"` and `npm install` compiles `node-pty`,
Homebrew builds the native addon at install time — Xcode CLT (macOS) or a build
toolchain (Linux) is required, same caveat as the npm channel.

## 3. Homebrew cask: the desktop app (macOS, Apple silicon)

End users:

```bash
brew install --cask moberghr/work-tree/work-desktop    # /Applications/work.app
```

`work-desktop.rb` here is the canonical cask. It installs the release's
`WorkDesktop-osx-Portable.zip` (Velopack's `work.app`, with the CLI inside it).
The release workflow's desktop job, on macOS, fills in the version and the
sha256 of the zip it just uploaded and writes the result to the tap as
`Casks/work-desktop.rb` (created on the first release; the same
`HOMEBREW_TAP_TOKEN`). Nothing to edit by hand per release.

- `auto_updates true`: Velopack updates the app itself, so `brew upgrade`
  leaves it alone (`brew upgrade --greedy` reinstalls the latest).
- The app is ad-hoc signed, not notarized, so the cask's `postflight_steps`
  removes the quarantine Homebrew puts on it; otherwise Gatekeeper refuses to
  open it. Drop that step once `SIGN_APP_IDENTITY` / `NOTARY_PROFILE` are set
  for `desktop/scripts/velopack.mjs`.
- `brew uninstall --zap` removes only what the app writes (`~/.work/runtime`,
  `~/.work/bin`, its `desktop-*` files, its `~/Library` folders), never the
  state the CLI shares (`state.db`, `config.json`, conversations).

Check a change locally from a throwaway tap:

```bash
brew tap-new --no-git you/test
T="$(brew --repository)/Library/Taps/you/homebrew-test"; mkdir -p "$T/Casks"
# a copy with a published version + the sha256 of its WorkDesktop-osx-Portable.zip
sed -E -e 's#^( *version )".*"#\1"2.0.0"#' -e 's#^( *sha256 )".*"#\1"<sha>"#' \
  packaging/homebrew/work-desktop.rb > "$T/Casks/work-desktop.rb"
brew style --cask you/test/work-desktop
brew install --cask you/test/work-desktop
brew uninstall --cask you/test/work-desktop && brew untap you/test
```
