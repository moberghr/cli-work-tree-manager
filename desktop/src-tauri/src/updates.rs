//! Updates from GitHub Releases (Velopack). A minute after start and every six
//! hours the app looks for a newer release and downloads it; Velopack applies
//! it the next time the app starts — or now, when you click Restart in the
//! dashboard. The CLI in the new package gets its own runtime copy then
//! (runtime.rs), and work web moves to it (a full work web replaces a running
//! one from another build).
//!
//! The dashboard is work web's page, not this app's, so the two talk through
//! two files in ~/.work:
//! - `desktop-update.json` (written here): this app's version and where an
//!   update stands — `unmanaged` (a dev build: Velopack won't run), `checking`,
//!   `current`, `downloading`, `ready` (with the version), `failed`.
//! - `desktop-request.json` (written by work web, read and removed here,
//!   every two seconds): `check` (Check for updates) or `restart` (apply the
//!   downloaded update now).

use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use velopack::sources::GithubSource;
use velopack::{UpdateCheck, UpdateManager};

pub const REPO: &str = "https://github.com/moberghr/cli-work-tree-manager";

/// How often it looks by itself.
const EVERY: Duration = Duration::from_secs(6 * 3600);
/// The first look, after start.
const FIRST: Duration = Duration::from_secs(60);

/// Where an update stands, as the dashboard reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum State {
    Unmanaged,
    Checking,
    Current,
    Downloading(String),
    Ready(String),
    Failed(String),
}

/// What the dashboard asked for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Request {
    Check,
    Restart,
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The status file's text (JSON). Pure.
pub fn status_json(app_version: &str, state: &State, at_secs: u64) -> String {
    let (name, target, error) = match state {
        State::Unmanaged => ("unmanaged", None, None),
        State::Checking => ("checking", None, None),
        State::Current => ("current", None, None),
        State::Downloading(v) => ("downloading", Some(v.as_str()), None),
        State::Ready(v) => ("ready", Some(v.as_str()), None),
        State::Failed(e) => ("failed", None, Some(e.as_str())),
    };
    let mut s = format!(
        "{{\"appVersion\":\"{}\",\"state\":\"{}\",\"at\":{},\"pid\":{}",
        escape(app_version),
        name,
        at_secs,
        std::process::id()
    );
    if let Some(t) = target {
        s.push_str(&format!(",\"target\":\"{}\"", escape(t)));
    }
    if let Some(e) = error {
        s.push_str(&format!(",\"error\":\"{}\"", escape(e)));
    }
    s.push('}');
    s
}

/// A request file's action. Pure: anything else is ignored.
pub fn parse_request(text: &str) -> Option<Request> {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    if compact.contains("\"action\":\"check\"") {
        Some(Request::Check)
    } else if compact.contains("\"action\":\"restart\"") {
        Some(Request::Restart)
    } else {
        None
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

struct Reporter {
    file: Option<PathBuf>,
    version: String,
}

impl Reporter {
    fn set(&self, state: &State) {
        let Some(file) = &self.file else { return };
        // Temp then rename: work web never reads half a file.
        let tmp = file.with_extension("json.tmp");
        if fs::write(&tmp, status_json(&self.version, state, now_secs())).is_ok() {
            let _ = fs::rename(&tmp, file);
        }
    }
}

/// Take the dashboard's request, if any (the file is removed, so it runs once).
fn take_request(file: &Path) -> Option<Request> {
    let text = fs::read_to_string(file).ok()?;
    let _ = fs::remove_file(file);
    parse_request(&text)
}

pub fn spawn(log: fn(&str), work_dir: Option<PathBuf>) {
    thread::spawn(move || {
        let um = UpdateManager::new(GithubSource::new(REPO, None, false), None, None);
        let version = um.as_ref().map(|m| m.get_current_version_as_string()).unwrap_or_default();
        let reporter = Reporter { file: work_dir.as_ref().map(|d| d.join("desktop-update.json")), version };
        let requests = work_dir.as_ref().map(|d| d.join("desktop-request.json"));
        let um = match um {
            Ok(um) => um,
            Err(e) => {
                // A dev build isn't an installed app: say so, and nothing runs.
                log(&format!("updates: not an installed app ({e})"));
                reporter.set(&State::Unmanaged);
                return;
            }
        };
        if let Some(asset) = um.get_update_pending_restart() {
            reporter.set(&State::Ready(asset.Version.clone()));
        } else {
            reporter.set(&State::Current);
        }
        let started = Instant::now();
        let mut next = started + FIRST;
        loop {
            thread::sleep(Duration::from_secs(2));
            let asked = requests.as_deref().and_then(take_request);
            if asked == Some(Request::Restart) {
                match um.get_update_pending_restart() {
                    Some(asset) => {
                        log(&format!("updates: restarting into {}", asset.Version));
                        // Exits this app; Velopack applies the update and starts it again.
                        // work web and the PTY host run from ~/.work/runtime, so they stay.
                        if let Err(e) = um.apply_updates_and_restart(&asset) {
                            log(&format!("updates: applying {} failed: {e}", asset.Version));
                            reporter.set(&State::Failed(format!("applying {}: {e}", asset.Version)));
                        }
                    }
                    None => reporter.set(&State::Current),
                }
                continue;
            }
            if asked == Some(Request::Check) || Instant::now() >= next {
                next = Instant::now() + EVERY;
                check_once(&um, &reporter, log);
            }
        }
    });
}

fn check_once(um: &UpdateManager, reporter: &Reporter, log: fn(&str)) {
    if let Some(asset) = um.get_update_pending_restart() {
        reporter.set(&State::Ready(asset.Version.clone()));
        return; // downloaded already: applies on the next start, or on Restart
    }
    reporter.set(&State::Checking);
    match um.check_for_updates() {
        Ok(UpdateCheck::UpdateAvailable(info)) => {
            let to = info.TargetFullRelease.Version.clone();
            reporter.set(&State::Downloading(to.clone()));
            match um.download_updates(&info, None) {
                Ok(()) => {
                    log(&format!("updates: {to} downloaded; it applies on Restart or when the app next starts"));
                    reporter.set(&State::Ready(to));
                }
                Err(e) => {
                    log(&format!("updates: downloading {to} failed: {e}"));
                    reporter.set(&State::Failed(format!("downloading {to}: {e}")));
                }
            }
        }
        Ok(_) => reporter.set(&State::Current),
        Err(e) => {
            log(&format!("updates: check failed: {e}"));
            reporter.set(&State::Failed(format!("checking: {e}")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_says_where_the_update_stands() {
        let s = status_json("2.1.0", &State::Ready("2.2.0".into()), 7);
        assert!(s.starts_with("{\"appVersion\":\"2.1.0\",\"state\":\"ready\",\"at\":7,\"pid\":"));
        assert!(s.ends_with(",\"target\":\"2.2.0\"}"));
        let f = status_json("2.1.0", &State::Failed("no \"network\"\n".into()), 1);
        assert!(f.contains("\"state\":\"failed\""));
        assert!(f.contains("\"error\":\"no \\\"network\\\"\\n\""));
        assert!(status_json("", &State::Unmanaged, 0).contains("\"state\":\"unmanaged\""));
    }

    #[test]
    fn requests_are_check_or_restart_only() {
        assert_eq!(parse_request("{\"action\":\"check\",\"at\":1}"), Some(Request::Check));
        assert_eq!(parse_request("{ \"action\": \"restart\" }"), Some(Request::Restart));
        assert_eq!(parse_request("{\"action\":\"rm -rf\"}"), None);
        assert_eq!(parse_request("garbage"), None);
    }
}
