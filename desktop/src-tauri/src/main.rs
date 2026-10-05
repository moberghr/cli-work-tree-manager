// No console window next to the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The work web dashboard in its own window.
//!
//! The window shows a local "Starting…" page, finds the running work web
//! (`~/.work/web.url`, checked with GET /api/context), starts one in the
//! background when there is none (`work web --no-open`), then navigates to
//! it. Everything else is the same SPA the browser gets.
//!
//! Installed through Velopack, the app carries its own `work` CLI: it runs
//! from a copy under `~/.work/runtime` (runtime.rs), `work` / `wd` on PATH
//! point at it (path_setup.rs), and updates come from GitHub Releases
//! (updates.rs). A dev build has no bundled CLI and runs the `work` on PATH,
//! as does `WORK_DESKTOP_CLI=path`.
//!
//! `WORK_DESKTOP_URL` points it at a specific server instead (the latency
//! script uses a throwaway one).

mod path_setup;
mod runtime;
mod updates;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::cell::Cell;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{Url, WebviewUrl, WebviewWindowBuilder};

fn work_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(|h| PathBuf::from(h).join(".work"))
}

/// One line to ~/.work/desktop.log (release builds have no console).
fn log(msg: &str) {
    let Some(dir) = work_dir() else { return };
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("desktop.log")) {
        let _ = writeln!(f, "{secs} {msg}");
    }
}

fn recorded_pid() -> Option<u32> {
    std::fs::read_to_string(work_dir()?.join("web.pid")).ok()?.trim().parse().ok()
}

/// Is a process with this pid running? (`kill -0`.)
#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    match Command::new("kill").args(["-0", &pid.to_string()]).stdin(Stdio::null()).stderr(Stdio::null()).status() {
        Ok(s) => s.success(),
        Err(_) => true, // can't tell: assume it runs, never start a second one blind
    }
}

/// Is a process with this pid running? (tasklist, no console window.)
#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    let mut cmd = Command::new("tasklist");
    cmd.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match cmd.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")),
        Err(_) => true, // can't tell: assume it runs, never start a second one blind
    }
}

fn recorded_url() -> Option<String> {
    let text = std::fs::read_to_string(work_dir()?.join("web.url")).ok()?;
    let url = text.trim();
    (!url.is_empty()).then(|| url.to_string())
}

/// `http://127.0.0.1:49674/` → ("127.0.0.1:49674", address)
fn host_of(url: &str) -> Option<(String, SocketAddr)> {
    let rest = url.strip_prefix("http://")?;
    let host = rest.split('/').next()?.to_string();
    let addr = host.to_socket_addrs().ok()?.next()?;
    Some((host, addr))
}

/// Does a work web answer there? (Liveness, like `webServerResponds`.)
fn responds(url: &str) -> bool {
    let Some((host, addr)) = host_of(url) else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&addr, Duration::from_millis(800)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET /api/context HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut head = [0u8; 16];
    matches!(s.read(&mut head), Ok(n) if n >= 12 && head[..n].starts_with(b"HTTP/1.1 200"))
}

/// `work web --no-open`, from the bundled CLI's copy when there is one, else
/// the `work` on PATH.
fn start_work_web(rt: Option<&runtime::Runtime>) -> std::io::Result<()> {
    let mut cmd = match rt {
        Some(rt) => {
            let mut c = Command::new(&rt.node);
            c.arg(&rt.entry).args(["web", "--no-open"]);
            // Its PTY host and Claudes find `work` (the hooks run `work hook …`)
            // even before a new PATH reached this session: the launchers go
            // at the end, as on the user's PATH.
            if let (Some(path), Some(bin)) = (std::env::var_os("PATH"), work_dir().map(|d| d.join("bin"))) {
                let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
                if !dirs.contains(&bin) {
                    dirs.push(bin);
                }
                if let Ok(joined) = std::env::join_paths(dirs) {
                    c.env("PATH", joined);
                }
            }
            c
        }
        #[cfg(windows)]
        None => {
            let mut c = Command::new("cmd");
            // Constant argv: nothing user-supplied reaches the shell.
            c.args(["/C", "work", "web", "--no-open"]);
            c
        }
        #[cfg(not(windows))]
        None => {
            let mut c = Command::new("work");
            c.args(["web", "--no-open"]);
            c
        }
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ())
}

