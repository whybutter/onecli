//! Clean-room Apache-2.0 replacement for the (formerly) enterprise-licensed
//! `ee` crate.
//!
//! This crate lives at the same path and keeps the same module names as the
//! licensed original so every free crate that calls `ee::…` keeps compiling
//! unmodified (see `docs/upstream-sync/v2-migration/rust-seams.md` for the
//! full call-site inventory this was rebuilt from). It was written from the
//! behaviour specs in `docs/upstream-sync/v2-migration/gateway-ee-behaviour.md`
//! and the free-side call sites only — never from the licensed sources, which
//! were deleted before this crate was written (Phase 0 migration, clean-room
//! rule).
pub mod budget;
pub mod cognito;
pub mod granular_access;
pub mod ha;
pub mod kms_crypto;
pub mod org_routes;
pub mod platform_llm;
pub mod principals;
pub mod rbac;
pub mod response;
