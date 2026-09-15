//! `onecli-gateway relay` — a local mTLS relay for an agent that cannot (or
//! should not) hold the gateway's client certificate itself.
//!
//! # The core design: a blind byte-splice
//!
//! The relay accepts a plain HTTP-proxy connection from a local agent
//! (`CONNECT host:port`, or an absolute-form request) on a loopback/bindable
//! port, opens exactly ONE mTLS connection to the remote gateway presenting
//! the relay's OWN client certificate, and copies bytes between the two
//! connections verbatim (`tokio::io::copy_bidirectional` — see
//! `tunnel::splice`).
//!
//! It does NOT parse, rewrite, or even inspect the agent's CONNECT line or
//! headers. That is the entire security property this crate exists to
//! provide: the agent's original `CONNECT host:443` request line, together
//! with its `Proxy-Authorization: Basic base64(aoc_token)` header, reaches
//! the remote gateway byte-for-byte — so the gateway authenticates the agent
//! and MITMs the connection exactly as it would if the agent had dialed it
//! directly. The relay carries BOTH identities to the gateway at once: its
//! own client certificate (the mTLS handshake) and the agent's `aoc_` token
//! (untouched, inside the tunneled header).
//!
//! Consequently the relay holds NO MITM logic, NO database, NO crypto
//! service, and NO policy. Its only moving parts are: enrollment
//! (`enroll`) to obtain a client certificate without the private key ever
//! leaving the process, renewal (`renew`) to replace that certificate
//! before it expires, and the splice itself (`tunnel`).
//!
//! # Trust
//!
//! The remote gateway's server certificate is verified against
//! `--gateway-server-ca` — supplied out of band by the operator, REQUIRED,
//! and never derived from the enrollment response (that response's `ca_pem`
//! is the CLIENT CA, a completely different trust anchor — see the
//! `SECURITY` note on `enroll::build_client_tls_config`). Missing or
//! unparseable input here is fail-closed: the relay refuses to start rather
//! than fall back to an accept-any-server-cert verifier.

pub mod args;
mod enroll;
mod renew;
mod tunnel;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use arc_swap::ArcSwap;
use tokio::net::TcpListener;
use tracing::{info, warn};

pub use args::RelayArgs;

/// The relay's current mTLS client identity: the `ClientConfig` used to dial
/// the remote gateway, paired with that certificate's own expiry so a
/// connection can fail closed on an expired certificate without re-parsing
/// it out of the config.
pub(crate) struct RelayCertState {
    pub(crate) tls_config: Arc<rustls::ClientConfig>,
    pub(crate) not_after_unix: i64,
}

/// Bundled arguments for the renewal loop — kept as one struct (rather than
/// half a dozen positional parameters) since renewal needs almost everything
/// [`run`] resolved at startup, re-supplied on every retry.
pub(crate) struct RenewalArgs {
    pub(crate) api_url: String,
    pub(crate) api_key: String,
    pub(crate) label: Option<String>,
    pub(crate) host_id: String,
    pub(crate) csr_pem: String,
    pub(crate) key_pem: String,
    pub(crate) server_ca_pem: String,
    pub(crate) state_dir: Option<PathBuf>,
}

