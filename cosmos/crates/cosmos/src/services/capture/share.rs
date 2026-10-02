//! The one share authority: minting and opening capture share links, and the
//! frame a share page shows.

use super::*;

const SHARE_TOKEN_SECRET_ENV: &str = "COSMOS_SHARE_TOKEN_SECRET";
const SHARE_BASE_URL_ENV: &str = "COSMOS_CAPTURE_SHARE_BASE_URL";
const SHARE_TTL_SECONDS: i64 = 7 * 24 * 60 * 60;

/// What a share signature grants: one owner's one capture until `expiry`.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct ShareCapability {
    pub(crate) owner: String,
    pub(crate) memory_uuid: String,
    pub(crate) expiry: i64,
}

/// A minted share link and the parts of it a caller may want to show.
pub(crate) struct ShareLink {
    pub(crate) url: String,
    pub(crate) memory_uuid: String,
    pub(crate) expiry: i64,
}

/// The ONE share authority. `GetMemoryShareLink` (the Pin's Recents share),
/// the web share button (`POST /capture/memory/{uuid}/share-link`), and the
/// public share page's frame read (`GET /share/capture/{uuid}/thumbnail`) all
/// mint and open the same capability, so a link made anywhere resolves
/// everywhere.
///
/// The link is the shape stock Messages parses
/// (`ShareLinkUtil.SHARE_LINK_REGEX`,
/// `https://(.*)humane.center/share/capture/(.*)\?expiry=(.*)signature=(.*)`):
/// `<COSMOS_CAPTURE_SHARE_BASE_URL>/humane.center/share/capture/<uuid>?expiry=<unix>&signature=<capability>`.
/// An operator domain never contains `humane<any>center`, so that text is the
/// path's first segment. `expiry` comes first and is followed by `&`, because
/// `downloadImageAndSave` takes group 3 up to `signature=` and drops its last
/// character with `substring(0, length - 1)` before `Long.parseLong`.
///
/// The signature is an AES-256-GCM seal of `{owner, memory_uuid, expiry}`
/// under `COSMOS_SHARE_TOKEN_SECRET`: unguessable, unforgeable, and it names
/// the owner so the recipient needs no account on this deployment.
#[derive(Clone)]
pub(crate) struct ShareAuthority {
    endpoint: Endpoint,
    secret: Option<String>,
}

impl ShareAuthority {
    pub(crate) fn from_environment() -> Self {
        Self {
            endpoint: Endpoint::from_environment(SHARE_BASE_URL_ENV),
            secret: non_empty_env(SHARE_TOKEN_SECRET_ENV),
        }
    }

    #[cfg(test)]
    pub(crate) fn for_tests(base: Option<&str>) -> Self {
        Self {
            endpoint: base.map(Endpoint::parse).unwrap_or(Endpoint::Missing),
            secret: Some("test-share-token-secret-32-bytes!!".to_owned()),
        }
    }

    pub(super) fn cipher(&self) -> Result<Aes256Gcm, Status> {
        let secret = self
            .secret
            .as_deref()
            .filter(|value| value.len() >= 32)
            .ok_or_else(|| {
                Status::failed_precondition(format!(
                    "{SHARE_TOKEN_SECRET_ENV} must contain at least 32 bytes"
                ))
            })?;
        let key = Sha256::digest(secret.as_bytes());
        Aes256Gcm::new_from_slice(&key)
            .map_err(|_| Status::failed_precondition("share token key is invalid"))
    }

    /// A fresh seven-day link to `memory_uuid`, owned by `owner`. The caller
    /// has already proved the capture is `owner`'s and passes its canonical
    /// uuid, never a numeric id: the uuid is what the link names and what the
    /// recipient's `ShareLinkData.memory_uuid` must repeat.
    pub(crate) fn mint(&self, owner: &str, memory_uuid: &str) -> Result<ShareLink, Status> {
        self.mint_until(owner, memory_uuid, unix_now() + SHARE_TTL_SECONDS)
    }

    pub(crate) fn mint_until(
        &self,
        owner: &str,
        memory_uuid: &str,
        expiry: i64,
    ) -> Result<ShareLink, Status> {
        let payload = serde_json::to_vec(&ShareCapability {
            owner: owner.to_owned(),
            memory_uuid: memory_uuid.to_owned(),
            expiry,
        })
        .map_err(|_| Status::internal("share capability could not be encoded"))?;
        let nonce: [u8; 12] = rand::random();
        let ciphertext = self
            .cipher()?
            .encrypt(Nonce::from_slice(&nonce), payload.as_slice())
            .map_err(|_| Status::internal("share capability could not be sealed"))?;
        let mut token = Vec::with_capacity(nonce.len() + ciphertext.len());
        token.extend_from_slice(&nonce);
        token.extend_from_slice(&ciphertext);
        let signature = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(token);
        let url = self
            .endpoint
            .share_url(SHARE_BASE_URL_ENV, memory_uuid, expiry, &signature)?;
        Ok(ShareLink {
            url,
            memory_uuid: memory_uuid.to_owned(),
            expiry,
        })
    }

    /// The capability `data` carries, when it is genuine, unexpired and names
    /// exactly the capture and expiry it was minted for. Every refusal is
    /// NOT_FOUND so a prober learns nothing about which part was wrong.
    pub(crate) fn open(&self, data: &pb::ShareLinkData) -> Result<ShareCapability, Status> {
        let token = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(data.signature.as_bytes())
            .map_err(|_| Status::not_found("share link is invalid"))?;
        if token.len() <= 12 {
            return Err(Status::not_found("share link is invalid"));
        }
        let plaintext = self
            .cipher()?
            .decrypt(Nonce::from_slice(&token[..12]), &token[12..])
            .map_err(|_| Status::not_found("share link is invalid"))?;
        let capability: ShareCapability = serde_json::from_slice(&plaintext)
            .map_err(|_| Status::not_found("share link is invalid"))?;
        if capability.expiry < unix_now()
            || capability.expiry != data.expiry
            || capability.memory_uuid != data.memory_uuid
        {
            return Err(Status::not_found("share link is invalid or expired"));
        }
        Ok(capability)
    }
}

