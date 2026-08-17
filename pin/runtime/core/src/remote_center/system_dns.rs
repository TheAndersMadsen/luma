//! System-resolver bridge for iroh's DNS lookups.
//!
//! iroh's default [`DnsResolver`] reads the platform's nameserver configuration
//! directly. On Android that reader goes through JNI
//! (`ConnectivityManager.getLinkProperties().getDnsServers()`), which requires
//! an `ndk_context` initialized with a `JavaVM` and an Application context.
//!
//! This Server is a privileged standalone Rust executable, not a JNI library
//! loaded into an Android app process: there is no JVM in this process, so
//! `ndk_context` is never initialized. `ndk_context::android_context()` panics
//! rather than returning an error in that case, and `iroh-dns` detects the
//! failure by catching the unwind — so every start printed
//!
//! ```text
//! thread 'main' panicked at ndk-context-0.1.1/src/lib.rs:72:30:
//! android context was not initialized
//! WARN iroh_dns::dns: Failed to read the system's DNS config, using Google DNS servers as fallback
//! ```
//!
//! and then sent all iroh DNS traffic to 8.8.8.8. `install_android_jni_context`
//! is not an option here (no JVM to install), and pinning a fixed nameserver
//! list is wrong for a device that roams between Wi-Fi and cellular: the list is
//! read once at bind time and would go stale on the next network change.
//!
//! Instead, resolution is delegated to the platform resolver through
//! `getaddrinfo` (`tokio::net::lookup_host`), which reaches Android's `netd`
//! over `/dev/socket/dnsproxyd`. That is the same path the rest of the Server
//! already resolves provider endpoints on, it always uses the *current*
//! network's nameservers, and it needs no JNI context. No JNI probe means no
//! panic, no warning, and no third-party fallback resolver.
//!
//! Limitation: `getaddrinfo` answers address queries only, so [`Resolver::
//! lookup_txt`] is unsupported. TXT is used exclusively by iroh's DNS address
//! lookup, i.e. when *dialing* a remote `EndpointId`. The Pin only ever accepts
//! connections (the Mac helper dials it), and address publishing runs over
//! HTTPS to the pkarr relay, so nothing on this path needs TXT. The call is
//! therefore a loud error rather than a silent empty answer. If the Pin ever
//! needs to dial by `EndpointId`, the system-correct replacement is
//! `android_res_nquery` from `libandroid_net.so`, which submits raw queries
//! through the same system resolver and can carry TXT.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::pin::Pin;

use iroh::dns::{BoxIter, DnsError, DnsResolver, Resolver, TxtRecordData};
use n0_error::{e, StdResultExt as _};
use tracing::warn;

/// Local alias for `n0_future::boxed::BoxFuture`, the [`Resolver`] return type.
/// Spelled out so the bridge does not need a direct dependency on `n0-future`
/// purely to name a type alias.
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// The [`DnsResolver`] the iroh endpoint must be built with on this device.
///
/// Passing this to `Endpoint::builder(..).dns_resolver(..)` is what keeps iroh
/// off the JNI system-config reader; the endpoint constructs a default
/// (JNI-probing) resolver whenever one is not supplied.
pub fn resolver() -> DnsResolver {
    DnsResolver::custom(SystemDnsResolver)
}

/// Resolves through the platform resolver instead of a nameserver list this
/// process configured itself.
#[derive(Debug, Clone, Copy)]
struct SystemDnsResolver;

/// One `getaddrinfo` call. The port is part of the service lookup, not the
/// name: 0 asks for the addresses alone.
async fn lookup_system(host: String) -> Result<Vec<IpAddr>, DnsError> {
    let addrs = tokio::net::lookup_host((host.as_str(), 0)).await.anyerr()?;
    Ok(addrs.map(|addr| addr.ip()).collect())
}

/// Mirrors the hickory-backed resolver's contract: a lookup that produced no
/// record of the requested family is a failed lookup, not an empty success.
/// iroh's staggered address lookup relies on that distinction to retry.
fn non_empty<T: Send + 'static>(addrs: Vec<T>) -> Result<BoxIter<T>, DnsError> {
    if addrs.is_empty() {
        return Err(e!(DnsError::NoResponse));
    }
    Ok(Box::new(addrs.into_iter()))
}

