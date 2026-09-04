//! Mandatory transport-to-enrollment admission. It grants no actor identity,
//! private-memory clearance, playback proof, or replay/boot-epoch guarantees.
use crate::{
    auth::{AuthenticatedRequest, AuthenticationPlane},
    enrollment::SharedEnrollmentStore,
    store::SharedStore,
    surface_registry::{self, Binding, RegistryError, Surface},
};
use cosmos_core::AuthenticatedPrincipal;
use tonic::Status;

/// Recheck each message admitted from a long-lived stock stream. This is not
/// dispatch-time cancellation of an already running action.
pub fn gate_stream<T: Send + 'static, S>(
    stream: S,
    store: SharedStore,
    pairing: Option<SharedEnrollmentStore>,
    authenticated: Option<AuthenticatedRequest>,
) -> impl futures_util::Stream<Item = Result<T, Status>> + Send
where
    S: futures_util::Stream<Item = Result<T, Status>> + Send + 'static,
{
    use futures_util::StreamExt;
    futures_util::stream::unfold(
        (Box::pin(stream), store, pairing, authenticated, false),
        |(mut stream, store, pairing, authenticated, done)| async move {
            if done {
                return None;
            }
            let message = stream.next().await?;
            let result = match message {
                Ok(message) => admit(&store, pairing.as_ref(), authenticated.as_ref())
                    .await
                    .map(|_| message),
                Err(error) => Err(error),
            };
            let done = result.is_err();
            Some((result, (stream, store, pairing, authenticated, done)))
        },
    )
}

pub async fn paired_owner(
    pairing: Option<&SharedEnrollmentStore>,
    principal: &str,
    device_id: &str,
) -> Result<(), RegistryError> {
    let pairing = pairing.ok_or(RegistryError::Unavailable)?;
    let subject = pairing
        .device_account(device_id)
        .await
        .map_err(|_| RegistryError::Unavailable)?
        .ok_or(RegistryError::NotFound)?;
    let owner = AuthenticatedPrincipal::for_user(&subject).map_err(|_| RegistryError::NotFound)?;
    if owner.expose_for_authorization() != principal {
        return Err(RegistryError::NotFound);
    }
    Ok(())
}

/// Only AuthLayer's typed context is accepted, never headers or request content.
pub async fn admit(
    store: &SharedStore,
    pairing: Option<&SharedEnrollmentStore>,
    authenticated: Option<&AuthenticatedRequest>,
) -> Result<Surface, Status> {
    let denied = || Status::permission_denied("Pin runtime approval is required");
    let authenticated = authenticated.ok_or_else(denied)?;
    if authenticated.plane != AuthenticationPlane::Device {
        return Err(denied());
    }
    let device = authenticated
        .device
        .as_ref()
        .ok_or_else(denied)?
        .expose_for_authorization();
    let principal = authenticated.principal.expose_for_authorization();
    let map_error = |error| {
        if error == RegistryError::Unavailable {
            Status::unavailable("Pin admission is unavailable")
        } else {
            denied()
        }
    };
    paired_owner(pairing, principal, device)
        .await
        .map_err(map_error)?;
    let id = surface_registry::pin_surface_id(principal, device);
    let surface = store
        .surface(principal, id)
        .await
        .map_err(map_error)?
        .filter(|surface| {
            surface.surface_id == id
                && !surface.revoked
                && matches!(&surface.binding, Binding::Pin { device_id } if device_id == device)
        })
        .ok_or_else(denied)?;
    if surface.manifest != surface_registry::pin_manifest() {
        return Err(denied());
    }
    Ok(surface)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        enrollment::MemoryEnrollmentStore, store::MemoryStore, surface_registry::Mutation,
    };
    use std::sync::Arc;

    #[tokio::test]
    async fn pin_admission_is_scoped_fail_closed_and_rechecks_stream_messages() {
        use futures_util::StreamExt;
        let store: SharedStore = MemoryStore::shared();
        let pairing: SharedEnrollmentStore = Arc::new(MemoryEnrollmentStore::default());
        let authenticated = AuthenticatedRequest {
            principal: AuthenticatedPrincipal::for_user("owner").unwrap(),
            plane: AuthenticationPlane::Device,
            device: Some(cosmos_core::AuthenticatedDeviceIdentity::from_edge("aabb").unwrap()),
        };
        let principal = authenticated.principal.expose_for_authorization();
        let id = surface_registry::pin_surface_id(principal, "aabb");
        assert_eq!(
            admit(&store, None, Some(&authenticated))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unavailable
        );
        assert_eq!(
            admit(&store, Some(&pairing), None)
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        pairing.put_device_account("aabb", "owner").await.unwrap();
        assert_eq!(
            admit(&store, Some(&pairing), Some(&authenticated))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        store
            .mutate_surface(
                principal,
                id,
                Mutation::ApprovePin {
                    device_id: "aabb".into(),
                },
            )
            .await
            .unwrap();
        for _ in 0..15 {
            store
                .mutate_surface(
                    principal,
                    uuid::Uuid::new_v4(),
                    Mutation::Approve {
                        token_hash: surface_registry::hash(b"test"),
                        incarnation: uuid::Uuid::new_v4(),
                    },
                )
                .await
                .unwrap();
        }
        assert_eq!(
            store
                .mutate_surface(
                    principal,
                    uuid::Uuid::new_v4(),
                    Mutation::Approve {
                        token_hash: surface_registry::hash(b"test"),
                        incarnation: uuid::Uuid::new_v4()
                    }
                )
                .await,
            Err(RegistryError::SurfaceLimit)
        );
        // Scoped record lookup remains usable with a full mixed-profile registry.
        let approved = admit(&store, Some(&pairing), Some(&authenticated))
            .await
            .unwrap();
        assert_eq!(approved.trust_level, 0);
        assert_eq!(approved.occupancy, "unknown");
        let mut web = authenticated.clone();
        web.plane = AuthenticationPlane::Web;
        assert_eq!(
            admit(&store, Some(&pairing), Some(&web))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        let mut missing = authenticated.clone();
        missing.device = None;
        assert_eq!(
            admit(&store, Some(&pairing), Some(&missing))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::PermissionDenied
        );
        let unavailable: SharedStore =
            Arc::new(crate::store_postgres::PostgresStore::unreachable());
        assert_eq!(
            admit(&unavailable, Some(&pairing), Some(&authenticated))
                .await
                .unwrap_err()
                .code(),
            tonic::Code::Unavailable
        );
        let (tx, rx) = tokio::sync::mpsc::channel(2);
        let inbound = gate_stream(
            tokio_stream::wrappers::ReceiverStream::new(rx),
            store.clone(),
            Some(pairing.clone()),
            Some(authenticated.clone()),
        );
        let mut inbound = Box::pin(inbound);
        tx.send(Ok(1u8)).await.unwrap();
        assert_eq!(inbound.next().await.unwrap().unwrap(), 1);
        pairing.put_device_account("aabb", "other").await.unwrap();
        tx.send(Ok(2u8)).await.unwrap();
        assert_eq!(
            inbound.next().await.unwrap().unwrap_err().code(),
            tonic::Code::PermissionDenied
        );
        assert!(inbound.next().await.is_none());
    }
}