/// Run the relay: resolve config, enroll a client certificate (fail-closed
/// if that fails), spawn the renewal task, then accept and splice
/// connections until shutdown.
///
/// Never starts accepting connections until a valid certificate and a
/// verified server-CA trust store both exist — an enrollment failure here
/// aborts startup rather than serving with no certificate at all.
pub async fn run(args: RelayArgs) -> Result<()> {
    let server_name = args
        .gateway_server_name
        .clone()
        .unwrap_or_else(|| host_part(&args.gateway_addr).to_string());

    // Fail-closed: `--api-url` carries the workspace's `oc_` key on every
    // enrolment AND every renewal (`Authorization: Bearer`) — plaintext
    // HTTP to anything but loopback would put that key on the wire in the
    // clear. Loopback is exempt for local dev/testing (a fake api-server on
    // 127.0.0.1, same posture the e2e suite relies on).
    validate_api_url(&args.api_url)?;

    // Fail-closed: the trust anchor for the REMOTE GATEWAY'S server
    // certificate is mandatory. An unreadable or unparseable value must
    // refuse to start — never fall back to trusting nothing (which, for a
    // rustls root store, means trusting everything is instead rejected, or
    // to skipping verification).
    let server_ca_pem =
        client_ca::pem_from_value("RELAY_GATEWAY_SERVER_CA", &args.gateway_server_ca)?
            .context("RELAY_GATEWAY_SERVER_CA must not be empty")?;
    // Parse it now, at startup, so a garbage CA bundle fails here — before
    // any connection is ever accepted — rather than on the first dial.
    client_ca::load_root_store(&server_ca_pem).context("RELAY_GATEWAY_SERVER_CA")?;

    let stored = load_stored_state(args.state_dir.as_deref()).await?;

    // The relay's own keypair, generated once and never sent anywhere — only
    // the CSR (proof of possession) is submitted for enrollment. Reused
    // across renewals; only reloaded fresh across a restart when
    // `--state-dir` is set.
    let (keypair, csr_pem) = match &stored {
        Some(s) => {
            let key = rcgen::KeyPair::from_pem(&s.key_pem)
                .context("parsing persisted relay private key")?;
            let csr_pem = build_csr(&key)?;
            (key, csr_pem)
        }
        None => enroll::generate_keypair_and_csr()?,
    };
    let key_pem = keypair.serialize_pem();
    let host_id = stored.map(|s| s.host_id);

    info!(
        gateway = %args.gateway_addr,
        bind = %args.bind,
        resuming = host_id.is_some(),
        "enrolling relay client certificate"
    );
    let enrolled = enroll::enroll(
        &args.api_url,
        &args.api_key,
        &csr_pem,
        host_id,
        args.label.clone(),
    )
    .await
    .context("initial client-certificate enrollment failed")?;

    if let Some(dir) = &args.state_dir {
        persist_state(dir, &key_pem, &enrolled.cert_pem, &enrolled.host_id).await?;
    }

    let tls_config = enroll::build_client_tls_config(&enrolled.cert_pem, &key_pem, &server_ca_pem)?;
    let lifetime =
        Duration::from_secs(enrolled.not_after_unix.saturating_sub(unix_now()).max(0) as u64);

    info!(
        identity = %enrolled.identity,
        host_id = %enrolled.host_id,
        serial = %enrolled.serial,
        not_after = enrolled.not_after_unix,
        "relay client certificate enrolled"
    );

    let state = Arc::new(ArcSwap::from_pointee(RelayCertState {
        tls_config,
        not_after_unix: enrolled.not_after_unix,
    }));

    // Renewal runs for the life of the process under its own shutdown guard:
    // it holds no agent connection open, but the drain should still give an
    // in-flight renewal (and the `--state-dir` write that follows it) a
    // moment rather than cutting it mid-write.
    let renewal_guard = shutdown::task_guard();
    let renewal_state = Arc::clone(&state);
    let renewal_args = RenewalArgs {
        api_url: args.api_url.clone(),
        api_key: args.api_key.clone(),
        label: args.label.clone(),
        host_id: enrolled.host_id.clone(),
        csr_pem,
        key_pem,
        server_ca_pem,
        state_dir: args.state_dir.clone(),
    };
    tokio::spawn(async move {
        let _guard = renewal_guard;
        renew::renewal_loop(
            renewal_args,
            lifetime,
            enrolled.not_after_unix,
            renewal_state,
        )
        .await;
    });

    let listener = TcpListener::bind(args.bind)
        .await
        .with_context(|| format!("binding relay listener on {}", args.bind))?;
    let bound = listener
        .local_addr()
        .context("reading bound relay address")?;
    info!(
        addr = %bound,
        gateway = %args.gateway_addr,
        server_name = %server_name,
        "relay listening"
    );

    let mut shutdown_signal = shutdown::subscribe();
    loop {
        let (stream, peer_addr) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(pair) => pair,
                Err(e) => {
                    // Mirrors the gateway's own accept loop: a recoverable
                    // accept() error must not take down the whole relay.
                    warn!(error = %e, "relay accept() failed, retrying");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            },
            _ = shutdown_signal.wait() => break,
        };

        let state = Arc::clone(&state);
        let gateway_addr = args.gateway_addr.clone();
        let server_name = server_name.clone();
        // A relay tunnel is an indefinite byte pipe, same as the gateway's
        // own raw CONNECT tunnels — deliberately untracked so shutdown
        // doesn't wait the full drain deadline on a connection that may
        // never end on its own.
        let guard = shutdown::task_guard();
        tokio::spawn(async move {
            drop(guard);
            if let Err(e) = tunnel::splice(stream, state, &gateway_addr, &server_name).await {
                warn!(peer = %peer_addr, error = ?e, "relay tunnel error");
            }
        });
    }

    drop(listener);
    info!("relay listener closed");
    Ok(())
}

