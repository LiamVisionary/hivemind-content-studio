//! The private-state key.
//!
//! The control API resolves `CONTENT_STUDIO_PRIVATE_SECRET` before it looks
//! anywhere else, so the desktop build can keep the key in the OS keychain and
//! hand it over at spawn. That closes the "key file in the same directory as
//! the ciphertext" trade-off (finding security-09) for this build: a backup of
//! the data folder no longer carries the thing that decrypts it.
//!
//! Nothing here prints, logs or returns the value to the UI. It exists to be
//! put in one child's environment.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use keyring::Entry;
use zeroize::Zeroizing;

/// Keychain service name. Distinct from the control API's own
/// `zimage-output-encryption` item so the shell's key and the engine's key are
/// separate entries a person can see and revoke independently.
pub const KEYCHAIN_SERVICE: &str = "ai.hivemindos.content-studio.private-state";
pub const KEYCHAIN_ACCOUNT: &str = "content-studio-private-secret";
const SECRET_BYTES: usize = 48;

fn new_secret() -> Result<Zeroizing<String>, String> {
    let mut bytes = Zeroizing::new([0_u8; SECRET_BYTES]);
    getrandom::getrandom(bytes.as_mut())
        .map_err(|error| format!("Could not generate a private key: {error}"))?;
    Ok(Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref())))
}

/// The key for this install, generated on first launch and kept in the
/// keychain afterwards.
///
/// Returns `Ok(None)` when this machine has no usable keychain: that is a
/// fallback condition, not a failure, and the control API then resolves the key
/// the way it always has. Returning an error here would refuse to boot over a
/// storage preference.
pub fn private_secret() -> Result<Option<Zeroizing<String>>, String> {
    let entry = match Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(entry) => entry,
        Err(_) => return Ok(None),
    };
    match entry.get_password() {
        Ok(existing) if !existing.trim().is_empty() => Ok(Some(Zeroizing::new(existing))),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            let created = new_secret()?;
            match entry.set_password(created.as_str()) {
                Ok(()) => Ok(Some(created)),
                // A locked or absent keychain: boot anyway, on the control
                // API's own resolution order.
                Err(_) => Ok(None),
            }
        }
        Err(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_generated_secret_is_long_and_url_safe() {
        let secret = new_secret().expect("generate");
        assert!(secret.len() >= 64, "{}", secret.len());
        assert!(secret
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_'));
    }

    #[test]
    fn two_generated_secrets_differ() {
        let first = new_secret().expect("generate");
        let second = new_secret().expect("generate");
        assert_ne!(first.as_str(), second.as_str());
    }

    #[test]
    fn the_keychain_item_is_named_for_this_app_and_not_the_engines() {
        assert!(KEYCHAIN_SERVICE.starts_with("ai.hivemindos.content-studio"));
        assert_ne!(KEYCHAIN_SERVICE, "zimage-output-encryption");
    }
}
