// No console window next to the app in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Spike: the work web dashboard in its own window.
//!
//! The window shows a local "Starting…" page, finds the running work web
//! (`~/.work/web.url`, checked with GET /api/context), starts one in the
//! background when there is none (`work web --no-open`), then navigates to
//! it. Everything else is the same SPA the browser gets.
//!
//! `WORK_DESKTOP_URL` points it at a specific server instead (the latency
//! script uses a throwaway one).

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
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

fn start_work_web() -> std::io::Result<()> {
    let mut cmd = Command::new("cmd");
    // Constant argv: nothing user-supplied reaches the shell.
    cmd.args(["/C", "work", "web", "--no-open"])
        .stdin(Stdio::null())
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

fn find_or_start_web() -> Result<String, String> {
    if let Ok(url) = std::env::var("WORK_DESKTOP_URL") {
        return Ok(url);
    }
    if let Some(url) = recorded_url().filter(|u| responds(u)) {
        return Ok(url);
    }
    start_work_web().map_err(|e| format!("Could not run <code>work web</code>: {e}. Is <code>work</code> on PATH?"))?;
    let deadline = Instant::now() + Duration::from_secs(25);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(250));
        if let Some(url) = recorded_url().filter(|u| responds(u)) {
            return Ok(url);
        }
    }
    Err("<code>work web</code> did not come up within 25 s. Run it in a terminal to see why.".into())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("work")
                .inner_size(1480.0, 940.0)
                .min_inner_size(720.0, 480.0);
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
            thread::spawn(move || match find_or_start_web().and_then(|u| Url::parse(&u).map_err(|e| e.to_string())) {
                Ok(url) => {
                    let _ = window.navigate(url);
                }
                Err(msg) => {
                    let js = format!("document.getElementById('msg').innerHTML = {:?};", msg);
                    let _ = window.eval(&js);
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the work window");
}
