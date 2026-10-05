//! Updates from GitHub Releases (Velopack). A minute after start and every six
//! hours the app looks for a newer release and downloads it; Velopack applies
//! it the next time the app starts — or now, when you click Restart in the
//! dashboard. The CLI in the new package gets its own runtime copy then
//! (runtime.rs), and work web moves to it (a full work web replaces a running
//! one from another build).
//!
//! Where an update stands — `unmanaged` (a dev build: Velopack won't run),
//! `checking`, `current`, `downloading` (with how far), `ready`, `installing`,
//! `failed` — goes straight to the app's own window (`on_change`: main.rs
//! sends it as a `work-desktop` event, so the card shows the app's version
//! and a progress bar, whatever work web the window shows), and the window
//! asks for Check and Restart straight back (the sender `spawn` returns,
//! through main.rs's navigation hook). The same also goes through two files
//! in ~/.work, for a dashboard in a browser tab:
//! - `desktop-update.json` (written here);
//! - `desktop-request.json` (written by work web, read and removed here,
//!   every two seconds): `check` or `restart`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
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
    /// The version, and how far (0-100).
    Downloading(String, u8),
    Ready(String),
    /// Restart was asked: the app closes and Velopack puts this version in place.
    Installing(String),
    Failed(String),
}

/// The host the app's window asks on (`.invalid` never resolves: a page outside the app goes nowhere).
pub const ASK_HOST: &str = "work-desktop.invalid";

/// What the app's window asks for.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PageAsk {
    /// The page is up: send it the status.
    Hello,
    Check,
    Restart,
}

/// A navigation to http://work-desktop.invalid/<ask>, as an ask. Pure: anything else is none.
pub fn page_ask(host: Option<&str>, path: &str) -> Option<PageAsk> {
    if host != Some(ASK_HOST) {
        return None;
    }
    match path {
        "/hello" => Some(PageAsk::Hello),
        "/check" => Some(PageAsk::Check),
        "/restart" => Some(PageAsk::Restart),
        _ => None,
    }
}

/// Run before the page's own scripts on every load: it is in the app.
pub const PAGE_MARKER: &str = "window.__workDesktop = { app: true, update: null };";

