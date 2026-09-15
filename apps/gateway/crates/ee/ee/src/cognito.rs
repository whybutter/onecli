//! AWS Cognito session validation — hosted-platform plumbing, permanently
//! dropped in this fork (`docs/upstream-sync/v2-migration/plan.md`: DROP).
//!
//! `configured()` returning `false` means `context::auth::use_cognito_sessions`
//! never selects the Cognito validator (it also requires `Edition::Cloud`,
//! which this fork never sets), so `CognitoSessionValidator` is dead code in
//! practice — kept only because `wiring.rs` names both symbols positionally.

/// Never configured: this fork has no Cognito user pool.
#[must_use]
pub fn configured() -> bool {
    false
}

/// Unit struct kept so `wiring.rs` can construct it positionally; never
/// installed in practice since `configured()` is always false and
/// `context::auth::use_cognito_sessions` also requires `Edition::Cloud`.
pub struct CognitoSessionValidator;

#[async_trait::async_trait]
impl context::auth::SessionValidator for CognitoSessionValidator {
    async fn validate(
        &self,
        _pool: &sqlx::PgPool,
        _headers: &hyper::HeaderMap,
    ) -> Result<String, context::auth::AuthError> {
        Err(context::auth::AuthError(
            "Cognito session validation is not available in this build".to_string(),
        ))
    }

    fn method(&self) -> &'static str {
        "cognito"
    }
}
