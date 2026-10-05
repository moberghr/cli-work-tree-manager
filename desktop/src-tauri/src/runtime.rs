//! The `work` CLI the app ships with, and where it runs from.
//!
//! The package carries the CLI next to the app as one `cli.zip` (a Node
//! runtime, `dist/` and the production `node_modules`, staged by
//! `scripts/stage-cli.mjs`; a `cli/` folder in packages before 2.0.2). It does
//! not RUN from there: an update replaces the install folder, and on Windows
//! Velopack stops whatever still runs from it — work web, and the PTY host that
//! owns every Claude. So the app unpacks the CLI to `~/.work/runtime/<version>/`
//! and starts it from there; an update only adds the next copy beside it.
//! `~/.work/runtime/current` names the copy `work` / `wd` use: launchers in
//! `~/.work/bin`, which the app puts at the END of PATH (path_setup.rs), so an
//! npm-installed `work` keeps coming first.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The copy work web is started from.
pub struct Runtime {
    pub node: PathBuf,
    pub entry: PathBuf,
    pub version: String,
}

const NODE: &str = if cfg!(windows) { "node.exe" } else { "node" };
/// Old copies kept besides the current one (a PTY host started weeks ago may still run one).
const KEEP_OLD: usize = 2;

/// The CLI the package carries, next to the app's executable: `cli.zip` with
/// its version in `cli.version` (from 2.0.2: one file for an update to write,
/// where a `cli/` folder of ~1,650 took Velopack and the antivirus a minute
/// and a half), or the `cli/` folder of a package from before.
enum Bundled {
    Zip(PathBuf),
    Dir(PathBuf),
}

/// What `exe_dir` carries, and the file holding its version.
fn bundled_in(exe_dir: &Path) -> Option<(Bundled, PathBuf)> {
    let (zip, version) = (exe_dir.join("cli.zip"), exe_dir.join("cli.version"));
    if zip.is_file() && version.is_file() {
        return Some((Bundled::Zip(zip), version));
    }
    let dir = exe_dir.join("cli");
    (dir.join("VERSION").is_file() && dir.join(NODE).is_file() && dir.join("dist").join("bin.js").is_file())
        .then(|| (Bundled::Dir(dir.clone()), dir.join("VERSION")))
}

/// Unpack `zip` (the stored zip stage-cli.mjs writes) into `to`. The zip
/// crate keeps every name inside `to` and restores Unix modes.
fn unzip(zip: &Path, to: &Path) -> Result<(), String> {
    let file = fs::File::open(zip).map_err(|e| format!("opening {}: {e}", zip.display()))?;
    let mut archive = ::zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("reading {}: {e}", zip.display()))?;
    archive.extract(to).map_err(|e| format!("unpacking {}: {e}", zip.display()))
}

/// A version is a folder name: digits, letters, dots, `+` and `-` only.
pub fn valid_version(v: &str) -> bool {
    !v.is_empty() && v.len() <= 64 && !v.starts_with('.') && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-'))
}

