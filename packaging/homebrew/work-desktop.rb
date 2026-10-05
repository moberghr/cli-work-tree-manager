cask "work-desktop" do
  # The release workflow (release.yml, the desktop job on macOS) fills in the
  # version and sha256 and pushes this file to the tap as Casks/work-desktop.rb.
  version "0.0.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/moberghr/cli-work-tree-manager/releases/download/v#{version}/WorkDesktop-osx-Portable.zip"
  name "work"
  desc "Desktop app for the work Git worktree manager, with the work CLI inside"
  homepage "https://github.com/moberghr/cli-work-tree-manager"

  livecheck do
    url :url
    strategy :github_latest
  end

  # Velopack updates the app in place; `brew upgrade` leaves it to that.
  auto_updates true
  depends_on arch: :arm64
  depends_on :macos

  app "work.app"

  # Not notarized yet (no Developer ID): without this, Gatekeeper refuses to
  # open the app Homebrew quarantined. Installing from this tap is the trust.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/work.app"]
  end

  uninstall quit: "hr.moberg.work-desktop"

  # Only what the app itself writes. ~/.work also holds the CLI's state
  # (state.db, config.json, conversations), which the `work` formula shares.
  # The PATH line the app adds to ~/.zshrc etc. ("# added by the work app")
  # stays; with ~/.work/bin gone it finds nothing.
  zap trash: [
    "~/.work/bin",
    "~/.work/desktop-request.json",
    "~/.work/desktop-update.json",
    "~/.work/desktop.log",
    "~/.work/runtime",
    "~/Library/Application Support/hr.moberg.work-desktop",
    "~/Library/Caches/hr.moberg.work-desktop",
    "~/Library/Caches/velopack/WorkDesktop",
    "~/Library/HTTPStorages/hr.moberg.work-desktop",
    "~/Library/Logs/velopack_WorkDesktop.log",
    "~/Library/Saved Application State/hr.moberg.work-desktop.savedState",
    "~/Library/WebKit/hr.moberg.work-desktop",
  ]
end