fn find_or_start_web(rt: Option<&runtime::Runtime>) -> Result<String, String> {
    if let Ok(url) = std::env::var("WORK_DESKTOP_URL") {
        return Ok(url);
    }
    if let Some(url) = recorded_url().filter(|u| responds(u)) {
        return Ok(url);
    }
    // Its process still runs: it is busy (a build, a big git scan), not gone.
    // Starting another then left two servers once the first recovered.
    if recorded_pid().is_some_and(pid_alive) {
        log("work web is not answering but its process runs: waiting for it");
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(500));
            if let Some(url) = recorded_url().filter(|u| responds(u)) {
                return Ok(url);
            }
            if !recorded_pid().is_some_and(pid_alive) {
                break; // it did go
            }
        }
        if recorded_pid().is_some_and(pid_alive) {
            return Err("work web is running but not answering.".into());
        }
    }
    log("no work web answering: starting one");
    start_work_web(rt).map_err(|e| {
        log(&format!("could not start work web: {e}"));
        match rt {
            Some(rt) => format!("Could not run the bundled <code>work web</code> ({}): {e}", rt.node.display()),
            None => format!("Could not run <code>work web</code>: {e}. Is <code>work</code> on PATH?"),
        }
    })?;
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(250));
        if let Some(url) = recorded_url().filter(|u| responds(u)) {
            return Ok(url);
        }
    }
    Err("<code>work web</code> did not come up within 25 s. Run it in a terminal to see why.".into())
}

/// A link the page opens in a new window (a PR, a Jira issue): in the user's
/// browser, not in another app window. Only http(s); explorer gets the URL as
/// one argument, no shell in between.
fn open_in_browser(url: &Url) {
    if url.scheme() != "http" && url.scheme() != "https" {
        log(&format!("not opening {url}: not an http(s) link"));
        return;
    }
    #[cfg(windows)]
    let r = Command::new("explorer").arg(url.as_str()).spawn();
    #[cfg(target_os = "macos")]
    let r = Command::new("open").arg(url.as_str()).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = Command::new("xdg-open").arg(url.as_str()).spawn();
    if let Err(e) = r {
        log(&format!("could not open {url}: {e}"));
    }
}

/// Register the Claude Code plugin (the `work` npm package's postinstall),
/// in the background: it may take a minute, and failing is fine.
fn register_plugin(rt: &runtime::Runtime) {
    let script = rt.entry.parent().and_then(|d| d.parent()).map(|d| d.join("scripts").join("postinstall.mjs"));
    let Some(script) = script.filter(|s| s.is_file()) else { return };
    let mut cmd = Command::new(&rt.node);
    cmd.arg(script).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    if let Err(e) = cmd.spawn() {
        log(&format!("could not register the Claude Code plugin: {e}"));
    }
}

