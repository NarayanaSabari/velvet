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
const BUNDLE_ID: &str = "app.velvet.desktop.preview";
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
    let stage = std::env::temp_dir().join(format!("velvet-update-{}", manifest.version));
    let _ = std::fs::remove_dir_all(&stage);
    std::fs::create_dir_all(&stage)?;
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

/// Swap the staged bundle in after this process exits, then relaunch it.
/// The helper runs detached so the bundle is never replaced while in use.
pub fn install_on_exit(staged: &Path, target: &Path) -> Result<()> {
    let parent = target
        .parent()
        .ok_or_else(|| anyhow!("Invalid app location"))?;
    let probe = parent.join(".velvet-update-probe");
    std::fs::write(&probe, b"").map_err(|_| {
        anyhow!(
            "Velvet cannot write to {}. Move it to a folder you own to update.",
            parent.display()
        )
    })?;
    let _ = std::fs::remove_file(probe);
    let script = r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
old="$3.old-$$"
mv "$3" "$old" && mv "$2" "$3" && rm -rf "$old" && open "$3" || { [ -e "$3" ] || mv "$old" "$3"; open "$3"; }"#;
    Command::new("/bin/sh")
        .args([
            "-c",
            script,
            "velvet-update",
            &std::process::id().to_string(),
            path(staged)?,
            path(target)?,
        ])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .context("Could not start the update helper")?;
    Ok(())
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
    if s.len() % 2 != 0 {
        bail!("Invalid hex");
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| anyhow!("Invalid hex")))
        .collect()
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
        assert!(decode_hex("abc").is_err());
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