fn unix_now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

pub(super) fn request_share_data(
    request: pb::SaveSharedMemoryRequest,
) -> Result<pb::ShareLinkData, Status> {
    if let Some(data) = request.share_link_data {
        return Ok(data);
    }
    if request.memory_uuid.is_empty() || request.signature.is_empty() {
        return Err(Status::invalid_argument("share_link_data is required"));
    }
    Ok(pb::ShareLinkData {
        memory_uuid: request.memory_uuid,
        signature: request.signature,
        expiry: request.expiry,
    })
}

/// The frame a share shows: the capture's best frame (the wearer's choice or
/// the ranked one, from the best-frame sidecar), else the first thumbnail this
/// deployment can open. `Ok(None)` means no thumbnail opens.
///
/// The recipient sees the same hero the owner's grid shows. A sidecar that
/// cannot be read only loses the preference, never the share.
/// INFERRED privacy extension: remove recognized JPEG location-bearing metadata
/// (Exif/XMP APP1, Photoshop/IPTC APP13, comments) without changing pixels.
/// All scans are parsed so metadata between progressive scans is removed too.
/// Malformed/other image formats are refused rather than passed through.
pub(crate) fn strip_jpeg_metadata(bytes: &[u8]) -> Result<Vec<u8>, Status> {
    let invalid = || Status::invalid_argument("image is not a well-framed JPEG");
    if bytes.len() > 32 * 1024 * 1024 || !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(invalid());
    }
    let mut output = vec![0xff, 0xd8];
    let mut cursor = 2;
    let mut scanning = false;
    let mut saw_scan = false;
    while cursor < bytes.len() {
        if scanning {
            let start = cursor;
            loop {
                if cursor >= bytes.len() {
                    return Err(invalid());
                }
                if bytes[cursor] != 0xff {
                    cursor += 1;
                    continue;
                }
                let marker_start = cursor;
                while cursor < bytes.len() && bytes[cursor] == 0xff {
                    cursor += 1;
                }
                let Some(&marker) = bytes.get(cursor) else {
                    return Err(invalid());
                };
                if marker == 0x00 || (0xd0..=0xd7).contains(&marker) {
                    cursor += 1;
                    continue;
                }
                output.extend_from_slice(&bytes[start..marker_start]);
                cursor = marker_start;
                scanning = false;
                break;
            }
        }
        let start = cursor;
        if bytes[cursor] != 0xff {
            return Err(invalid());
        }
        while cursor < bytes.len() && bytes[cursor] == 0xff {
            cursor += 1;
        }
        let Some(&marker) = bytes.get(cursor) else {
            return Err(invalid());
        };
        cursor += 1;
        if marker == 0xd9 {
            if !saw_scan || cursor != bytes.len() {
                return Err(invalid());
            }
            output.extend_from_slice(&bytes[start..cursor]);
            return Ok(output);
        }
        if marker == 0x01 {
            output.extend_from_slice(&bytes[start..cursor]);
            continue;
        }
        if marker == 0x00 || marker == 0xd8 || (0xd0..=0xd7).contains(&marker) {
            return Err(invalid());
        }
        let length_bytes = bytes.get(cursor..cursor + 2).ok_or_else(invalid)?;
        let length = u16::from_be_bytes([length_bytes[0], length_bytes[1]]) as usize;
        if length < 2 {
            return Err(invalid());
        }
        let end = cursor
            .checked_add(length)
            .filter(|end| *end <= bytes.len())
            .ok_or_else(invalid)?;
        if ![0xe1, 0xed, 0xfe].contains(&marker) {
            output.extend_from_slice(&bytes[start..end]);
        }
        cursor = end;
        if marker == 0xda {
            saw_scan = true;
            scanning = true;
        }
    }
    Err(invalid())
}

pub(crate) async fn shared_frame(
    store: &crate::store::SharedStore,
    keys: &crate::keydirectory::SharedKeyDirectory,
    objects: Option<&CaptureObjectStore>,
    owner: &str,
    record: &crate::store::MemoryRecord,
) -> Result<Option<Vec<u8>>, Status> {
    let privacy = crate::services::public_privacy::AccountPrivacy::load(store, owner).await?;
    let best = match objects {
        Some(objects) => objects
            .read_best_frame(owner, &record.uuid)
            .await
            .ok()
            .flatten()
            .map(|selection| selection.frame),
        None => None,
    };
    let order = best
        .filter(|frame| *frame < record.thumbnails.len())
        .into_iter()
        .chain((0..record.thumbnails.len()).filter(|index| Some(*index) != best));
    for index in order {
        let sealed = &record.thumbnails[index];
        let kid = sealed
            .encryption_information
            .as_ref()
            .map(|information| information.kid.as_str())
            .unwrap_or_default();
        let Some(key) = keys
            .get(kid)
            .await
            .map_err(|error| crate::keydirectory::grpc_status(&error))?
        else {
            continue;
        };
        if let Ok(bytes) = cosmos_crypto::secure_asset::open_secure_asset(
            &key,
            kid,
            &sealed.data,
            cosmos_crypto::secure_asset::CAPTURE_THUMBNAIL,
        ) {
            let bytes = if privacy.location_allowed && privacy.share_capture_location {
                bytes
            } else {
                strip_jpeg_metadata(&bytes).map_err(|_| {
                    Status::failed_precondition("shared photo metadata could not be removed")
                })?
            };
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}
