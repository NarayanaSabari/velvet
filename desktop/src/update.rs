//! Self-update from GitHub Releases. Blocking: call from a worker thread.
//!
//! A release tagged `desktop-vX.Y.Z` carries `latest.json` and a zipped app.
//! The manifest is trusted only if its ed25519 signature matches the key
//! embedded below, and the archive only if its SHA-256 matches the manifest.
use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

pub const CURRENT: &str = env!("CARGO_PKG_VERSION");
const RELEASES: &str = "https://api.github.com/repos/NarayanaSabari/velvet/releases?per_page=30";
const TAG_PREFIX: &str = "desktop-v";
const BUNDLE_ID: &str = "app.velvet.desktop";
const MAX_ARCHIVE: u64 = 200 * 1024 * 1024;
/// Public half of the release signing key. The private half stays outside the
/// repository, by default in `~/.config/velvet/desktop-update-key.hex`.
const PUBLIC_KEY: &str = include_str!("../update-public-key.hex");

#[derive(Clone, Debug, Deserialize)]
pub struct Manifest {
    pub version: String,
    pub url: String,
    pub sha256: String,
    #[serde(default)]
    pub notes: String,
    pub signature: String,
}

/// The exact bytes the release key signs.
pub fn signed_message(version: &str, sha256: &str) -> String {
    format!("velvet-desktop:{version}:{sha256}")
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn client() -> Result<reqwest::blocking::Client> {
    reqwest::blocking::Client::builder()
        .https_only(true)
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(300))
        .user_agent(concat!("Velvet for macOS/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| anyhow!("Could not initialize update client"))
}

fn is_newer(candidate: &str) -> bool {
    match (
        semver::Version::parse(candidate),
        semver::Version::parse(CURRENT),
    ) {
        (Ok(c), Ok(cur)) => c > cur,
        _ => false,
    }
}

pub fn verify(manifest: &Manifest) -> Result<()> {
    let key = decode_hex(PUBLIC_KEY.trim())?;
    let signature = decode_hex(&manifest.signature)?;
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, key)
        .verify(
            signed_message(&manifest.version, &manifest.sha256).as_bytes(),
            &signature,
        )
        .map_err(|_| anyhow!("Update signature is invalid"))
}

/// Newest signed release above the running version, if any.
pub fn check() -> Result<Option<Manifest>> {
    let http = client()?;
    let releases: Vec<Release> = http
        .get(RELEASES)
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(|r| r.error_for_status())
        .context("Could not reach the update server")?
        .json()
        .context("Unexpected update server response")?;
    let newest = releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let version = semver::Version::parse(r.tag_name.strip_prefix(TAG_PREFIX)?).ok()?;
            Some((version, r))
        })
        .max_by(|a, b| a.0.cmp(&b.0));
    let Some((version, release)) = newest else {
        return Ok(None);
    };
    if !is_newer(&version.to_string()) {
        return Ok(None);
    }
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == "latest.json")
        .ok_or_else(|| anyhow!("Release {} has no manifest", release.tag_name))?;
    let manifest: Manifest = http
        .get(&asset.browser_download_url)
        .send()
        .and_then(|r| r.error_for_status())
        .context("Could not download the update manifest")?
        .json()
        .context("Invalid update manifest")?;
    verify(&manifest)?;
    if manifest.version != version.to_string() {
        bail!("Update manifest version does not match its release");
    }
    Ok(Some(manifest))
}

/// The running `.app` bundle, or `None` under `cargo run`.
pub fn running_bundle() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?.canonicalize().ok()?;
    let bundle = exe.parent()?.parent()?.parent()?.to_path_buf();
    (bundle.extension()? == "app").then_some(bundle)
}

/// Download, verify and unpack the update next to nothing the user sees.
/// Returns the staged bundle ready to swap in.
pub fn download(manifest: &Manifest) -> Result<PathBuf> {
    verify(manifest)?;
    let mut body = client()?
        .get(&manifest.url)
        .send()
        .and_then(|r| r.error_for_status())
        .context("Could not download the update")?;
    let mut bytes = Vec::new();
    (&mut body)
        .take(MAX_ARCHIVE + 1)
        .read_to_end(&mut bytes)
        .context("Update download was interrupted")?;
    if bytes.len() as u64 > MAX_ARCHIVE {
        bail!("Update archive is too large");
    }
    let digest = ring::digest::digest(&ring::digest::SHA256, &bytes);
    if encode_hex(digest.as_ref()) != manifest.sha256.to_ascii_lowercase() {
        bail!("Update archive checksum does not match");
    }
    let stage = unique_dir(&std::env::temp_dir(), "velvet-update-")?;
    let result = unpack(manifest, &bytes, &stage);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&stage);
    }
    result
}

