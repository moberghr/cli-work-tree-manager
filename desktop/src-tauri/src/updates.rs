//! Updates from GitHub Releases (Velopack). A minute after start and every six
//! hours the app looks for a newer release and downloads it; Velopack applies
//! it the next time the app starts. The CLI in the new package gets its own
//! runtime copy then (runtime.rs), and work web moves to it (a full work web
//! replaces a running one from another build).
//!
//! A dev build isn't an installed app: UpdateManager refuses, and nothing runs.

use std::thread;
use std::time::Duration;

use velopack::sources::GithubSource;
use velopack::{UpdateCheck, UpdateManager};

pub const REPO: &str = "https://github.com/moberghr/cli-work-tree-manager";

pub fn spawn(log: fn(&str)) {
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(60));
        loop {
            check_once(log);
            thread::sleep(Duration::from_secs(6 * 3600));
        }
    });
}

fn check_once(log: fn(&str)) {
    // No token: the repo is public (60 GitHub API calls an hour per address is plenty here).
    let um = match UpdateManager::new(GithubSource::new(REPO, None, false), None, None) {
        Ok(um) => um,
        Err(e) => {
            log(&format!("updates: not an installed app ({e})"));
            return;
        }
    };
    if um.get_update_pending_restart().is_some() {
        return; // downloaded already: applies on the next start
    }
    match um.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(info)) => {
            let to = info.TargetFullRelease.Version.clone();
            match um.download_updates(&info, None) {
                Ok(()) => log(&format!("updates: {to} downloaded; it applies when the app next starts")),
                Err(e) => log(&format!("updates: downloading {to} failed: {e}")),
            }
        }
        Ok(_) => {}
        Err(e) => log(&format!("updates: check failed: {e}")),
    }
}