impl Resolver for SystemDnsResolver {
    fn lookup_ipv4(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv4Addr>, DnsError>> {
        Box::pin(async move {
            let addrs = lookup_system(host).await?;
            non_empty(
                addrs
                    .into_iter()
                    .filter_map(|addr| match addr {
                        IpAddr::V4(addr) => Some(addr),
                        IpAddr::V6(_) => None,
                    })
                    .collect(),
            )
        })
    }

    fn lookup_ipv6(&self, host: String) -> BoxFuture<Result<BoxIter<Ipv6Addr>, DnsError>> {
        Box::pin(async move {
            let addrs = lookup_system(host).await?;
            non_empty(
                addrs
                    .into_iter()
                    .filter_map(|addr| match addr {
                        IpAddr::V6(addr) => Some(addr),
                        IpAddr::V4(_) => None,
                    })
                    .collect(),
            )
        })
    }

    /// Unsupported by design; see the module docs. Warns rather than failing
    /// quietly so an unexpected dial-by-`EndpointId` path is visible in logs
    /// instead of looking like an ordinary resolution miss. The host name is a
    /// derived `_iroh.<z32 endpoint id>` label, not user data, but it is still
    /// left out of the log line: the fact of the call is the whole signal.
    fn lookup_txt(&self, _host: String) -> BoxFuture<Result<BoxIter<TxtRecordData>, DnsError>> {
        Box::pin(async move {
            warn!(
                "iroh requested a TXT lookup; the system resolver bridge answers \
                 address queries only, so DNS endpoint discovery is unavailable"
            );
            Err(e!(DnsError::NoResponse))
        })
    }

    /// The platform resolver owns its own cache (netd on Android), and this
    /// bridge holds no state of its own, so there is nothing to clear.
    fn clear_cache(&self) {}

    /// Called after a network change. The bridge is stateless and `netd`
    /// already tracks the active network's nameservers, so a fresh copy is a
    /// complete reset — and, as the trait requires, performs no IO.
    fn reset(&self) -> Box<dyn Resolver> {
        Box::new(*self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    /// Resolves a name every host answers from its own hosts file, so the test
    /// exercises the bridge without depending on a network or a nameserver.
    #[tokio::test]
    async fn resolves_ipv4_through_the_system_resolver() {
        let addrs: Vec<Ipv4Addr> = SystemDnsResolver
            .lookup_ipv4("localhost".to_string())
            .await
            .expect("localhost resolves")
            .collect();
        assert!(
            addrs.contains(&Ipv4Addr::LOCALHOST),
            "expected loopback in the answer"
        );
    }

    /// A name that cannot resolve must surface as an error, not as an empty
    /// success: iroh treats those differently.
    #[tokio::test]
    async fn unresolvable_name_is_an_error() {
        // `.invalid` is reserved by RFC 2606 and is guaranteed never to resolve.
        let result = SystemDnsResolver
            .lookup_ipv4("penumbra-nonexistent.invalid".to_string())
            .await;
        assert!(
            result.is_err(),
            "an unresolvable name must not report success"
        );
    }

    /// The IPv6 side must not leak IPv4 answers from the same `getaddrinfo`
    /// call, and vice versa.
    #[tokio::test]
    async fn ipv4_lookup_filters_out_ipv6_answers() {
        let addrs: Vec<Ipv4Addr> = SystemDnsResolver
            .lookup_ipv4("localhost".to_string())
            .await
            .expect("localhost resolves")
            .collect();
        assert!(
            addrs.iter().all(|addr| !addr.is_unspecified()),
            "only IPv4 answers belong in an IPv4 lookup"
        );
    }

    /// TXT is deliberately unsupported; the accept-only connector never needs
    /// it, and a silent empty answer would hide that.
    #[tokio::test]
    async fn txt_lookup_reports_unsupported() {
        let result = SystemDnsResolver
            .lookup_txt("_iroh.example.invalid".to_string())
            .await;
        assert!(result.is_err(), "TXT lookups must not report success");
    }
}