fn unpack(manifest: &Manifest, bytes: &[u8], stage: &Path) -> Result<PathBuf> {
    let archive = stage.join("update.zip");
    std::fs::write(&archive, &bytes)?;
    run("ditto", &["-x", "-k", path(&archive)?, path(&stage)?])?;
    let app = std::fs::read_dir(&stage)?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| anyhow!("Update archive contains no app"))?;
    let plist = app.join("Contents/Info.plist");
    let read = |key: &str| -> Result<String> {
        let out = Command::new("plutil")
            .args(["-extract", key, "raw", path(&plist)?])
            .output()?;
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    };
    if read("CFBundleIdentifier")? != BUNDLE_ID {
        bail!("Update is for a different application");
    }
    if read("CFBundleShortVersionString")? != manifest.version {
        bail!("Update app version does not match its manifest");
    }
    run("codesign", &["--verify", "--strict", path(&app)?])?;
    Ok(app)
}

const TRANSACTION_PREFIX: &str = ".velvet-update-";
const SWAP_SCRIPT: &str = include_str!("update_swap.sh");

/// Reserve private scratch space atomically, without touching an existing path.
fn unique_dir(parent: &Path, prefix: &str) -> Result<PathBuf> {
    use ring::rand::SecureRandom;
    use std::os::unix::fs::DirBuilderExt;
    for _ in 0..16 {
        let mut random = [0; 16];
        ring::rand::SystemRandom::new()
            .fill(&mut random)
            .map_err(|_| anyhow!("Could not create a private update directory"))?;
        let dir = parent.join(format!("{prefix}{}", encode_hex(&random)));
        match std::fs::DirBuilder::new().mode(0o700).create(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("Could not reserve update space")
}

/// Fails early without overwriting an existing file or following a probe symlink.
pub fn check_writable(target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("Invalid app location"))?;
    let probe = unique_dir(parent, ".velvet-probe-").map_err(|_| {
        anyhow!(
            "Velvet cannot write to {}. Move it to a folder you own to update.",
            parent.display()
        )
    })?;
    std::fs::remove_dir(probe).context("Could not remove update write probe")
}

/// Surface a previous helper failure once, retaining its journal and backup.
pub fn previous_failure(target: &Path) -> Result<Option<String>> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("Invalid app location"))?;
    let mut failures = Vec::new();
    for entry in std::fs::read_dir(parent)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir()
            || !entry
                .file_name()
                .to_string_lossy()
                .starts_with(TRANSACTION_PREFIX)
        {
            continue;
        }
        let dir = entry.path();
        if std::fs::read_to_string(dir.join("target")).ok().as_deref() != target.to_str() {
            continue;
        }
        let status = dir.join("status");
        let message = match std::fs::read_to_string(&status) {
            Ok(message) => message,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        failures.push(format!(
            "{} Recovery files: {}",
            message.trim(),
            dir.display()
        ));
        std::fs::rename(status, dir.join("reported"))?;
    }
    Ok((!failures.is_empty()).then(|| failures.join("\n")))
}

/// Prepare a same-volume candidate before quitting. Only a ready helper permits exit.
pub fn install_on_exit(staged: &Path, target: &Path, relaunch: bool) -> Result<()> {
    if !staged.is_dir() || !target.is_dir() || staged == target {
        bail!("Update app is missing or its location is invalid. Download the update again.");
    }
    check_writable(target)?;
    let transaction = unique_dir(target.parent().unwrap(), TRANSACTION_PREFIX)?;
    let result = (|| {
        std::fs::write(transaction.join("target"), path(target)?)?;
        std::fs::write(
            transaction.join("status"),
            "Update was interrupted before completion.",
        )?;
        // Copy before quitting so cross-volume moves cannot leave a partial live app.
        run(
            "/usr/bin/ditto",
            &[path(staged)?, path(&transaction.join("next.app"))?],
        )?;
        start_helper(&transaction, target, relaunch, "/bin/sh")
    })();
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&transaction);
    }
    result
}

