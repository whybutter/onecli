//! AWS KMS envelope encryption backend — hosted-platform plumbing, dropped in
//! this fork. Every supported self-host deployment sets `SECRET_ENCRYPTION_KEY`,
//! which selects the free local-AES backend instead (`wiring::create_crypto_service`);
//! this type only exists as the infallible fallback `wiring.rs` constructs
//! when that env var is unset.

/// Unit struct: the licensed original held an `aws_sdk_kms::Client`, but
/// nothing outside this crate reads that field, so it is dropped along with
/// the `aws-sdk-kms` dependency.
pub struct KmsEnvelopeCrypto;

impl KmsEnvelopeCrypto {
    /// Infallible by signature (`wiring.rs` calls this with `.await`, not
    /// `.await?`) — there is nothing to fail at construction time since this
    /// backend never actually reaches KMS.
    pub async fn from_env() -> Self {
        Self
    }
}

#[async_trait::async_trait]
impl crypto::EnvelopeCrypto for KmsEnvelopeCrypto {
    async fn decrypt(&self, _parts: &[&str]) -> anyhow::Result<String> {
        anyhow::bail!(
            "KMS envelope encryption is not available in this build; set SECRET_ENCRYPTION_KEY"
        )
    }

    async fn encrypt(&self, _plaintext: &str) -> anyhow::Result<String> {
        anyhow::bail!(
            "KMS envelope encryption is not available in this build; set SECRET_ENCRYPTION_KEY"
        )
    }
}
