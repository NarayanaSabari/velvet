//! One native desktop credential per canonical server, stored only in macOS Keychain.
use crate::api::normalize_server;
use anyhow::{Result, anyhow, bail};

#[cfg(target_os = "macos")]
const SERVICE: &str = "app.velvet.desktop";
#[cfg(target_os = "macos")]
const ITEM_NOT_FOUND: i32 = -25300;

pub fn load(server: &str) -> Result<Option<String>> {
    let account = normalize_server(server)?;
    #[cfg(target_os = "macos")]
    {
        use security_framework::passwords::{PasswordOptions, generic_password};
        match generic_password(PasswordOptions::new_generic_password(SERVICE, &account)) {
            Ok(bytes) => {
                let token = String::from_utf8(bytes)
                    .map_err(|_| anyhow!("Keychain credential is invalid"))?;
                if token.is_empty() {
                    bail!("Keychain credential is empty");
                }
                Ok(Some(token))
            }
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(None),
            Err(_) => bail!("Could not read credential from macOS Keychain"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        bail!("macOS Keychain is required");
    }
}

pub fn save(server: &str, token: &str) -> Result<()> {
    let account = normalize_server(server)?;
    if token.is_empty() {
        bail!("Cannot save an empty credential");
    }
    #[cfg(target_os = "macos")]
    {
        security_framework::passwords::set_generic_password(SERVICE, &account, token.as_bytes())
            .map_err(|_| anyhow!("Could not save credential to macOS Keychain"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        bail!("macOS Keychain is required");
    }
}

pub fn delete(server: &str) -> Result<()> {
    let account = normalize_server(server)?;
    #[cfg(target_os = "macos")]
    {
        match security_framework::passwords::delete_generic_password(SERVICE, &account) {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ITEM_NOT_FOUND => Ok(()),
            Err(_) => bail!("Could not delete credential from macOS Keychain"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = account;
        bail!("macOS Keychain is required");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_servers_fail_before_keychain_access() {
        assert!(load("http://example.com").is_err());
        assert!(save("https://name:secret@example.com", "test").is_err());
        assert!(delete("https://example.com?token=secret").is_err());
        assert!(save("https://example.com", "").is_err());
    }

    // This opt-in test creates only its unique account and never touches saved user credentials.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires interactive macOS Keychain permission"]
    fn keychain_round_trip() {
        let server = format!("https://keychain-test-{}.invalid", std::process::id());
        assert!(load(&server).unwrap().is_none());
        save(&server, "test-only-not-a-real-token").unwrap();
        let read = load(&format!("{server}/")).unwrap();
        let removed = delete(&server);
        assert_eq!(read.as_deref(), Some("test-only-not-a-real-token"));
        removed.unwrap();
        delete(&server).unwrap();
        assert!(load(&server).unwrap().is_none());
    }
}