/// Make sure the bundled CLI has its copy under `work_dir/runtime`, and that
/// `current` and the launchers point at it. `Ok(None)`: not a packaged app (a
/// dev build), or `WORK_DESKTOP_CLI=path` asked for the `work` on PATH.
pub fn prepare(work_dir: &Path) -> Result<Option<Runtime>, String> {
    if std::env::var("WORK_DESKTOP_CLI").is_ok_and(|v| v == "path") {
        return Ok(None);
    }
    let Some(exe_dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else { return Ok(None) };
    prepare_from(&exe_dir, work_dir)
}

/// `prepare`, with the CLI the app at `exe_dir` carries.
fn prepare_from(exe_dir: &Path, work_dir: &Path) -> Result<Option<Runtime>, String> {
    let Some((src, version_file)) = bundled_in(exe_dir) else { return Ok(None) };
    let version = fs::read_to_string(&version_file).map_err(|e| format!("reading the bundled CLI's version: {e}"))?;
    let version = version.trim().to_string();
    if !valid_version(&version) {
        return Err(format!("the bundled CLI has an odd version: {version:?}"));
    }
    let root = work_dir.join("runtime");
    let dest = root.join(&version);
    if !dest.join("dist").join("bin.js").is_file() {
        fs::create_dir_all(&root).map_err(|e| format!("creating {}: {e}", root.display()))?;
        // Unpacked (or copied) under a temporary name and renamed into place:
        // one cut short (the app closed, the disk filled) never looks complete.
        let tmp = root.join(format!("{version}.tmp-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        match &src {
            Bundled::Zip(zip) => unzip(zip, &tmp)?,
            Bundled::Dir(dir) => copy_dir(dir, &tmp).map_err(|e| format!("copying the CLI to {}: {e}", tmp.display()))?,
        }
        if !(tmp.join(NODE).is_file() && tmp.join("dist").join("bin.js").is_file()) {
            let _ = fs::remove_dir_all(&tmp);
            return Err("the bundled CLI is incomplete (no Node or no dist/bin.js)".into());
        }
        if fs::rename(&tmp, &dest).is_err() {
            // Another start of the app got there first.
            let _ = fs::remove_dir_all(&tmp);
            if !dest.join("dist").join("bin.js").is_file() {
                return Err(format!("could not put the CLI at {}", dest.display()));
            }
        }
    }
    write_if_changed(&root.join("current"), &version).map_err(|e| format!("writing runtime/current: {e}"))?;
    write_launchers(&work_dir.join("bin")).map_err(|e| format!("writing the work launchers: {e}"))?;
    prune(&root, &version);
    Ok(Some(Runtime { node: dest.join(NODE), entry: dest.join("dist").join("bin.js"), version }))
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else if kind.is_symlink() {
            // node_modules/.bin links on macOS/Linux: kept as links. Nothing
            // the CLI runs needs them on Windows.
            #[cfg(unix)]
            std::os::unix::fs::symlink(fs::read_link(entry.path())?, &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn write_if_changed(path: &Path, text: &str) -> std::io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|t| t == text) {
        return Ok(());
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::File::create(&tmp)?.write_all(text.as_bytes())?;
    fs::rename(&tmp, path)
}

/// `work` and `wd`, each running the copy `runtime/current` names.
pub fn launcher(script: &str) -> String {
    if cfg!(windows) {
        // %USERPROFILE% is where `work` keeps ~/.work (os.homedir()).
        format!(
            "@echo off\r\nsetlocal\r\nset \"RT=%USERPROFILE%\\.work\\runtime\"\r\nset \"V=\"\r\nif exist \"%RT%\\current\" set /p V=<\"%RT%\\current\"\r\nif \"%V%\"==\"\" goto missing\r\nif not exist \"%RT%\\%V%\\dist\\{script}\" goto missing\r\n\"%RT%\\%V%\\node.exe\" \"%RT%\\%V%\\dist\\{script}\" %*\r\nexit /b\r\n:missing\r\necho work: no CLI at %RT%\\%V% - start the work app once to put it there. 1>&2\r\nexit /b 1\r\n"
        )
    } else {
        format!(
            "#!/bin/sh\nRT=\"$HOME/.work/runtime\"\nV=\"$(cat \"$RT/current\" 2>/dev/null)\"\nif [ -z \"$V\" ] || [ ! -f \"$RT/$V/dist/{script}\" ]; then\n  echo \"work: no CLI at $RT/$V - start the work app once to put it there.\" >&2\n  exit 1\nfi\nexec \"$RT/$V/node\" \"$RT/$V/dist/{script}\" \"$@\"\n"
        )
    }
}

fn write_launchers(bin: &Path) -> std::io::Result<()> {
    fs::create_dir_all(bin)?;
    for (name, script) in [("work", "bin.js"), ("wd", "wd-bin.js")] {
        let file = bin.join(if cfg!(windows) { format!("{name}.cmd") } else { name.to_string() });
        write_if_changed(&file, &launcher(script))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(())
}

/// The copies to remove: every version except `current` and the newest
/// `KEEP_OLD` others, and temporary copies left behind over an hour ago.
pub fn prunable(entries: &[(String, SystemTime)], current: &str, now: SystemTime) -> Vec<String> {
    let scratch = |n: &str| n.contains(".tmp-") || n.contains(".old-");
    let mut versions: Vec<&(String, SystemTime)> = entries.iter().filter(|(n, _)| valid_version(n) && !scratch(n) && n != current).collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    let mut out: Vec<String> = versions.iter().skip(KEEP_OLD).map(|(n, _)| n.clone()).collect();
    for (n, t) in entries {
        if scratch(n) && now.duration_since(*t).is_ok_and(|d| d > Duration::from_secs(3600)) {
            out.push(n.clone());
        }
    }
    out
}

/// Remove old copies nothing runs from. On Windows a folder with a file open
/// in it can't be renamed, so the rename is the test; elsewhere only copies
/// past the newest few go.
fn prune(root: &Path, current: &str) {
    let Ok(read) = fs::read_dir(root) else { return };
    let entries: Vec<(String, SystemTime)> = read
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.metadata().and_then(|m| m.modified()).unwrap_or(SystemTime::UNIX_EPOCH)))
        .collect();
    for name in prunable(&entries, current, SystemTime::now()) {
        let dir = root.join(&name);
        if cfg!(windows) {
            let gone = root.join(format!("{name}.old-{}", std::process::id()));
            if fs::rename(&dir, &gone).is_ok() {
                let _ = fs::remove_dir_all(&gone);
            }
        } else {
            let _ = fs::remove_dir_all(&dir);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_plain_folder_names() {
        assert!(valid_version("2.3.0"));
        assert!(valid_version("2.3.0-beta.1+abc"));
        assert!(!valid_version(""));
        assert!(!valid_version("../x"));
        assert!(!valid_version("2.3.0\\..\\x"));
        assert!(!valid_version(".hidden"));
    }

    #[test]
    fn keeps_current_and_the_newest_old_copies() {
        let t = |s: u64| SystemTime::UNIX_EPOCH + Duration::from_secs(s);
        let now = t(100_000);
        let entries = vec![
            ("1.0.0".to_string(), t(1)),
            ("1.1.0".to_string(), t(2)),
            ("1.2.0".to_string(), t(3)),
            ("1.3.0".to_string(), t(4)),
            ("1.4.0".to_string(), t(5)), // current
            ("1.4.0.tmp-12".to_string(), t(99_999)), // a copy in progress
            ("1.3.0.tmp-9".to_string(), t(10)),      // left behind
        ];
        let mut out = prunable(&entries, "1.4.0", now);
        out.sort();
        assert_eq!(out, vec!["1.0.0", "1.1.0", "1.3.0.tmp-9"]);
    }

    #[test]
    fn launchers_run_the_current_copy() {
        let l = launcher("bin.js");
        assert!(l.contains("runtime"));
        assert!(l.contains("current"));
        assert!(l.contains("dist") && l.contains("bin.js"));
        assert!(launcher("wd-bin.js").contains("wd-bin.js"));
    }

    /// A temp folder of its own per test.
    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("work-rt-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn unpacks_the_cli_zip_the_packaging_script_writes() {
        // testdata/cli-fixture.zip: written by desktop/scripts/zip-store.mjs (a stored zip).
        let base = scratch("zip");
        let (exe, work) = (base.join("app"), base.join("home").join(".work"));
        fs::create_dir_all(&exe).unwrap();
        fs::write(exe.join("cli.zip"), include_bytes!("testdata/cli-fixture.zip")).unwrap();
        fs::write(exe.join("cli.version"), "9.9.9\n").unwrap();
        let rt = prepare_from(&exe, &work).unwrap().unwrap();
        assert_eq!(rt.version, "9.9.9");
        let dest = work.join("runtime").join("9.9.9");
        assert_eq!(rt.entry, dest.join("dist").join("bin.js"));
        assert_eq!(fs::read_to_string(dest.join("dist").join("bin.js")).unwrap(), "console.log(\"work\");\n");
        assert_eq!(fs::read_to_string(dest.join("node_modules").join("pkg").join("index.js")).unwrap(), "module.exports = 1;\n");
        assert_eq!(fs::read_to_string(work.join("runtime").join("current")).unwrap(), "9.9.9");
        assert!(work.join("bin").join(if cfg!(windows) { "work.cmd" } else { "work" }).is_file());
        // Once there, a start leaves it as it is (nothing unpacked again).
        fs::write(dest.join("marker"), "kept").unwrap();
        prepare_from(&exe, &work).unwrap().unwrap();
        assert!(dest.join("marker").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_package_from_before_carries_a_cli_folder() {
        let base = scratch("dir");
        let (exe, work) = (base.join("app"), base.join("home").join(".work"));
        let cli = exe.join("cli");
        fs::create_dir_all(cli.join("dist")).unwrap();
        fs::write(cli.join("dist").join("bin.js"), "x").unwrap();
        fs::write(cli.join(NODE), "n").unwrap();
        fs::write(cli.join("VERSION"), "2.0.1").unwrap();
        let rt = prepare_from(&exe, &work).unwrap().unwrap();
        assert_eq!(rt.version, "2.0.1");
        assert!(work.join("runtime").join("2.0.1").join("dist").join("bin.js").is_file());
        // A dev build carries nothing: not a packaged app.
        assert!(prepare_from(&base.join("nothing"), &work).unwrap().is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_incomplete_cli_is_refused_and_leaves_no_copy() {
        let base = scratch("bad");
        let (exe, work) = (base.join("app"), base.join("home").join(".work"));
        fs::create_dir_all(&exe).unwrap();
        fs::write(exe.join("cli.zip"), b"not a zip").unwrap();
        fs::write(exe.join("cli.version"), "9.9.8").unwrap();
        assert!(prepare_from(&exe, &work).is_err());
        assert!(!work.join("runtime").join("9.9.8").exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn copies_a_tree() {
        let base = std::env::temp_dir().join(format!("work-rt-test-{}", std::process::id()));
        let src = base.join("src");
        fs::create_dir_all(src.join("dist")).unwrap();
        fs::write(src.join("dist").join("bin.js"), "x").unwrap();
        copy_dir(&src, &base.join("dst")).unwrap();
        assert_eq!(fs::read_to_string(base.join("dst").join("dist").join("bin.js")).unwrap(), "x");
        let _ = fs::remove_dir_all(&base);
    }
}
