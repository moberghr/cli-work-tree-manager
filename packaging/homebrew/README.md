# Distribution

Two supported install channels. `work.rb` here is the **canonical source** of the
Homebrew formula — the tap repo holds a copy.

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