fn start_helper(transaction: &Path, target: &Path, relaunch: bool, shell: &str) -> Result<()> {
    let diagnostics = std::fs::File::create(transaction.join("helper.log"))?;
    let mut child = Command::new(shell)
        .args(["-c", SWAP_SCRIPT, "velvet-update"])
        .arg(std::process::id().to_string())
        .arg(transaction)
        .arg(target)
        .arg(if relaunch { "1" } else { "0" })
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(diagnostics)
        .spawn()
        .context("Could not start the update helper")?;
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        if let Some(status) = child.try_wait()? {
            bail!("Update helper exited before it was ready ({status})");
        }
        if transaction.join("ready").is_file() {
            return Ok(());
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Update helper did not become ready. Velvet has not quit.");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn run(program: &str, args: &[&str]) -> Result<()> {
    let status = Command::new(program).args(args).status()?;
    if !status.success() {
        bail!("{program} failed while preparing the update");
    }
    Ok(())
}
fn path(p: &Path) -> Result<&str> {
    p.to_str().ok_or_else(|| anyhow!("Non-UTF-8 path"))
}
pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn decode_hex(s: &str) -> Result<Vec<u8>> {
    if !s.bytes().all(|byte| byte.is_ascii_hexdigit()) || s.len() % 2 != 0 {
        bail!("Invalid hex");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| anyhow!("Invalid hex")))
        .collect()
}

fn prefs_file() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Application Support/Velvet/auto-update"))
}

/// Automatic updates default on. Only an explicit "off" disables them.
pub fn auto_update_enabled() -> bool {
    prefs_file()
        .and_then(|f| std::fs::read_to_string(f).ok())
        .is_none_or(|v| v.trim() != "off")
}