/// Build a fresh CSR from an already-generated keypair. Split out from
/// [`enroll::generate_keypair_and_csr`] so a persisted (reloaded) key can
/// also get a CSR without regenerating the key itself.
fn build_csr(key: &rcgen::KeyPair) -> Result<String> {
    let params = rcgen::CertificateParams::default();
    let csr = params
        .serialize_request(key)
        .context("building relay client CSR from a persisted key")?;
    csr.pem().context("encoding relay CSR as PEM")
}

/// Fail closed unless `api_url`'s scheme is `https`, or its host is loopback
/// (`localhost`, `127.0.0.1`, `::1`).
///
/// `--api-url`/`RELAY_API_URL` is where every enrolment AND every renewal
/// sends `Authorization: Bearer <oc_ workspace key>` — a plain `http://` to
/// anything reachable over a real network puts that key on the wire in the
/// clear, to be replayed by anyone who can see it. Loopback is exempt
/// because that's exactly what a local dev setup or this crate's own e2e
/// suite talks to (a fake api-server on `127.0.0.1`), where there is no
/// network hop to sniff.
fn validate_api_url(api_url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(api_url)
        .with_context(|| format!("--api-url {api_url:?} is not a valid URL"))?;
    if parsed.scheme() == "https" {
        return Ok(());
    }
    let is_loopback = parsed.host_str().is_some_and(|host| {
        // `Url::host_str` returns an IPv6 host WITH its `[...]` brackets
        // (it's a substring of the serialized URL, which always brackets
        // IPv6 literals) — strip them before handing it to `IpAddr::parse`,
        // which rejects them.
        let host = host.trim_start_matches('[').trim_end_matches(']');
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .is_ok_and(|ip| ip.is_loopback())
    });
    if is_loopback {
        return Ok(());
    }
    bail!(
        "--api-url {api_url:?} must be https, or a loopback address (localhost/127.0.0.1/::1) \
         for local development -- otherwise the workspace API key would ride in cleartext on \
         every enrollment and renewal"
    );
}

/// The host part of a `host:port` string — everything before the last `:`.
/// Falls back to the whole string if there's no colon. Good enough for the
/// `host:port` shape `--gateway-addr` always takes; not meant to handle
/// bracketed IPv6.
fn host_part(addr: &str) -> &str {
    addr.rsplit_once(':').map_or(addr, |(host, _)| host)
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Relay identity persisted across restarts when `--state-dir` is set.
struct StoredState {
    key_pem: String,
    host_id: String,
}

/// Load a previously persisted key + host id, if both files are present.
/// Missing either (or no `state_dir` at all) is `Ok(None)` — first-ever
/// startup, or an operator who never opted into persistence — not an error.
async fn load_stored_state(state_dir: Option<&Path>) -> Result<Option<StoredState>> {
    let Some(dir) = state_dir else {
        return Ok(None);
    };
    let key_path = dir.join("relay-key.pem");
    let host_id_path = dir.join("relay-host-id");
    if !key_path.exists() || !host_id_path.exists() {
        return Ok(None);
    }

    let key_pem = tokio::fs::read_to_string(&key_path)
        .await
        .with_context(|| format!("reading {}", key_path.display()))?;
    let host_id = tokio::fs::read_to_string(&host_id_path)
        .await
        .with_context(|| format!("reading {}", host_id_path.display()))?
        .trim()
        .to_string();

    Ok(Some(StoredState { key_pem, host_id }))
}

/// Persist the relay's private key (0600 from the moment it exists on
/// disk), current certificate, and host id to `dir`, creating it if
/// necessary. Called after every successful enrollment (initial and
/// renewal) when `--state-dir` is set.
async fn persist_state(dir: &Path, key_pem: &str, cert_pem: &str, host_id: &str) -> Result<()> {
    tokio::fs::create_dir_all(dir)
        .await
        .with_context(|| format!("creating relay state directory {}", dir.display()))?;

    let key_path = dir.join("relay-key.pem");
    write_private_key(&key_path, key_pem).await?;

    let cert_path = dir.join("relay-cert.pem");
    tokio::fs::write(&cert_path, cert_pem)
        .await
        .with_context(|| format!("writing {}", cert_path.display()))?;

    let host_id_path = dir.join("relay-host-id");
    tokio::fs::write(&host_id_path, host_id)
        .await
        .with_context(|| format!("writing {}", host_id_path.display()))?;

    Ok(())
}

/// Write the relay's private key to `path` at 0600, guaranteed — even when
/// `path` already exists with looser permissions.
///
/// `OpenOptions::mode` only applies the permission bits at the moment a file
/// is CREATED: opening an already-existing file with `.create(true)` (the
/// old pattern here) leaves that file's existing mode untouched, so a
/// pre-existing world-readable `path` (left over from an old bug, a manual
/// copy, whatever) would silently keep receiving the key at its old, wider
/// permissions forever. Writing to a fresh scratch file instead — created
/// with `create_new(true)` (so `.mode(0o600)` unconditionally applies) —
/// then atomically renaming it over `path` sidesteps that: `rename(2)`
/// replaces the whole directory entry, so the file left at `path` is always
/// the one just created at 0600, never the old one with its old mode.
///
/// SECURITY: every failure here — including the create-with-mode call
/// itself — is a hard error, never a best-effort `.ok()`. A private key must
/// not be able to silently end up on disk with looser permissions (or not
/// written at all) than intended. The scratch file is best-effort cleaned up
/// on any failure path, but that cleanup is never allowed to mask the real
/// error.
#[cfg(unix)]
async fn write_private_key(path: &Path, key_pem: &str) -> Result<()> {
    use tokio::io::AsyncWriteExt;

    let tmp_path = scratch_path_for(path);
    let result: Result<()> = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp_path)
            .await
            .with_context(|| format!("creating {} with 0600 permissions", tmp_path.display()))?;
        file.write_all(key_pem.as_bytes())
            .await
            .with_context(|| format!("writing {}", tmp_path.display()))?;
        drop(file);
        tokio::fs::rename(&tmp_path, path)
            .await
            .with_context(|| format!("renaming {} to {}", tmp_path.display(), path.display()))?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&tmp_path).await;
    }
    result
}