/// The script that hands the page a status (status_json's text): kept for a
/// page that mounts later, and sent as a `work-desktop` event.
pub fn page_script(status_json: &str) -> String {
    format!(
        "window.__workDesktop = {{ app: true, update: {status_json} }}; window.dispatchEvent(new CustomEvent('work-desktop', {{ detail: {status_json} }}));"
    )
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
        State::Downloading(v, _) => ("downloading", Some(v.as_str()), None),
        State::Ready(v) => ("ready", Some(v.as_str()), None),
        State::Installing(v) => ("installing", Some(v.as_str()), None),
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
    if let State::Downloading(_, p) = state {
        s.push_str(&format!(",\"progress\":{}", (*p).min(100)));
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

/// Who hears about each change: main.rs sends it to the app's window.
static LISTENER: OnceLock<Box<dyn Fn(&str) + Send + Sync>> = OnceLock::new();
/// The latest status, for a page that just (re)loaded (it says hello).
static LATEST: Mutex<Option<String>> = Mutex::new(None);

/// Hear every change of where an update stands (its status JSON). Set once, by main.rs.
pub fn on_change(f: impl Fn(&str) + Send + Sync + 'static) {
    let _ = LISTENER.set(Box::new(f));
}

/// Tell the listener the latest status again (a page loaded and asked).
pub fn repeat_latest() {
    let latest = LATEST.lock().ok().and_then(|l| l.clone());
    if let (Some(json), Some(f)) = (latest, LISTENER.get()) {
        f(&json);
    }
}

#[derive(Clone)]
struct Reporter {
    file: Option<PathBuf>,
    version: String,
}

impl Reporter {
    fn set(&self, state: &State) {
        let json = status_json(&self.version, state, now_secs());
        if let Ok(mut l) = LATEST.lock() {
            *l = Some(json.clone());
        }
        if let Some(f) = LISTENER.get() {
            f(&json);
        }
        let Some(file) = &self.file else { return };
        // Temp then rename: work web never reads half a file.
        let tmp = file.with_extension("json.tmp");
        if fs::write(&tmp, &json).is_ok() {
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

/// Start the updater; the returned sender is the app window's way to ask (Check, Restart).
pub fn spawn(log: fn(&str), work_dir: Option<PathBuf>) -> Sender<Request> {
    let (asks, asked_rx): (Sender<Request>, Receiver<Request>) = mpsc::channel();
    thread::spawn(move || {
        let um = UpdateManager::new(GithubSource::new(REPO, None, false), None, None);
        let version = um.as_ref().map(|m| m.get_current_version_as_string()).unwrap_or_default();
        let reporter = Reporter { file: work_dir.as_ref().map(|d| d.join("desktop-update.json")), version };
        let requests = work_dir.as_ref().map(|d| d.join("desktop-request.json"));
        let um = match um {
            Ok(um) => um,
            Err(e) => {
                // A dev build isn't an installed app: say so to its own window, and
                // nothing runs. Not in the shared file: that's the installed app's,
                // which a dev build running beside it once overwrote.
                log(&format!("updates: not an installed app ({e})"));
                Reporter { file: None, ..reporter }.set(&State::Unmanaged);
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
            // The window's ask comes at once; a browser tab's file within two seconds.
            let asked = match asked_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(r) => Some(r),
                Err(RecvTimeoutError::Timeout) => requests.as_deref().and_then(take_request),
                Err(RecvTimeoutError::Disconnected) => {
                    thread::sleep(Duration::from_secs(2));
                    requests.as_deref().and_then(take_request)
                }
            };
            if asked == Some(Request::Restart) {
                match um.get_update_pending_restart() {
                    Some(asset) => {
                        log(&format!("updates: restarting into {}", asset.Version));
                        reporter.set(&State::Installing(asset.Version.clone()));
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
    asks
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
            reporter.set(&State::Downloading(to.clone(), 0));
            // Velopack reports how far (0-100) as it goes: each new percent goes to the window.
            let (tx, rx) = mpsc::channel::<i16>();
            let (r, v) = (reporter.clone(), to.clone());
            let progress = thread::spawn(move || {
                let mut last = 0u8;
                for p in rx {
                    let p = p.clamp(0, 100) as u8;
                    if p > last {
                        last = p;
                        r.set(&State::Downloading(v.clone(), p));
                    }
                }
            });
            let result = um.download_updates(&info, Some(tx));
            let _ = progress.join(); // the sender went with the download: the loop has ended
            match result {
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
    fn progress_and_installing_reach_the_page() {
        let d = status_json("2.0.2", &State::Downloading("2.0.3".into(), 45), 1);
        assert!(d.contains("\"state\":\"downloading\"") && d.contains("\"target\":\"2.0.3\"") && d.ends_with(",\"progress\":45}"));
        assert!(status_json("2.0.2", &State::Installing("2.0.3".into()), 1).contains("\"state\":\"installing\""));
        let js = page_script(&d);
        assert!(js.starts_with("window.__workDesktop = { app: true, update: {\"appVersion\":\"2.0.2\""));
        assert!(js.contains("new CustomEvent('work-desktop', { detail: {\"appVersion\""));
    }

    #[test]
    fn the_window_asks_on_its_own_host_only() {
        assert_eq!(page_ask(Some("work-desktop.invalid"), "/restart"), Some(PageAsk::Restart));
        assert_eq!(page_ask(Some("work-desktop.invalid"), "/check"), Some(PageAsk::Check));
        assert_eq!(page_ask(Some("work-desktop.invalid"), "/hello"), Some(PageAsk::Hello));
        assert_eq!(page_ask(Some("work-desktop.invalid"), "/rm"), None);
        // work web's own pages navigate as usual.
        assert_eq!(page_ask(Some("127.0.0.1"), "/restart"), None);
        assert_eq!(page_ask(None, "/restart"), None);
    }

    #[test]
    fn requests_are_check_or_restart_only() {
        assert_eq!(parse_request("{\"action\":\"check\",\"at\":1}"), Some(Request::Check));
        assert_eq!(parse_request("{ \"action\": \"restart\" }"), Some(Request::Restart));
        assert_eq!(parse_request("{\"action\":\"rm -rf\"}"), None);
        assert_eq!(parse_request("garbage"), None);
    }
}