pub fn set_auto_update(enabled: bool) -> Result<()> {
    let file = prefs_file().ok_or_else(|| anyhow!("HOME is not set"))?;
    std::fs::create_dir_all(file.parent().unwrap())?;
    std::fs::write(file, if enabled { "on" } else { "off" })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    #[test]
    fn version_ordering_rejects_downgrades_and_garbage() {
        assert!(is_newer("999.0.0"));
        assert!(!is_newer(CURRENT));
        assert!(!is_newer("0.0.1"));
        assert!(!is_newer("not-a-version"));
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(
            decode_hex(&encode_hex(&[0, 15, 255])).unwrap(),
            vec![0, 15, 255]
        );
        for invalid in ["abc", "€a", "é", "💥", "gg", "+0", "0 ", "\n0"] {
            assert!(decode_hex(invalid).is_err(), "{invalid:?}");
        }
        assert_eq!(decode_hex("aB09").unwrap(), vec![171, 9]);
        assert_eq!(decode_hex("").unwrap(), Vec::<u8>::new());
    }

    #[test]
    fn signature_binds_version_and_hash() {
        let rng = ring::rand::SystemRandom::new();
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&rng).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(pkcs8.as_ref()).unwrap();
        let public = pair.public_key().as_ref();
        let sig = pair.sign(signed_message("1.2.3", "ab").as_bytes());
        let ok = |v: &str, h: &str| {
            ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, public)
                .verify(signed_message(v, h).as_bytes(), sig.as_ref())
                .is_ok()
        };
        assert!(ok("1.2.3", "ab"));
        assert!(!ok("1.2.4", "ab"));
        assert!(!ok("1.2.3", "ac"));
        // A manifest signed by a foreign key fails against the embedded one.
        let forged = Manifest {
            version: "1.2.3".into(),
            url: String::new(),
            sha256: "ab".into(),
            notes: String::new(),
            signature: encode_hex(sig.as_ref()),
        };
        assert!(verify(&forged).is_err());
        assert!(
            verify(&Manifest {
                signature: "€a".into(),
                ..forged
            })
            .is_err()
        );
    }

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            Self(unique_dir(&std::env::temp_dir(), "velvet-updater-test-").unwrap())
        }
        fn bundle(&self, name: &str, contents: &str) -> PathBuf {
            let bundle = self.0.join(name);
            std::fs::create_dir_all(&bundle).unwrap();
            std::fs::write(bundle.join("contents"), contents).unwrap();
            bundle
        }
        fn executable(&self, name: &str, script: &str) {
            use std::os::unix::fs::PermissionsExt;
            let file = self.0.join(name);
            std::fs::write(&file, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn scratch_and_probes_never_overwrite_existing_paths() {
        let root = Scratch::new();
        let sentinel = root.0.join(".velvet-update-probe");
        std::fs::write(&sentinel, "keep").unwrap();
        check_writable(&root.0.join("Velvet.app")).unwrap();
        assert_eq!(std::fs::read_to_string(sentinel).unwrap(), "keep");
        let first = unique_dir(&root.0, "same-version-").unwrap();
        std::fs::write(first.join("sentinel"), "keep").unwrap();
        let second = unique_dir(&root.0, "same-version-").unwrap();
        assert_ne!(first, second);
        assert_eq!(
            std::fs::read_to_string(first.join("sentinel")).unwrap(),
            "keep"
        );
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 3);
    }

    #[test]
    fn missing_stage_and_permission_failure_leave_target_untouched() {
        use std::os::unix::fs::PermissionsExt;
        let root = Scratch::new();
        let target = root.bundle("Velvet.app", "old");
        assert!(install_on_exit(&root.0.join("missing.app"), &target, false).is_err());
        let stage = root.bundle("staged.app", "new");
        std::fs::set_permissions(&root.0, std::fs::Permissions::from_mode(0o500)).unwrap();
        let result = install_on_exit(&stage, &target, false);
        std::fs::set_permissions(&root.0, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            result.is_err(),
            "permission test must run as a non-root user"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "old"
        );
        assert_eq!(std::fs::read_dir(&root.0).unwrap().count(), 2);
    }

    #[test]
    fn helper_start_errors_are_returned_before_quit() {
        let root = Scratch::new();
        let target = root.bundle("Velvet.app", "old");
        assert!(start_helper(&root.0, &target, false, "/missing/shell").is_err());
        assert!(start_helper(&root.0, &target, false, "/usr/bin/true").is_err());
        // The real shell rejects a missing prepared bundle before acknowledging readiness.
        assert!(start_helper(&root.0, &target, false, "/bin/sh").is_err());
        assert!(!root.0.join("ready").exists());
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "old"
        );
    }

    #[test]
    fn helper_readiness_timeout_leaves_original_untouched() {
        let root = Scratch::new();
        let target = root.bundle("Velvet.app", "old");
        root.executable("unready", "exec /bin/sleep 30");
        let error = start_helper(
            &root.0,
            &target,
            false,
            path(&root.0.join("unready")).unwrap(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("did not become ready"));
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "old"
        );
    }

    #[test]
    fn helper_waits_for_parent_exit_before_swapping() {
        let root = Scratch::new();
        let target = root.bundle("Velvet.app", "old");
        let transaction = unique_dir(&root.0, TRANSACTION_PREFIX).unwrap();
        std::fs::create_dir(transaction.join("next.app")).unwrap();
        std::fs::write(transaction.join("next.app/contents"), "new").unwrap();
        let mut parent = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let mut helper = Command::new("/bin/sh")
            .args(["-c", SWAP_SCRIPT, "velvet-test"])
            .arg(parent.id().to_string())
            .arg(&transaction)
            .arg(&target)
            .arg("0")
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        while !transaction.join("ready").exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        let ready = transaction.join("ready").exists();
        let before = std::fs::read_to_string(target.join("contents")).unwrap();
        parent.kill().unwrap();
        parent.wait().unwrap();
        assert!(helper.wait().unwrap().success());
        assert!(ready);
        assert_eq!(before, "old");
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "new"
        );
    }

    fn swap_case(fault: &str, relaunch: bool) -> (Scratch, PathBuf, PathBuf, std::process::Output) {
        let root = Scratch::new();
        let target = root.bundle("Velvet with spaces.app", "old");
        let transaction = unique_dir(&root.0, TRANSACTION_PREFIX).unwrap();
        std::fs::write(transaction.join("target"), path(&target).unwrap()).unwrap();
        let next = transaction.join("next.app");
        std::fs::create_dir(&next).unwrap();
        std::fs::write(next.join("contents"), "new").unwrap();
        if fault == "missing" {
            std::fs::remove_dir_all(&next).unwrap();
        }
        root.executable(
            "mv",
            match fault {
                "preserve" => "exit 1",
                "install" => "case \"$1\" in */next.app) exit 1;; esac\nexec /bin/mv \"$@\"",
                "rollback" => {
                    "case \"$1\" in */next.app|*/previous.app) exit 1;; esac\nexec /bin/mv \"$@\""
                }
                _ => "exec /bin/mv \"$@\"",
            },
        );
        root.executable(
            "rm",
            if fault == "cleanup" {
                "case \"$2\" in */previous.app) exit 1;; esac\nexec /bin/rm \"$@\""
            } else {
                "exec /bin/rm \"$@\""
            },
        );
        root.executable(
            "open",
            if fault == "relaunch" {
                "exit 1"
            } else {
                "exit 0"
            },
        );
        // A reaped child supplies an exited PID without terminating any live process.
        let mut exited = Command::new("/usr/bin/true").spawn().unwrap();
        let pid = exited.id();
        exited.wait().unwrap();
        let output = Command::new("/bin/sh")
            .args(["-c", SWAP_SCRIPT, "velvet-test"])
            .arg(pid.to_string())
            .arg(&transaction)
            .arg(&target)
            .arg(if relaunch { "1" } else { "0" })
            .env("PATH", format!("{}:/usr/bin:/bin", root.0.display()))
            .output()
            .unwrap();
        (root, target, transaction, output)
    }

    #[test]
    fn real_helper_success_removes_backup_and_journal() {
        for relaunch in [false, true] {
            let (_root, target, transaction, output) = swap_case("", relaunch);
            assert!(output.status.success(), "{:?}", output);
            assert_eq!(
                std::fs::read_to_string(target.join("contents")).unwrap(),
                "new"
            );
            assert!(!transaction.exists());
        }
    }

    #[test]
    fn real_helper_failures_persist_and_restore_original() {
        for fault in ["missing", "preserve", "install"] {
            let (_root, target, transaction, output) = swap_case(fault, false);
            assert!(!output.status.success(), "{fault}");
            assert_eq!(
                std::fs::read_to_string(target.join("contents")).unwrap(),
                "old"
            );
            let message = previous_failure(&target).unwrap().unwrap();
            assert!(message.contains("Update could not"), "{message}");
            assert!(transaction.join("reported").exists());
            assert!(previous_failure(&target).unwrap().is_none());
        }
    }

    #[test]
    fn failed_rollback_retains_original_and_recovery_path() {
        let (_root, target, transaction, output) = swap_case("rollback", false);
        assert!(!output.status.success());
        assert!(!target.exists());
        assert_eq!(
            std::fs::read_to_string(transaction.join("previous.app/contents")).unwrap(),
            "old"
        );
        let message = previous_failure(&target).unwrap().unwrap();
        assert!(message.contains("Restore the previous app"));
        assert!(message.contains(path(&transaction).unwrap()));
    }

    #[test]
    fn relaunch_failure_keeps_installed_app_and_reports_error() {
        let (_root, target, transaction, output) = swap_case("relaunch", true);
        assert_eq!(
            std::fs::read_to_string(transaction.join("previous.app/contents")).unwrap(),
            "old"
        );
        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "new"
        );
        assert!(
            previous_failure(&target)
                .unwrap()
                .unwrap()
                .contains("could not relaunch")
        );
    }

    #[test]
    fn cleanup_failure_retains_backup_and_reports_installed_state() {
        let (_root, target, transaction, output) = swap_case("cleanup", false);
        assert!(!output.status.success());
        assert_eq!(
            std::fs::read_to_string(target.join("contents")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(transaction.join("previous.app/contents")).unwrap(),
            "old"
        );
        assert!(
            previous_failure(&target)
                .unwrap()
                .unwrap()
                .contains("previous app could not be removed")
        );
    }

    /// Opt-in: `VELVET_TEST_SIGNATURE=<hex of sign key 9.9.9 ab>` proves the
    /// committed public key matches the maintainer's private key.
    #[test]
    #[ignore]
    fn embedded_key_accepts_real_signature() {
        let manifest = Manifest {
            version: "9.9.9".into(),
            url: String::new(),
            sha256: "ab".into(),
            notes: String::new(),
            signature: std::env::var("VELVET_TEST_SIGNATURE").unwrap(),
        };
        verify(&manifest).unwrap();
    }
}
