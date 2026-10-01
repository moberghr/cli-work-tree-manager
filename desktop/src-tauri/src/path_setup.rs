//! Putting `~/.work/bin` (the `work` / `wd` launchers, runtime.rs) on the
//! user's PATH, at the END: an npm-installed `work` that is already there keeps
//! coming first. Best effort throughout — a PATH that can't be edited means
//! typing the launcher's full path, a smaller problem than an app that won't
//! start.
//!
//! Windows: the user's PATH in `HKCU\Environment`, read and written raw so
//! `%SystemRoot%`-style entries stay unexpanded (reading it expanded and writing
//! that back is how installers corrupt a PATH), then a WM_SETTINGCHANGE so new
//! terminals see it. Added at install and on every start, removed on uninstall.
//!
//! macOS / Linux: a marked line in the shell profiles, added on every start.

use std::path::Path;

/// Marks the profile line this app adds.
#[cfg_attr(windows, allow(dead_code))]
pub const PROFILE_MARK: &str = "# added by the work app";

#[cfg_attr(not(windows), allow(dead_code))]
fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).to_string();
    if cfg!(windows) {
        norm(a).eq_ignore_ascii_case(&norm(b))
    } else {
        norm(a) == norm(b)
    }
}

/// `path` with `dir` appended, or None when it is already there.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn with_entry(path: &str, dir: &str, sep: char) -> Option<String> {
    if path.split(sep).any(|p| same_dir(p, dir)) {
        return None;
    }
    let trimmed = path.trim_end_matches(sep);
    Some(if trimmed.is_empty() { dir.to_string() } else { format!("{trimmed}{sep}{dir}") })
}

/// `path` without any copy of `dir`, or None when it wasn't there.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn without_entry(path: &str, dir: &str, sep: char) -> Option<String> {
    let kept: Vec<&str> = path.split(sep).filter(|p| !same_dir(p, dir)).collect();
    let next = kept.join(&sep.to_string());
    (next != path).then_some(next)
}

/// A profile's text with the PATH line added, or None when it has it.
#[cfg_attr(windows, allow(dead_code))]
pub fn with_profile_line(text: &str) -> Option<String> {
    if text.contains(PROFILE_MARK) {
        return None;
    }
    let line = format!("export PATH=\"$PATH:$HOME/.work/bin\" {PROFILE_MARK}\n");
    Some(if text.is_empty() || text.ends_with('\n') { format!("{text}{line}") } else { format!("{text}\n{line}") })
}

#[cfg(windows)]
mod windows {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::{RegKey, RegValue};

    fn read_path(key: &RegKey) -> (String, winreg::enums::RegType) {
        match key.get_raw_value("Path") {
            Ok(v) => {
                let wide: Vec<u16> = v.bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                let text = String::from_utf16_lossy(&wide).trim_end_matches('\0').to_string();
                (text, v.vtype)
            }
            // None yet: a PATH is REG_EXPAND_SZ, so later %VARS% added to it resolve.
            Err(_) => (String::new(), winreg::enums::RegType::REG_EXPAND_SZ),
        }
    }

    pub fn edit(change: impl Fn(&str) -> Option<String>) -> bool {
        let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags("Environment", KEY_READ | KEY_WRITE) else { return false };
        let (path, vtype) = read_path(&key);
        let Some(next) = change(&path) else { return false };
        let mut bytes: Vec<u8> = next.encode_utf16().chain(std::iter::once(0)).flat_map(|u| u.to_le_bytes()).collect();
        bytes.shrink_to_fit();
        if key.set_raw_value("Path", &RegValue { bytes, vtype }).is_err() {
            return false;
        }
        broadcast();
        true
    }

    /// Tell Explorer (and through it, new terminals) the environment changed.
    fn broadcast() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};
        let what: Vec<u16> = "Environment".encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0usize;
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, what.as_ptr() as isize, SMTO_ABORTIFHUNG, 5000, &mut result);
        }
    }
}

/// Add `bin` to the end of the user's PATH. Returns whether anything changed.
pub fn add(bin: &Path) -> bool {
    let dir = bin.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        windows::edit(|p| with_entry(p, &dir, ';'))
    }
    #[cfg(not(windows))]
    {
        let _ = dir;
        add_to_profiles()
    }
}

/// Take `bin` off the user's PATH (Windows uninstall). Elsewhere the profile
/// line stays: it names a folder, and a PATH entry for a missing one is harmless.
pub fn remove(bin: &Path) -> bool {
    #[cfg(windows)]
    {
        let dir = bin.to_string_lossy().into_owned();
        windows::edit(|p| without_entry(p, &dir, ';'))
    }
    #[cfg(not(windows))]
    {
        let _ = bin;
        false
    }
}

#[cfg(not(windows))]
fn add_to_profiles() -> bool {
    use std::fs;
    let Some(home) = std::env::var_os("HOME").map(std::path::PathBuf::from) else { return false };
    // The shell's own startup files that exist, plus the default one for the platform.
    let default = if cfg!(target_os = "macos") { ".zshrc" } else { ".profile" };
    let mut changed = false;
    for name in [".zshrc", ".bashrc", ".bash_profile", ".profile"] {
        let file = home.join(name);
        if !file.exists() && name != default {
            continue;
        }
        let text = fs::read_to_string(&file).unwrap_or_default();
        if let Some(next) = with_profile_line(&text) {
            changed |= fs::write(&file, next).is_ok();
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_once_at_the_end() {
        assert_eq!(with_entry(r"%SystemRoot%\system32;C:\npm", r"C:\Users\d\.work\bin", ';').as_deref(), Some(r"%SystemRoot%\system32;C:\npm;C:\Users\d\.work\bin"));
        assert_eq!(with_entry(r"C:\npm;", r"C:\x", ';').as_deref(), Some(r"C:\npm;C:\x"));
        assert_eq!(with_entry("", r"C:\x", ';').as_deref(), Some(r"C:\x"));
        assert_eq!(with_entry(r"C:\npm;C:\x\", r"C:\x", ';'), None);
    }

    #[test]
    fn removes_every_copy_and_only_it() {
        assert_eq!(without_entry(r"C:\a;C:\x;C:\b;C:\x", r"C:\x", ';').as_deref(), Some(r"C:\a;C:\b"));
        assert_eq!(without_entry(r"C:\a;C:\b", r"C:\x", ';'), None);
    }

    #[test]
    fn profile_line_once() {
        let once = with_profile_line("alias ll='ls -l'").unwrap();
        assert!(once.starts_with("alias ll='ls -l'\nexport PATH=\"$PATH:$HOME/.work/bin\""));
        assert_eq!(with_profile_line(&once), None);
        assert!(with_profile_line("").unwrap().starts_with("export PATH"));
    }
}