fn main() {
    // Velopack first: an install, update or uninstall runs the app with a
    // hook argument, and this handles it and exits (Windows), or applies a
    // downloaded update and restarts.
    let first_run = Cell::new(false);
    let bin_dir = work_dir().map(|d| d.join("bin"));
    let mut app = velopack::VelopackApp::build().on_first_run(|_| first_run.set(true));
    #[cfg(windows)]
    {
        let (a, b, c) = (bin_dir.clone(), bin_dir.clone(), bin_dir.clone());
        app = app
            .on_after_install_fast_callback(move |_| {
                if let Some(d) = a {
                    path_setup::add(&d);
                }
            })
            .on_after_update_fast_callback(move |_| {
                if let Some(d) = b {
                    path_setup::add(&d);
                }
            })
            .on_before_uninstall_fast_callback(move |_| {
                if let Some(d) = c {
                    path_setup::remove(&d);
                }
            });
    }
    app.run();
    let first_run = first_run.get();
    updates::spawn(log, work_dir());

    tauri::Builder::default()
        .setup(move |app| {
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("work")
                .inner_size(1480.0, 940.0)
                .min_inner_size(720.0, 480.0)
                // Tauri's own drop handler (for dropping files on the window)
                // switches off the page's HTML5 drag and drop on Windows — the
                // sessions list is reordered by dragging.
                .disable_drag_drop_handler()
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    tauri::webview::NewWindowResponse::Deny
                });
            // For scripts/terminal-latency.ts: a DevTools port to drive the page through. Tauri sets
            // WebView2's browser arguments itself, which overrides WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
            // so it goes here (with the flags wry passes by default).
            // Its own WebView2 profile, too: one browser process owns a profile folder, and a window
            // already open with other arguments would refuse this one.
            if let Ok(port) = std::env::var("WORK_DESKTOP_CDP_PORT") {
                if let Ok(port) = port.parse::<u16>() {
                    builder = builder
                        .data_directory(std::env::temp_dir().join(format!("work-desktop-cdp-{port}")))
                        .additional_browser_args(&format!(
                            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                        ));
                }
            }
            let window = builder.build()?;
            let bin_dir = bin_dir.clone();
            thread::spawn(move || {
                // The bundled CLI's copy (after an update this copies the new
                // one: a few seconds), the launchers, and PATH.
                let rt = match work_dir() {
                    Some(dir) => {
                        let _ = window.eval("document.getElementById('msg') && (document.getElementById('msg').textContent = 'Setting up work…');");
                        match runtime::prepare(&dir) {
                            Ok(rt) => rt,
                            Err(e) => {
                                log(&format!("bundled CLI: {e}"));
                                None
                            }
                        }
                    }
                    None => None,
                };
                if let Some(rt) = &rt {
                    log(&format!("bundled CLI {} at {}", rt.version, rt.node.display()));
                    if let Some(bin) = &bin_dir {
                        path_setup::add(bin);
                    }
                    if first_run {
                        register_plugin(rt);
                    }
                }
                let rt = rt.as_ref();
                let mut current = match find_or_start_web(rt) {
                    Ok(u) => u,
                    Err(msg) => {
                        let js = format!("document.getElementById('msg').innerHTML = {:?};", msg);
                        let _ = window.eval(&js);
                        return;
                    }
                };
                log(&format!("showing {current}"));
                if let Ok(url) = Url::parse(&current) {
                    let _ = window.navigate(url);
                }
                if std::env::var("WORK_DESKTOP_URL").is_ok() {
                    return; // pointed at one server on purpose (the latency script)
                }
                // Follow work web: a restart (after a rebuild, `work web --stop`, a crash)
                // comes back on another port. Keep the place in the app (the #route).
                let mut misses = 0;
                loop {
                    thread::sleep(Duration::from_secs(2));
                    if responds(&current) {
                        misses = 0;
                        continue;
                    }
                    // One slow answer isn't a dead server.
                    misses += 1;
                    if misses < 3 {
                        continue;
                    }
                    misses = 0;
                    log(&format!("{current} stopped answering"));
                    let next = match find_or_start_web(rt) {
                        Ok(n) => n,
                        Err(e) => {
                            log(&format!("no work web yet: {e}"));
                            continue;
                        }
                    };
                    log(&format!("following work web to {next}"));
                    if next == current && responds(&current) {
                        continue;
                    }
                    let fragment = window.url().ok().and_then(|u| u.fragment().map(str::to_string));
                    if let Ok(mut url) = Url::parse(&next) {
                        url.set_fragment(fragment.as_deref());
                        let _ = window.navigate(url);
                    }
                    current = next;
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the work window");
}