/// Non-unix fallback: no POSIX permission bits to set atomically at create
/// time, so this is a plain write.
#[cfg(not(unix))]
async fn write_private_key(path: &Path, key_pem: &str) -> Result<()> {
    tokio::fs::write(path, key_pem)
        .await
        .with_context(|| format!("writing {}", path.display()))
}

/// The scratch path [`write_private_key`] creates before atomically renaming
/// it over `path` — a `.tmp` suffix on the SAME filename, so it always lands
/// beside the real file in the same directory (and therefore the same
/// filesystem, which `rename(2)` requires to stay atomic).
#[cfg(unix)]
fn scratch_path_for(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".tmp");
    PathBuf::from(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_part_splits_off_the_port() {
        assert_eq!(host_part("gateway.example.com:8443"), "gateway.example.com");
        assert_eq!(host_part("127.0.0.1:10255"), "127.0.0.1");
    }

    #[test]
    fn host_part_falls_back_to_whole_string_with_no_colon() {
        assert_eq!(host_part("localhost"), "localhost");
    }

    #[test]
    fn validate_api_url_accepts_https_anywhere() {
        assert!(validate_api_url("https://api.example.com").is_ok());
        assert!(validate_api_url("https://api.example.com:8443/v1").is_ok());
    }

    #[test]
    fn validate_api_url_accepts_plain_http_on_loopback() {
        assert!(validate_api_url("http://127.0.0.1:3000").is_ok());
        assert!(validate_api_url("http://localhost:3000").is_ok());
        assert!(validate_api_url("http://LOCALHOST:3000").is_ok());
        assert!(validate_api_url("http://[::1]:3000").is_ok());
    }

    #[test]
    fn validate_api_url_refuses_plain_http_on_a_remote_host() {
        let err = validate_api_url("http://api.example.com").unwrap_err();
        assert!(
            format!("{err:#}").contains("--api-url"),
            "error must name --api-url so an operator knows what to fix: {err:#}"
        );
    }

    #[test]
    fn validate_api_url_errs_on_garbage() {
        assert!(validate_api_url("not a url").is_err());
    }

    #[tokio::test]
    async fn persist_and_load_round_trip_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        persist_state(dir.path(), "KEY-PEM", "CERT-PEM", "host-abc")
            .await
            .expect("persist");

        let loaded = load_stored_state(Some(dir.path()))
            .await
            .expect("load")
            .expect("state present");
        assert_eq!(loaded.key_pem, "KEY-PEM");
        assert_eq!(loaded.host_id, "host-abc");
    }

    #[tokio::test]
    async fn load_stored_state_is_none_without_a_state_dir() {
        assert!(load_stored_state(None).await.expect("ok").is_none());
    }

    #[tokio::test]
    async fn load_stored_state_is_none_when_files_are_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(load_stored_state(Some(dir.path()))
            .await
            .expect("ok")
            .is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn persisted_key_file_has_restricted_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        persist_state(dir.path(), "KEY-PEM", "CERT-PEM", "host-abc")
            .await
            .expect("persist");

        let perms = std::fs::metadata(dir.path().join("relay-key.pem"))
            .expect("metadata")
            .permissions();
        assert_eq!(perms.mode() & 0o777, 0o600);
    }

    /// A failure writing the key must propagate as a hard `Err`, never be
    /// swallowed the way the old write-then-`.ok()`-chmod pattern would have
    /// (which could leave a world-readable key on disk with no error at
    /// all). Forced here by putting a directory exactly where the key file
    /// needs to go: the scratch file (`relay-key.pem.tmp`) is created fine
    /// beside it, but the final `rename()` over a directory always fails.
    #[tokio::test]
    async fn persist_state_hard_errors_when_the_key_file_cannot_be_created() {
        let dir = tempfile::tempdir().expect("tempdir");
        tokio::fs::create_dir_all(dir.path().join("relay-key.pem"))
            .await
            .expect("create a directory blocking the key file's path");

        let err = persist_state(dir.path(), "KEY-PEM", "CERT-PEM", "host-abc")
            .await
            .expect_err("must hard-error rather than silently succeed or silently drop the key");
        assert!(format!("{err:#}").contains("relay-key.pem"));
    }

    /// The whole point of the create-scratch-then-rename pattern: a
    /// pre-existing key file with wide (world-readable) permissions must
    /// end up at 0600 after a write, not keep its old mode. `OpenOptions`'s
    /// `.mode()` only applies at file CREATION, so opening the existing
    /// file directly (the old implementation) would silently leave it at
    /// 0644 forever; renaming a freshly-created 0600 scratch file over it
    /// fixes that unconditionally.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_private_key_fixes_a_pre_existing_wide_mode_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay-key.pem");
        tokio::fs::write(&path, "OLD-KEY-PEM")
            .await
            .expect("seed a pre-existing key file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644))
            .expect("widen its permissions");

        write_private_key(&path, "NEW-KEY-PEM")
            .await
            .expect("write");

        let perms = std::fs::metadata(&path).expect("metadata").permissions();
        assert_eq!(
            perms.mode() & 0o777,
            0o600,
            "a pre-existing wide-mode file must not keep its old permissions"
        );
        let contents = tokio::fs::read_to_string(&path).await.expect("read back");
        assert_eq!(contents, "NEW-KEY-PEM");
    }

    /// No scratch file must survive a failed write -- confirmed directly
    /// (not just inferred from the error) since a leaked `.tmp` would keep
    /// failing every subsequent write attempt with `create_new(true)`.
    #[cfg(unix)]
    #[tokio::test]
    async fn write_private_key_cleans_up_its_scratch_file_on_failure() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay-key.pem");
        tokio::fs::create_dir_all(&path)
            .await
            .expect("create a directory blocking the key file's path");

        write_private_key(&path, "KEY-PEM")
            .await
            .expect_err("must hard-error");

        assert!(
            !scratch_path_for(&path).exists(),
            "a failed write must not leave its scratch file behind"
        );
    }

    /// `run()` must fail closed BEFORE binding a listener or attempting
    /// enrollment when the server-CA trust anchor is missing/garbage.
    #[tokio::test]
    async fn run_errs_on_garbage_gateway_server_ca_before_anything_else() {
        let args = RelayArgs {
            bind: "127.0.0.1:0".parse().unwrap(),
            gateway_addr: "127.0.0.1:1".to_string(),
            gateway_server_name: None,
            gateway_server_ca: "not a pem and not a real path".to_string(),
            api_url: "http://127.0.0.1:1".to_string(),
            api_key: "oc_test".to_string(),
            label: None,
            state_dir: None,
        };
        let err = run(args).await.expect_err("must fail closed");
        assert!(format!("{err:#}").contains("RELAY_GATEWAY_SERVER_CA"));
    }

    /// Enrollment unreachable at startup must fail `run()` closed — the
    /// relay never falls back to serving with no certificate.
    #[tokio::test]
    async fn run_errs_when_enrollment_is_unreachable() {
        client_ca::test_support::ensure_crypto_provider();
        let ca = client_ca::test_support::new_test_ca("Trust Anchor");

        let args = RelayArgs {
            bind: "127.0.0.1:0".parse().unwrap(),
            gateway_addr: "127.0.0.1:1".to_string(),
            gateway_server_name: None,
            gateway_server_ca: ca.cert.pem(),
            // Port 1 is not a real gateway; the connection should fail fast
            // (refused or unreachable) rather than reach anything real.
            api_url: "http://127.0.0.1:1".to_string(),
            api_key: "oc_test".to_string(),
            label: None,
            state_dir: None,
        };
        let result = tokio::time::timeout(Duration::from_secs(5), run(args)).await;
        let err = result
            .expect("must not hang")
            .expect_err("must fail closed when enrollment is unreachable");
        assert!(format!("{err:#}").contains("enrollment"));
    }
}
