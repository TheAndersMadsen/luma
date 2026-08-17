use serde::Deserialize;

use crate::db::MusicActivityRecord;
use crate::proto::aibus::{
    synapse_chat_turn, SynapseSource, SynapseUnderstandingRequest, SynapseUser,
    SynapseUserRequestContent,
};
use crate::tier_a::native_actions::{
    GENERATE_MUSIC_PLAYLIST, GET_MUSIC_QUEUE, NEXT_TRACK, PAUSE_MUSIC, PLAY_CURRENT_TRACK_RADIO,
    PLAY_FAVORITE_TRACKS, PLAY_FEATURED_MUSIC, PLAY_MUSIC, PREVIOUS_TRACK, RESPOND, RESTART_TRACK,
    RESUME_MUSIC, SAVE_CURRENT_TRACK_TO_FAVORITES, UNDERSTAND_SCENE,
};

const MAX_UTTERANCE_BYTES: usize = 384;
const MAX_TOPIC_BYTES: usize = 256;
const MAX_TOPIC_WORDS: usize = 40;
const MAX_CATALOG_QUERY_WORDS: usize = 24;
const MAX_VISUAL_FIELD_CHARS: usize = 160;
const MAX_AI_CLASSIFIER_BYTES: usize = 4 * 1024;
const MAX_MUSIC_CONVERSATION_ITEMS: usize = 4;
const MAX_MUSIC_CONVERSATION_ITEM_BYTES: usize = 256;
const STOCK_CONTEXT_SECONDS: i64 = 60;

#[derive(Debug, PartialEq, Eq)]
pub struct PlannedMusicAction {
    pub action_name: &'static str,
    pub thought: &'static str,
    pub input_json: String,
}

/// A deliberately narrow visual result. Image/OCR content is untrusted and can
/// only populate stock `PlayMusic` fields; it can never name an action.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VisualMusicCandidate {
    #[serde(default)]
    pub track: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    pub confidence: VisualMusicConfidence,
    #[serde(default)]
    pub ambiguous: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VisualMusicConfidence {
    High,
    Medium,
    Low,
}

/// The only decisions accepted from the text music classifier. The model does
/// not choose an action name: Rust maps these values to either stock
/// `PlayMusic`, a fixed metadata `Respond`, or no action at all.
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiMusicIntent {
    PlayCatalog,
    PlayContextualTop,
    CurrentTitle,
    CurrentArtist,
    CurrentAlbum,
    NotMusic,
    Ambiguous,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiMusicConfidence {
    High,
    Medium,
    Low,
}

/// Strict, data-only result from the constrained classifier. Catalog strings
/// are subsequently required to be normalized spans of the user's utterance,
/// so a prompt injection or model hallucination cannot invent a song to play.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AiMusicCandidate {
    pub intent: AiMusicIntent,
    #[serde(default)]
    pub track: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub genre: Option<String>,
    pub confidence: AiMusicConfidence,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ContextualMusicIntent {
    CurrentTrackQuestion,
    CurrentArtistQuestion,
    CurrentAlbumQuestion,
    PlayPrimaryArtistTopSong,
}

/// Stock music actions whose public schema has no fields. Keeping this as a
/// closed enum makes it impossible for utterance text (including a visual
/// automation `Then`) to select the private
/// `PlayRecommendationsWithTrackId` action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FieldlessMusicAction {
    GetQueue,
    Next,
    Pause,
    PlayCurrentRadio,
    PlayFavorites,
    PlayFeatured,
    Previous,
    Restart,
    Resume,
    SaveCurrentToFavorites,
}

impl FieldlessMusicAction {
    fn action_name(self) -> &'static str {
        match self {
            Self::GetQueue => GET_MUSIC_QUEUE,
            Self::Next => NEXT_TRACK,
            Self::Pause => PAUSE_MUSIC,
            Self::PlayCurrentRadio => PLAY_CURRENT_TRACK_RADIO,
            Self::PlayFavorites => PLAY_FAVORITE_TRACKS,
            Self::PlayFeatured => PLAY_FEATURED_MUSIC,
            Self::Previous => PREVIOUS_TRACK,
            Self::Restart => RESTART_TRACK,
            Self::Resume => RESUME_MUSIC,
            Self::SaveCurrentToFavorites => SAVE_CURRENT_TRACK_TO_FAVORITES,
        }
    }

    fn thought(self) -> &'static str {
        match self {
            Self::GetQueue => "I should ask the stock music experience for its current queue",
            Self::Next => "I should advance the stock music experience to its next track",
            Self::Pause => "I should pause the stock music experience",
            Self::PlayCurrentRadio => "I should start the stock radio for the current track",
            Self::PlayFavorites => "I should play the user's stock music favorites",
            Self::PlayFeatured => "I should start stock featured music",
            Self::Previous => "I should return the stock music experience to its previous track",
            Self::Restart => "I should restart the current stock music track",
            Self::Resume => "I should resume the stock music experience",
            Self::SaveCurrentToFavorites => {
                "I should save the current stock music track to the user's favorites"
            }
        }
    }

    fn planned(self) -> PlannedMusicAction {
        PlannedMusicAction {
            action_name: self.action_name(),
            thought: self.thought(),
            input_json: "{}".to_string(),
        }
    }
}

pub fn requires_recent_track_context(request: &SynapseUnderstandingRequest) -> bool {
    if !valid_request_envelope(request) {
        return false;
    }
    normalized_command(&request.utterance).is_some_and(|command| {
        contextual_music_intent(&command).is_some() || deictic_current_radio_request(&command)
    })
}

/// A broad, intentionally cheap gate before the separate classifier call. It
/// covers conventional music nouns, playback verbs, and open-ended request
/// forms such as "give me some Gorillaz". All other deterministic planners run
/// before this fallback, and a non-music classifier result falls through to the
/// normal assistant unchanged.
pub fn is_ai_music_fallback_candidate(request: &SynapseUnderstandingRequest) -> bool {
    if !valid_request_envelope(request) {
        return false;
    }
    let Some(command) = normalized_command(&request.utterance) else {
        return false;
    };
    if contains_compound_command(&command)
        || looks_like_prompt_injection(&command)
        || stock_owned_playlist_or_favorites_request(&command)
        || fieldless_music_request_shape(&command)
    {
        return false;
    }

    let normalized = normalize_catalog_span(&command);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    let has_signal_word = tokens.iter().any(|token| {
        matches!(
            *token,
            "play"
                | "playing"
                | "song"
                | "songs"
                | "track"
                | "tracks"
                | "album"
                | "albums"
                | "artist"
                | "artists"
                | "playlist"
                | "playlists"
                | "music"
                | "genre"
                | "band"
                | "singer"
                | "tune"
                | "tunes"
                | "hit"
                | "hits"
                | "remix"
                | "single"
                | "soundtrack"
                | "spotify"
                | "listen"
                | "hear"
                | "spin"
                | "put"
                | "queue"
                | "cue"
                | "crank"
                | "bump"
                | "jam"
                | "blast"
                | "shuffle"
                | "stream"
                | "perform"
                | "performs"
                | "performed"
        )
    });
    has_signal_word
        || [
            "put on ",
            "throw on ",
            "turn on ",
            "crank up ",
            "fire up ",
            "drop ",
            "bump ",
            "hit me with ",
            "give me ",
            "can i get ",
            "could i get ",
            "i want ",
            "i would like ",
            "i d like ",
            "i d love ",
            "i would love ",
            "i feel like ",
            "i am in the mood for ",
            "i m in the mood for ",
            "i could go for ",
            "how about ",
            "some ",
            "something else by ",
            "something from ",
            "another one by ",
            "let us have ",
            "let s have ",
            "go with ",
            "surprise me ",
        ]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
        || (normalized.starts_with("get ") && normalized.ends_with(" going"))
        || normalized.ends_with(" please")
        || normalized.ends_with(" if you do not mind")
        || normalized.ends_with(" if you don t mind")
        || normalized.ends_with(" would be nice")
}

/// A narrow signal used only to keep an explicit catalog request from being
/// swallowed by generic image chat. Deictic visual requests are handled by the
/// stricter linked-image path before this function is consulted.
pub fn prefers_text_music_over_image(request: &SynapseUnderstandingRequest) -> bool {
    if !valid_request_envelope(request) || is_visual_music_request(request) {
        return false;
    }
    let Some(command) = normalized_command(&request.utterance) else {
        return false;
    };
    if let Some(action) = exact_fieldless_music_action(&command) {
        // A bare "this" can refer to an image or other preceding turn. Only
        // verified player context may disambiguate it as the current track;
        // explicit radio commands remain text-owned without this exception.
        if action == FieldlessMusicAction::PlayCurrentRadio
            && deictic_current_radio_request(&command)
        {
            return false;
        }
        return !action_is_excluded(request, action.action_name());
    }
    if named_artist_lookup_and_play_top_request(&command).is_some()
        || catalog_lookup_and_play_rank_one_request(&command).is_some()
    {
        return !action_is_excluded(request, PLAY_MUSIC);
    }
    if !is_ai_music_fallback_candidate(request) {
        return false;
    }
    if looks_like_question(&command) {
        return false;
    }
    let normalized = normalize_catalog_span(&command);
    let tokens = normalized.split_whitespace().collect::<Vec<_>>();
    tokens.iter().any(|token| {
        matches!(
            *token,
            "play"
                | "playing"
                | "listen"
                | "hear"
                | "spin"
                | "queue"
                | "cue"
                | "stream"
                | "crank"
                | "bump"
                | "blast"
        )
    }) || [
        "put on ",
        "throw on ",
        "turn on ",
        "fire up ",
        "hit me with ",
        "give me ",
        "i want ",
        "i would like ",
        "i d like ",
        "i d love ",
        "i would love ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
        || (normalized.starts_with("get ") && normalized.ends_with(" going"))
}

/// Extract only a few recent, bounded text turns for deictic music resolution.
/// The classifier still receives no images, memory, location, or action tools,
/// and its catalog output must be an exact span of either the current utterance
/// or this returned context before Rust can emit `PlayMusic`.
pub fn bounded_music_conversation_context(request: &SynapseUnderstandingRequest) -> Vec<String> {
    if !valid_request_envelope(request) {
        return Vec::new();
    }
    let Some(context) = request.device_context.as_ref() else {
        return Vec::new();
    };
    if context.is_locked {
        return Vec::new();
    }
    let Some(current_index) = context.turns.iter().rposition(|turn| {
        turn.user() == SynapseUser::User
            && matches!(
                &turn.content,
                Some(synapse_chat_turn::Content::UserRequest(user_request))
                    if current_turn_matches_request(user_request, &request.utterance)
            )
    }) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    for turn in context.turns[..current_index].iter().rev() {
        let value: Option<String> = match turn.content.as_ref() {
            Some(synapse_chat_turn::Content::UserRequest(user_request))
                if turn.user() == SynapseUser::User =>
            {
                let value = if user_request.repaired_request.is_empty() {
                    &user_request.request
                } else {
                    &user_request.repaired_request
                };
                Some(value.to_string())
            }
            Some(synapse_chat_turn::Content::Action(action))
                if turn.user() == SynapseUser::Assistant && action.action == RESPOND =>
            {
                serde_json::from_str::<serde_json::Value>(&action.input)
                    .ok()
                    .and_then(|value| value.get("Response")?.as_str().map(str::to_string))
            }
            Some(synapse_chat_turn::Content::Message(message))
                if matches!(turn.user(), SynapseUser::User | SynapseUser::Assistant) =>
            {
                Some(message.content.clone())
            }
            _ => None,
        };
        let Some(value) = value.as_deref().and_then(bounded_music_context_item) else {
            continue;
        };
        if !items.iter().any(|existing| existing == &value) {
            items.push(value);
        }
        if items.len() == MAX_MUSIC_CONVERSATION_ITEMS {
            break;
        }
    }
    items.reverse();
    items
}

/// Decode the classifier's strict JSON envelope. Low-confidence output and
/// semantically inconsistent field combinations fail closed before planning.
pub fn parse_ai_music_candidate(value: &str) -> Option<AiMusicCandidate> {
    if value.is_empty() || value.len() > MAX_AI_CLASSIFIER_BYTES {
        return None;
    }
    let mut candidate: AiMusicCandidate = serde_json::from_str(value.trim()).ok()?;
    candidate.track = normalize_ai_field(candidate.track)?;
    candidate.artist = normalize_ai_field(candidate.artist)?;
    candidate.album = normalize_ai_field(candidate.album)?;
    candidate.genre = normalize_ai_field(candidate.genre)?;

    if candidate.confidence == AiMusicConfidence::Low {
        return None;
    }
    let field_count = ai_catalog_fields(&candidate).into_iter().flatten().count();
    match candidate.intent {
        AiMusicIntent::PlayCatalog if candidate.confidence == AiMusicConfidence::High => {
            valid_ai_catalog_combination(&candidate).then_some(candidate)
        }
        AiMusicIntent::PlayContextualTop
        | AiMusicIntent::CurrentTitle
        | AiMusicIntent::CurrentArtist
        | AiMusicIntent::CurrentAlbum
            if candidate.confidence == AiMusicConfidence::High && field_count == 0 =>
        {
            Some(candidate)
        }
        AiMusicIntent::NotMusic | AiMusicIntent::Ambiguous if field_count == 0 => Some(candidate),
        _ => None,
    }
}

/// Validate a classifier result against the original request and map it to the
/// exact stock action schema. Direct catalog fields must be normalized spans of
/// the utterance or, only for an explicit deictic follow-up, exact verified
/// recent-player fields. Prior prose may help the classifier resolve a pronoun,
/// but it is never action authority: every playback selector must still be an
/// exact current-utterance span or exact verified recent-player metadata.
pub fn plan_ai_music_action(
    request: &SynapseUnderstandingRequest,
    candidate: &AiMusicCandidate,
    recent_track: Option<&MusicActivityRecord>,
    _conversation_context: &[String],
) -> Option<PlannedMusicAction> {
    if !is_ai_music_fallback_candidate(request) {
        return None;
    }
    let command = normalized_command(&request.utterance)?;
    match candidate.intent {
        AiMusicIntent::NotMusic => None,
        AiMusicIntent::Ambiguous => fixed_ai_music_response(
            request,
            "I need to ask which music the user meant",
            "Which song, artist, album, playlist, or genre did you mean?",
        ),
        AiMusicIntent::CurrentTitle
        | AiMusicIntent::CurrentArtist
        | AiMusicIntent::CurrentAlbum => {
            let Some(track) = recent_track.and_then(valid_recent_track) else {
                return fixed_ai_music_response(
                    request,
                    "I should not guess without current stock music context",
                    "I don't have a current song to use for that request.",
                );
            };
            let artists = natural_list(&track.artists);
            let response = match candidate.intent {
                AiMusicIntent::CurrentTitle => {
                    if track_status_is_active(track) {
                        format!("This is {} by {}.", track.title, artists)
                    } else {
                        format!("That was {} by {}.", track.title, artists)
                    }
                }
                AiMusicIntent::CurrentArtist => {
                    let copula = if track_status_is_active(track) {
                        "is"
                    } else {
                        "was"
                    };
                    format!("{} {copula} by {}.", track.title, artists)
                }
                AiMusicIntent::CurrentAlbum => {
                    let Some(album) = track
                        .album
                        .as_deref()
                        .map(str::trim)
                        .filter(|album| valid_catalog_value(album))
                    else {
                        return fixed_ai_music_response(
                            request,
                            "I should not guess missing album metadata",
                            "I don't have album information for that song.",
                        );
                    };
                    let copula = if track_status_is_active(track) {
                        "is"
                    } else {
                        "was"
                    };
                    format!("{} {copula} from the album {}.", track.title, album)
                }
                _ => unreachable!(),
            };
            fixed_ai_music_response(
                request,
                "I should answer from validated current stock music context",
                &response,
            )
        }
        AiMusicIntent::PlayContextualTop => {
            if action_is_excluded(request, PLAY_MUSIC) || informational_question(&command) {
                return None;
            }
            let Some(track) = recent_track.and_then(valid_recent_track) else {
                return fixed_ai_music_response(
                    request,
                    "I should not guess without current stock music context",
                    "I don't have a current artist to use for that request.",
                );
            };
            let artist = track.artists.first()?.trim();
            Some(PlannedMusicAction {
                action_name: PLAY_MUSIC,
                thought: "I should play the validated current artist's top catalog result",
                input_json: serde_json::json!({"Artist": artist}).to_string(),
            })
        }
        AiMusicIntent::PlayCatalog => {
            if action_is_excluded(request, PLAY_MUSIC)
                || informational_question(&command)
                || !ai_fields_are_grounded(candidate, &command, recent_track)
            {
                return None;
            }
            let input = match (
                candidate.track.as_deref(),
                candidate.artist.as_deref(),
                candidate.album.as_deref(),
                candidate.genre.as_deref(),
            ) {
                (Some(track), Some(artist), None, None) => {
                    serde_json::json!({"Track": track, "Artist": artist})
                }
                (Some(track), None, None, None) => serde_json::json!({"Track": track}),
                (None, Some(artist), Some(album), None) => {
                    serde_json::json!({"Album": album, "Artist": artist})
                }
                (None, None, Some(album), None) => serde_json::json!({"Album": album}),
                (None, Some(artist), None, None) => serde_json::json!({"Artist": artist}),
                (None, None, None, Some(genre)) => serde_json::json!({"Genre": genre}),
                _ => return None,
            };
            Some(PlannedMusicAction {
                action_name: PLAY_MUSIC,
                thought: "I should search the stock music provider using grounded catalog fields",
                input_json: input.to_string(),
            })
        }
    }
}

/// Handle only playback controls and read-only answers backed by verified
/// current-player metadata. This is the no-cloud fast path used before the
/// general semantic planner; catalog selection stays out of it.
pub fn plan_local_music_action(
    request: &SynapseUnderstandingRequest,
    recent_track: Option<&MusicActivityRecord>,
) -> Option<PlannedMusicAction> {
    plan_catalog_or_contextual_music_action_inner(request, recent_track, false)
}

/// Restore direct track search and the two stock-style contextual turns that
/// depend on the current/most-recent track. Spotify's provider remains the
/// catalog authority: a bare title is emitted as `PlayMusic(Track)`, and the
/// stock music resolver calls `queryWithTrackName` before starting playback.
pub fn plan_catalog_or_contextual_music_action(
    request: &SynapseUnderstandingRequest,
    recent_track: Option<&MusicActivityRecord>,
) -> Option<PlannedMusicAction> {
    plan_catalog_or_contextual_music_action_inner(request, recent_track, true)
}

fn plan_catalog_or_contextual_music_action_inner(
    request: &SynapseUnderstandingRequest,
    recent_track: Option<&MusicActivityRecord>,
    allow_provider_selection: bool,
) -> Option<PlannedMusicAction> {
    if !valid_request_envelope(request) {
        return None;
    }
    let command = normalized_command(&request.utterance)?;
    // Exact ranked lookup -> play requests are owned by the provider-backed
    // fast path in `UnderstandHandler`. Never degrade them here to an
    // Artist-only mutation: that would discard the provider's ranked row and
    // make alternate callers of this shared cascade behave differently.
    if named_artist_lookup_and_play_top_request(&command).is_some()
        || catalog_lookup_and_play_rank_one_request(&command).is_some()
    {
        return None;
    }
    if contains_compound_command(&command) {
        return None;
    }

    // These stock actions are all keyguard-enabled and fieldless. Parse them
    // before catalog ownership so generic phrases such as "play music" and
    // library phrases such as "play my favorite tracks" cannot be mistaken
    // for a track title. A recognized-but-excluded action stops here rather
    // than falling through to `PlayMusic`.
    if let Some(action) = exact_fieldless_music_action(&command) {
        if action_is_excluded(request, action.action_name()) {
            return None;
        }
        if action == FieldlessMusicAction::PlayCurrentRadio
            && deictic_current_radio_request(&command)
            && recent_track.and_then(valid_recent_track).is_none()
        {
            return None;
        }
        return Some(action.planned());
    }

    if let Some(intent) = contextual_music_intent(&command) {
        let Some(track) = recent_track.and_then(valid_recent_track) else {
            if action_is_excluded(request, RESPOND) {
                return None;
            }
            return Some(PlannedMusicAction {
                action_name: RESPOND,
                thought: "I should not guess without current stock music context",
                input_json: serde_json::json!({
                    "Response": "I don't have a current song to use for that request."
                })
                .to_string(),
            });
        };
        return match intent {
            ContextualMusicIntent::CurrentTrackQuestion => {
                if action_is_excluded(request, RESPOND) {
                    return None;
                }
                let artists = natural_list(&track.artists);
                let response = if track_status_is_active(track) {
                    format!("This is {} by {}.", track.title, artists)
                } else {
                    format!("That was {} by {}.", track.title, artists)
                };
                Some(PlannedMusicAction {
                    action_name: RESPOND,
                    thought: "I should answer from validated current stock music context",
                    input_json: serde_json::json!({
                        "Response": response
                    })
                    .to_string(),
                })
            }
            ContextualMusicIntent::CurrentArtistQuestion => {
                if action_is_excluded(request, RESPOND) {
                    return None;
                }
                let artists = natural_list(&track.artists);
                let copula = if track_status_is_active(track) {
                    "is"
                } else {
                    "was"
                };
                Some(PlannedMusicAction {
                    action_name: RESPOND,
                    thought: "I should answer from validated current stock music context",
                    input_json: serde_json::json!({
                        "Response": format!("{} {copula} by {}.", track.title, artists)
                    })
                    .to_string(),
                })
            }
            ContextualMusicIntent::CurrentAlbumQuestion => {
                if action_is_excluded(request, RESPOND) {
                    return None;
                }
                let Some(album) = track
                    .album
                    .as_deref()
                    .map(str::trim)
                    .filter(|album| valid_catalog_value(album))
                else {
                    return Some(PlannedMusicAction {
                        action_name: RESPOND,
                        thought: "I should not guess missing album metadata",
                        input_json: serde_json::json!({
                            "Response": "I don't have album information for that song."
                        })
                        .to_string(),
                    });
                };
                let copula = if track_status_is_active(track) {
                    "is"
                } else {
                    "was"
                };
                Some(PlannedMusicAction {
                    action_name: RESPOND,
                    thought: "I should answer from validated current stock music context",
                    input_json: serde_json::json!({
                        "Response": format!("{} {copula} from the album {}.", track.title, album)
                    })
                    .to_string(),
                })
            }
            ContextualMusicIntent::PlayPrimaryArtistTopSong => {
                if !allow_provider_selection {
                    return None;
                }
                if action_is_excluded(request, PLAY_MUSIC) {
                    return None;
                }
                let artist = track.artists.first()?.trim();
                if !valid_catalog_value(artist) {
                    return None;
                }
                // Artist-only is intentional. Decompiled stock
                // MediaManagerPlayMediaResolver maps it to
                // queryWithArtistName. Penumbra resolves an exact Spotify
                // artist identity and uses Spotify's artist top-tracks
                // endpoint, preserving the stock top-song behavior without
                // inventing a title in the language layer.
                Some(PlannedMusicAction {
                    action_name: PLAY_MUSIC,
                    thought: "I should play the primary current artist's top catalog result",
                    input_json: serde_json::json!({"Artist": artist}).to_string(),
                })
            }
        };
    }

    if !allow_provider_selection {
        return None;
    }

    if action_is_excluded(request, PLAY_MUSIC) || looks_like_question(&command) {
        return None;
    }
    if let Some(artist) = explicit_top_artist_request(&command) {
        if !valid_catalog_value(artist) || deictic_artist(artist) {
            return None;
        }
        return Some(PlannedMusicAction {
            action_name: PLAY_MUSIC,
            thought: "I should play the named artist's top catalog result",
            input_json: serde_json::json!({"Artist": artist}).to_string(),
        });
    }
    let (track, artist) = direct_track_request(&command)?;
    if !valid_catalog_value(track) || artist.is_some_and(|value| !valid_catalog_value(value)) {
        return None;
    }
    let input_json = match artist {
        Some(artist) => serde_json::json!({"Track": track, "Artist": artist}),
        None => serde_json::json!({"Track": track}),
    };
    Some(PlannedMusicAction {
        action_name: PLAY_MUSIC,
        thought: "I should search the stock music provider for the explicitly requested track",
        input_json: input_json.to_string(),
    })
}

// ─── Visual music ───────────────────────────────────────────────────

/// Whether this is an explicitly user-initiated visual music request. Merely
/// having an image in history never causes playback.
pub fn is_visual_music_request(request: &SynapseUnderstandingRequest) -> bool {
    if !valid_request_envelope(request)
        || request
            .device_context
            .as_ref()
            .is_some_and(|context| context.is_locked)
        || action_is_excluded(request, PLAY_MUSIC)
    {
        return false;
    }
    let Some(command) = normalized_command(&request.utterance) else {
        return false;
    };
    if contains_compound_command(&command) {
        return false;
    }
    let mut command = normalize_catalog_span(&command);
    for prefix in ["please ", "can you ", "could you ", "would you "] {
        if let Some(stripped) = command.strip_prefix(prefix) {
            command = stripped.to_string();
            break;
        }
    }
    if let Some(stripped) = command.strip_suffix(" please") {
        command = stripped.to_string();
    }
    if looks_like_question(&command) {
        return false;
    }
    matches!(
        command.as_str(),
        "play this"
            | "play this song"
            | "play this track"
            | "play this album"
            | "play this artist"
            | "play this record"
            | "play the song in this image"
            | "play the song shown here"
            | "play the album shown here"
            | "play the record in this image"
            | "play the record you see"
            | "play the music in this image"
            | "play the music on this cover"
            | "play what s in the image"
            | "play what is in the image"
            | "play what s shown here"
            | "play what is shown here"
            | "play what s on this album cover"
            | "play what is on this album cover"
    )
}

/// Accept an inline image only when it belongs to the current user turn. An
/// older image elsewhere in the conversation is not a valid target for
/// deictic `play this`.
pub fn linked_current_turn_image(
    request: &SynapseUnderstandingRequest,
    run_id: &str,
) -> Option<Vec<u8>> {
    let turns = &request.device_context.as_ref()?.turns;
    let turn = turns.iter().rev().find(|turn| {
        matches!(
            &turn.content,
            Some(synapse_chat_turn::Content::UserRequest(_))
        )
    })?;
    let synapse_chat_turn::Content::UserRequest(user_request) = turn.content.as_ref()? else {
        return None;
    };
    if user_request.image_data.is_empty()
        || !current_turn_matches_request(user_request, &request.utterance)
        || (!run_id.is_empty() && run_id != "unknown" && turn.identifier != run_id)
    {
        return None;
    }
    Some(user_request.image_data.clone())
}

/// Resolve the immediately preceding, fully parent-linked UnderstandScene run.
/// Stock retains completed-run context for at most 60 seconds; older or
/// partially linked observations cannot retarget a deictic playback command.
pub fn linked_previous_vision_run_id(
    request: &SynapseUnderstandingRequest,
    run_id: &str,
) -> Option<String> {
    let turns = &request.device_context.as_ref()?.turns;
    let current_index = turns.iter().rposition(|turn| {
        matches!(
            &turn.content,
            Some(synapse_chat_turn::Content::UserRequest(_))
        )
    })?;
    let current = &turns[current_index];
    if !run_id.is_empty()
        && run_id != "unknown"
        && !current.identifier.is_empty()
        && current.identifier != run_id
    {
        return None;
    }
    let previous_index = turns[..current_index].iter().rposition(|turn| {
        matches!(
            &turn.content,
            Some(synapse_chat_turn::Content::UserRequest(_))
        )
    })?;
    let previous = &turns[previous_index];
    let synapse_chat_turn::Content::UserRequest(previous_request) = previous.content.as_ref()?
    else {
        return None;
    };
    if previous.identifier.is_empty()
        || (previous_request.vision_requested
            != crate::proto::aibus::synapse_user_request_content::VisionRequested::Vision as i32
            && previous_request.image_data.is_empty())
        || !turns_within_stock_horizon(previous, current)
    {
        return None;
    }

    let action_index = turns[previous_index + 1..current_index]
        .iter()
        .position(|turn| {
            matches!(
                &turn.content,
                Some(synapse_chat_turn::Content::Action(action))
                    if action.action == UNDERSTAND_SCENE
                        && action.source == SynapseSource::Server as i32
                        && turn.parent_identifier == previous.identifier
            )
        })?
        + previous_index
        + 1;
    let action = &turns[action_index];
    if action.identifier.is_empty() {
        return None;
    }
    let observation = turns[action_index + 1..current_index].iter().find(|turn| {
        matches!(
            &turn.content,
            Some(synapse_chat_turn::Content::Observation(observation))
                if observation.action_name == UNDERSTAND_SCENE
                    && observation.source == SynapseSource::Device as i32
                    && turn.parent_identifier == action.identifier
        )
    })?;
    if observation.identifier.is_empty() || current.parent_identifier != observation.identifier {
        return None;
    }
    Some(previous.identifier.clone())
}

pub fn linked_previous_vision_inline_image(
    request: &SynapseUnderstandingRequest,
    run_id: &str,
) -> Option<Vec<u8>> {
    let previous_id = linked_previous_vision_run_id(request, run_id)?;
    request
        .device_context
        .as_ref()?
        .turns
        .iter()
        .find(|turn| turn.identifier == previous_id)
        .and_then(|turn| match &turn.content {
            Some(synapse_chat_turn::Content::UserRequest(user_request))
                if !user_request.image_data.is_empty() =>
            {
                Some(user_request.image_data.clone())
            }
            _ => None,
        })
}

/// Decode the read-only image model result. Low-confidence, ambiguous,
/// malformed, or effectively empty results fail closed.
pub fn parse_visual_music_candidate(value: &str) -> Option<VisualMusicCandidate> {
    if value.is_empty() || value.len() > 4 * 1024 {
        return None;
    }
    let mut candidate: VisualMusicCandidate = serde_json::from_str(value.trim()).ok()?;
    candidate.track = normalize_visual_field(candidate.track)?;
    candidate.artist = normalize_visual_field(candidate.artist)?;
    candidate.album = normalize_visual_field(candidate.album)?;
    if candidate.ambiguous || candidate.confidence == VisualMusicConfidence::Low {
        return None;
    }
    let populated = [
        candidate.track.as_ref(),
        candidate.artist.as_ref(),
        candidate.album.as_ref(),
    ]
    .into_iter()
    .flatten()
    .count();
    if populated == 0 || (candidate.confidence == VisualMusicConfidence::Medium && populated < 2) {
        return None;
    }
    Some(candidate)
}

/// Convert a validated visual entity to the exact stock action schema. The
/// model cannot choose an action name or supply device-only fields.
pub fn plan_visual_music_action(
    request: &SynapseUnderstandingRequest,
    candidate: &VisualMusicCandidate,
) -> Option<PlannedMusicAction> {
    if !is_visual_music_request(request) {
        return None;
    }
    let input = match (
        candidate.track.as_deref(),
        candidate.artist.as_deref(),
        candidate.album.as_deref(),
    ) {
        (Some(track), Some(artist), _) => {
            serde_json::json!({"Track": track, "Artist": artist})
        }
        (Some(track), None, _) => serde_json::json!({"Track": track}),
        (None, Some(artist), Some(album)) => {
            serde_json::json!({"Album": album, "Artist": artist})
        }
        (None, None, Some(album)) => serde_json::json!({"Album": album}),
        (None, Some(artist), None) => serde_json::json!({"Artist": artist}),
        (None, None, None) => return None,
    };
    Some(PlannedMusicAction {
        action_name: PLAY_MUSIC,
        thought: "I should play the explicitly requested music identified in the current image",
        input_json: input.to_string(),
    })
}

/// Build the bounded visual-identification failure response only when the
/// stock caller has not excluded `Respond` from this cascade stage.
pub fn plan_visual_music_failure_response(
    request: &SynapseUnderstandingRequest,
) -> Option<PlannedMusicAction> {
    if action_is_excluded(request, RESPOND) {
        return None;
    }
    Some(PlannedMusicAction {
        action_name: RESPOND,
        thought: "I need a current, unambiguous image before playing visual music",
        input_json: serde_json::json!({
            "Response": "I couldn't identify one unambiguous song, artist, or album in the current image."
        })
        .to_string(),
    })
}

pub fn response_action_allowed(request: &SynapseUnderstandingRequest) -> bool {
    !action_is_excluded(request, RESPOND)
}

/// Restore only explicit generated-playlist requests that missed stock's
/// on-device interpreters.
///
/// Ordinary catalog phrases such as "play my workout playlist" belong to
/// `PlayMusic` and are intentionally not parsed here. The generated action is
/// keyguard-enabled in stock, so known locked and unlocked requests are both
/// accepted. Unknown device state, action exclusions, questions, and compound
/// commands still fail closed.
pub fn plan_generated_playlist_action(
    request: &SynapseUnderstandingRequest,
) -> Option<PlannedMusicAction> {
    if !valid_request_envelope(request)
        || request
            .excluded_tools
            .iter()
            .any(|tool| tool.eq_ignore_ascii_case(GENERATE_MUSIC_PLAYLIST))
    {
        return None;
    }

    let command = normalized_command(&request.utterance)?;
    if looks_like_question(&command) || contains_compound_command(&command) {
        return None;
    }

    let topic = generated_topic(&command)?;
    if !valid_topic(topic) {
        return None;
    }

    Some(PlannedMusicAction {
        action_name: GENERATE_MUSIC_PLAYLIST,
        thought:
            "The user explicitly asked the stock AI-DJ to generate and play a topic-based playlist",
        input_json: serde_json::json!({"Playlist": topic}).to_string(),
    })
}

fn valid_request_envelope(request: &SynapseUnderstandingRequest) -> bool {
    !request.utterance.is_empty()
        && request.utterance.len() <= MAX_UTTERANCE_BYTES
        && !request.utterance.chars().any(char::is_control)
        && request.device_context.is_some()
}

fn action_is_excluded(request: &SynapseUnderstandingRequest, action_name: &str) -> bool {
    request
        .excluded_tools
        .iter()
        .any(|tool| tool.eq_ignore_ascii_case(action_name))
}

/// Parse only exact public stock phrases into fieldless actions. Queue lookup
/// has a bounded set of natural question forms; every state-changing action is
/// imperative and therefore retains the planner's question safety boundary.
fn exact_fieldless_music_action(command: &str) -> Option<FieldlessMusicAction> {
    let normalized = normalize_catalog_span(command);
    let normalized = normalized.strip_prefix("please ").unwrap_or(&normalized);
    let normalized = normalized.strip_suffix(" please").unwrap_or(normalized);

    if matches!(
        normalized,
        "show my music queue"
            | "show the music queue"
            | "get my music queue"
            | "get the music queue"
            | "what is in my music queue"
            | "what s in my music queue"
            | "what is in the music queue"
            | "what s in the music queue"
            | "what song is next in the queue"
            | "what track is next in the queue"
            | "what is the next song in the queue"
            | "what is the next track in the queue"
            | "what song is previous in the queue"
            | "what track is previous in the queue"
            | "what is the previous song in the queue"
            | "what is the previous track in the queue"
    ) {
        return Some(FieldlessMusicAction::GetQueue);
    }

    if looks_like_question(command) {
        return None;
    }

    match normalized {
        "pause"
        | "pause music"
        | "pause the music"
        | "pause the song"
        | "pause the track"
        | "pause playback"
        | "pause the playback"
        | "hold the song for a moment"
        | "stop the music"
        | "stop the song"
        | "stop the track"
        | "stop playback"
        | "stop the playback" => Some(FieldlessMusicAction::Pause),

        "resume"
        | "resume music"
        | "resume the music"
        | "resume the song"
        | "resume the track"
        | "resume playback"
        | "resume the playback"
        | "continue the music"
        | "continue the song"
        | "continue the track"
        | "continue playback"
        | "continue the playback" => Some(FieldlessMusicAction::Resume),

        "next"
        | "next song"
        | "next track"
        | "skip"
        | "skip this song"
        | "skip this track"
        | "skip the song"
        | "skip the track"
        | "skip the current song"
        | "skip the current track" => Some(FieldlessMusicAction::Next),

        "previous"
        | "previous song"
        | "previous track"
        | "go back"
        | "go back to the previous song"
        | "go back to the previous track"
        | "go back to that song"
        | "go back to that track" => Some(FieldlessMusicAction::Previous),

        "restart this song"
        | "restart this track"
        | "restart the song"
        | "restart the track"
        | "restart the current song"
        | "restart the current track"
        | "replay this song"
        | "replay this track"
        | "replay the current song"
        | "replay the current track"
        | "start this song over"
        | "start this track over"
        | "start the current song over"
        | "start the current track over" => Some(FieldlessMusicAction::Restart),

        "play music" | "play some music" | "play something" => {
            Some(FieldlessMusicAction::PlayFeatured)
        }

        "play favorites"
        | "play my favorites"
        | "play favorite song"
        | "play favorite songs"
        | "play favorite track"
        | "play favorite tracks"
        | "play my favorite song"
        | "play my favorite songs"
        | "play my favorite track"
        | "play my favorite tracks"
        | "play favourites"
        | "play my favourites"
        | "play favourite song"
        | "play favourite songs"
        | "play favourite track"
        | "play favourite tracks"
        | "play my favourite song"
        | "play my favourite songs"
        | "play my favourite track"
        | "play my favourite tracks"
        | "play liked song"
        | "play liked songs"
        | "play liked track"
        | "play liked tracks"
        | "play my liked song"
        | "play my liked songs"
        | "play my liked track"
        | "play my liked tracks"
        | "play saved song"
        | "play saved songs"
        | "play saved track"
        | "play saved tracks"
        | "play my saved song"
        | "play my saved songs"
        | "play my saved track"
        | "play my saved tracks"
        | "put on my favorites"
        | "put on my favourites"
        | "put on my liked songs"
        | "put on my liked tracks"
        | "put on my saved songs"
        | "put on my saved tracks" => Some(FieldlessMusicAction::PlayFavorites),

        "save this song"
        | "save this track"
        | "save the current song"
        | "save the current track"
        | "favorite this song"
        | "favorite this track"
        | "favorite the current song"
        | "favorite the current track"
        | "add this song to my favorites"
        | "add this track to my favorites"
        | "add the current song to my favorites"
        | "add the current track to my favorites" => {
            Some(FieldlessMusicAction::SaveCurrentToFavorites)
        }

        "play similar music"
        | "play similar songs"
        | "play similar tracks"
        | "songs like this"
        | "more like this"
        | "play more like this"
        | "more like this one"
        | "track radio"
        | "play current song radio"
        | "play current track radio"
        | "play the current song radio"
        | "play the current track radio"
        | "start a radio from this song"
        | "start a radio from this track"
        | "start a radio from the current song"
        | "start a radio from the current track" => Some(FieldlessMusicAction::PlayCurrentRadio),

        _ => None,
    }
}

/// These terse follow-ups are semantically under-specified: "this" may name
/// an image, a prior assistant answer, or the current song. They are reserved
/// from model fallback, but authorize current-track radio only after the
/// caller supplies validated recent-player context.
fn deictic_current_radio_request(command: &str) -> bool {
    let normalized = normalize_catalog_span(command);
    let normalized = normalized.strip_prefix("please ").unwrap_or(&normalized);
    let normalized = normalized.strip_suffix(" please").unwrap_or(normalized);
    matches!(
        normalized,
        "songs like this" | "more like this" | "more like this one" | "play more like this"
    )
}

/// Reserve polite question-shaped versions of the same exact commands from
/// the open-ended catalog classifier. The deterministic planner deliberately
/// declines those questions, but they must not then be hallucinated into a
/// different `PlayMusic` request merely because they contain the word music.
fn fieldless_music_request_shape(command: &str) -> bool {
    if exact_fieldless_music_action(command).is_some() {
        return true;
    }
    let normalized = normalize_catalog_span(command);
    let stripped = ["can you ", "could you ", "would you ", "will you "]
        .iter()
        .find_map(|prefix| normalized.strip_prefix(prefix));
    stripped.is_some_and(|command| exact_fieldless_music_action(command).is_some())
}

fn contextual_music_intent(command: &str) -> Option<ContextualMusicIntent> {
    let lower = command.to_ascii_lowercase();
    if matches!(
        lower.as_str(),
        "what song is this"
            | "what track is this"
            | "what is playing"
            | "what song is playing"
            | "what track is playing"
            | "what's playing"
    ) {
        return Some(ContextualMusicIntent::CurrentTrackQuestion);
    }
    if matches!(
        lower.as_str(),
        "who made this song"
            | "who made this track"
            | "who is this song by"
            | "who is this track by"
            | "who is this by"
            | "who sings this song"
            | "who sings this"
            | "who performs this"
            | "who performed this"
            | "who is performing this"
            | "who's this by"
            | "whos this by"
            | "what artist is this"
            | "what artist made this song"
    ) {
        return Some(ContextualMusicIntent::CurrentArtistQuestion);
    }
    if matches!(
        lower.as_str(),
        "what album is this from"
            | "which album is this from"
            | "what album is this song from"
            | "which album is this song from"
            | "what album is this track from"
            | "which album is this track from"
    ) {
        return Some(ContextualMusicIntent::CurrentAlbumQuestion);
    }
    if matches!(
        lower.as_str(),
        "play the most popular song by this artist"
            | "play the most popular track by this artist"
            | "play this artist's most popular song"
            | "play this artist's biggest song"
            | "play the biggest song by this artist"
            | "play their most popular song"
            | "play their biggest song"
            | "play the top song by this artist"
    ) {
        return Some(ContextualMusicIntent::PlayPrimaryArtistTopSong);
    }
    None
}

fn valid_recent_track(track: &MusicActivityRecord) -> Option<&MusicActivityRecord> {
    if track.title.trim().is_empty()
        || track.title.eq_ignore_ascii_case("unknown track")
        || track.artists.is_empty()
        || !valid_catalog_value(&track.title)
        || track
            .artists
            .iter()
            .any(|artist| !valid_catalog_value(artist))
    {
        None
    } else {
        Some(track)
    }
}

/// A track is "active" only when the stock media session reports it as
/// currently playing. Completed or interrupted tracks are valid recent
/// context for grounding follow-up requests, but they must not be presented
/// as if they are still playing.
fn track_status_is_active(track: &MusicActivityRecord) -> bool {
    track.status.eq_ignore_ascii_case("playing")
}

fn direct_track_request(command: &str) -> Option<(&str, Option<&str>)> {
    let lower = command.to_ascii_lowercase();
    let rest = ["play ", "put on ", "listen to "]
        .into_iter()
        .find_map(|prefix| {
            if lower.starts_with(prefix) {
                command.get(prefix.len()..)
            } else {
                None
            }
        })?;
    let rest = rest.trim();
    let rest_lower = rest.to_ascii_lowercase();
    if rest.is_empty()
        || generic_or_deictic_track(&rest_lower)
        || reserved_catalog_request(&rest_lower)
    {
        return None;
    }
    let explicit_track_label = strip_leading_track_label(rest).len() != rest.len();
    let rest = strip_leading_track_label(rest);
    if rest.is_empty() {
        return None;
    }
    let lower = rest.to_ascii_lowercase();
    if let Some(index) = lower.rfind(" by ") {
        let track = rest[..index].trim();
        let artist = rest[index + 4..].trim();
        if !track.is_empty()
            && !artist.is_empty()
            && (explicit_track_label || !generic_or_deictic_track(&track.to_ascii_lowercase()))
        {
            return Some((track, Some(strip_leading_artist_label(artist))));
        }
    }
    // A bare `play <value>` cannot lexically distinguish a track title from
    // an artist, album, or genre. Leave it to the constrained classifier,
    // which can select only utterance-grounded stock catalog fields. Keep the
    // deterministic fast path only when the user explicitly said song/track.
    explicit_track_label.then_some((rest, None))
}

/// Content-free diagnostic: does the utterance match the deterministic
/// direct ranked grammar? Booleans only; used for cascade observability.
pub(crate) fn matches_direct_top_grammar(utterance: &str) -> bool {
    normalized_command(utterance)
        .as_deref()
        .and_then(explicit_top_artist_request)
        .is_some()
}

fn explicit_top_artist_request(command: &str) -> Option<&str> {
    let lower = command.to_ascii_lowercase();
    // Ranked-artist superlatives stock's cloud resolved to "this artist's top
    // catalog track" (queryWithArtistName, top result). "best" was missing and
    // only singular nouns were listed, so "play the best song by X" — and its
    // natural plural "play the best songs by X" — slipped past this branch and
    // were mis-parsed one branch lower as a literal track titled "the best
    // song(s)". Cover every superlative with both singular and plural nouns,
    // with and without the leading article, so no natural phrasing lands on the
    // literal-track path or needlessly reaches the model. Prefixes are lowercase
    // ASCII so `prefix.len()` byte-slices the case-preserving `command`.
    const SUPERLATIVES: [&str; 4] = ["most popular", "biggest", "top", "best"];
    const NOUNS: [&str; 4] = ["song", "songs", "track", "tracks"];
    for superlative in SUPERLATIVES {
        for noun in NOUNS {
            for article in ["the ", ""] {
                let prefix = format!("play {article}{superlative} {noun} by ");
                if lower.starts_with(&prefix) {
                    return Some(command[prefix.len()..].trim());
                }
            }
        }
    }
    // Possessive form: "play <artist>'s most popular song". Stock's cloud
    // resolved this identically to the "by <artist>" form above — the named
    // artist's top catalog track — but only the "by" phrasing was covered, so
    // the possessive fell through every deterministic path into the full
    // agentic loop. That is the canonical request shape ("play Dr. Dre's most
    // popular song") and it measured ~5.7s where the deterministic path answers
    // in ~100ms.
    //
    // The artist is the span between "play " and the possessive suffix, so it
    // stays an exact slice of the utterance and is never invented. A deictic
    // possessive ("this artist's most popular song") is extracted too, but the
    // call site rejects it with `deictic_artist` and it falls through to the
    // context-aware `PlayPrimaryArtistTopSong` path, unchanged. `to_ascii_lowercase`
    // preserves byte length and offsets, so a suffix length measured on `rest`
    // (a byte-for-byte lowercased view minus the ASCII "play " prefix) indexes
    // the case-preserving `command` correctly; the curly apostrophe is non-ASCII
    // and therefore identical in both.
    if let Some(rest) = lower.strip_prefix("play ") {
        for superlative in SUPERLATIVES {
            for noun in NOUNS {
                for possessive in ["'s ", "\u{2019}s "] {
                    let suffix = format!("{possessive}{superlative} {noun}");
                    if let Some(artist_lower) = rest.strip_suffix(&suffix) {
                        if !artist_lower.is_empty() {
                            let artist_start = "play ".len();
                            let artist_end = artist_start + artist_lower.len();
                            return Some(command[artist_start..artist_end].trim());
                        }
                    }
                }
            }
        }
    }
    None
}

/// Parse one semantically single lookup-and-play request before the generic
/// compound-command guard. The artist is returned as an exact slice of the
/// utterance; the language layer never selects or invents a track title.
///
/// This deliberately accepts only a bounded grammar whose first clause asks
/// for an artist's ranked songs and whose final clause plays the first/top
/// result. Any extra command, prompt-injection marker, or deictic artist stays
/// on the ordinary fail-closed path.
pub(super) fn named_artist_lookup_and_play_top_request(command: &str) -> Option<&str> {
    if looks_like_prompt_injection(command) {
        return None;
    }

    let lower = command.to_ascii_lowercase();
    let start = if lower.starts_with("please ") {
        "please ".len()
    } else {
        0
    };
    let end = if lower.ends_with(" please") {
        command.len().checked_sub(" please".len())?
    } else {
        command.len()
    };
    if start >= end {
        return None;
    }
    let command = command[start..end].trim();
    let lower = command.to_ascii_lowercase();

    // Generated rather than hand-enumerated, because the hand-written list had
    // two gaps that the most natural phrasing of this exact request falls into.
    // It carried only PLURAL nouns and only EXPLICIT playback tails, so
    // "look up the best song by <artist> and play it" — singular noun, bare
    // anaphoric tail — matched neither and fell through to the model. Measured
    // on device: 3522ms of model time spent deciding to call the very tool this
    // grammar names, for a request the grammar already understood.
    //
    // "song"/"songs" and "it"/"the top one" are the same request. Widening the
    // surface forms changes nothing about authority: the artist span below
    // still passes the identical deictic, compound-command, punctuation and
    // injection checks, and the language layer still never names a track.
    const LOOKUP_VERBS: [&str; 4] = ["look up ", "lookup ", "find ", "search for "];
    const RANKED_SUPERLATIVES: [&str; 4] = ["best", "top", "most popular", "biggest"];
    const RANKED_NOUNS: [&str; 4] = ["song", "songs", "track", "tracks"];
    let prefix_len = LOOKUP_VERBS.iter().find_map(|verb| {
        RANKED_SUPERLATIVES.iter().find_map(|superlative| {
            RANKED_NOUNS.iter().find_map(|noun| {
                ["the ", ""].iter().find_map(|article| {
                    let candidate = format!("{verb}{article}{superlative} {noun} by ");
                    lower.starts_with(&candidate).then_some(candidate.len())
                })
            })
        })
    })?;
    // The bare anaphors ("it", "that") are only unambiguous because the prefix
    // above already fixed the referent to this artist's ranked songs.
    let suffix = [
        " and play it",
        " and play that",
        " and then play it",
        " then play it",
        " and play the most popular",
        " and play the most popular one",
        " and play the most popular song",
        " and play the most popular track",
        " and play the top one",
        " and play the top song",
        " and play the top track",
        " and play the best one",
        " and play the best song",
        " and play the best track",
        " and play the first one",
    ]
    .into_iter()
    .find(|suffix| lower.ends_with(suffix))?;
    let artist_end = command.len().checked_sub(suffix.len())?;
    if prefix_len >= artist_end {
        return None;
    }
    let prefix = &command[..prefix_len];
    let artist = command[prefix.len()..artist_end].trim();
    if !valid_catalog_value(artist)
        || deictic_artist(artist)
        || contains_compound_command(artist)
        || !ranked_artist_punctuation_is_supported(artist)
        || looks_like_prompt_injection(artist)
    {
        return None;
    }
    Some(artist)
}

/// Parse one exact catalog-query -> rank-one playback request. This grammar is
/// intentionally separate from the ranked-artist grammar above: the query is
/// sent to `MusicCatalogSearch`, not reinterpreted as an artist, and only the
/// provider's unique first row may later authorize playback.
///
/// The narrow surface keeps the query an exact user span and prevents an
/// additional action, ranking instruction, deictic reference, or clause
/// delimiter from hiding inside the lookup text.
pub(super) fn catalog_lookup_and_play_rank_one_request(command: &str) -> Option<&str> {
    if looks_like_prompt_injection(command) {
        return None;
    }

    let lower = command.to_ascii_lowercase();
    let start = if lower.starts_with("please ") {
        "please ".len()
    } else {
        0
    };
    let end = if lower.ends_with(" please") {
        command.len().checked_sub(" please".len())?
    } else {
        command.len()
    };
    if start >= end {
        return None;
    }
    let command = command[start..end].trim();
    let lower = command.to_ascii_lowercase();

    let prefix = ["search for ", "look up "]
        .into_iter()
        .find(|prefix| lower.starts_with(prefix))?;
    let suffix = [
        " and play the first result",
        " and play the first one",
        " and play the top result",
        " and play the top one",
    ]
    .into_iter()
    .find(|suffix| lower.ends_with(suffix))?;
    let query_end = command.len().checked_sub(suffix.len())?;
    if prefix.len() >= query_end {
        return None;
    }
    let query = command[prefix.len()..query_end].trim();
    if !valid_catalog_value(query)
        || catalog_rank_one_query_is_ambiguous(query)
        || !catalog_rank_one_query_punctuation_is_supported(query)
        || ranked_artist_contains_action_cue(query)
        || looks_like_prompt_injection(query)
    {
        return None;
    }
    Some(query)
}

fn catalog_rank_one_query_is_ambiguous(query: &str) -> bool {
    let normalized = normalize_catalog_span(query);
    if generic_or_deictic_track(&normalized) {
        return true;
    }
    let padded = format!(" {normalized} ");
    [" and ", " or ", " versus ", " vs "]
        .iter()
        .any(|marker| padded.contains(marker))
        || normalized.split_whitespace().any(|word| {
            matches!(
                word,
                "best"
                    | "first"
                    | "second"
                    | "third"
                    | "top"
                    | "last"
                    | "least"
                    | "most"
                    | "popular"
                    | "result"
                    | "results"
            )
        })
}

fn catalog_rank_one_query_punctuation_is_supported(query: &str) -> bool {
    query.chars().all(|character| {
        character.is_alphanumeric()
            || character.is_whitespace()
            || matches!(character, '\'' | '’' | '&')
    })
}

/// This compound grammar intentionally supports a smaller artist-name surface
/// than ordinary direct catalog playback. Unsupported punctuation is an
/// ambiguous clause delimiter, while standalone stock-action cue tokens can
/// hide a second command before the final `and play` suffix. Commas are kept
/// only for the bounded `Name, Name & Name` spelling used by acts such as
/// Earth, Wind & Fire.
fn ranked_artist_punctuation_is_supported(artist: &str) -> bool {
    if artist.chars().any(|character| {
        !(character.is_alphanumeric()
            || character.is_whitespace()
            || matches!(character, '\'' | '’' | '&' | ','))
    }) {
        return false;
    }
    let comma_count = artist.chars().filter(|character| *character == ',').count();
    let comma_is_supported = comma_count == 0
        || (comma_count == 1
            && artist
                .split_once(',')
                .is_some_and(|(left, right)| !left.trim().is_empty() && right.contains(" & ")));
    comma_is_supported && !ranked_artist_contains_action_cue(artist)
}

fn ranked_artist_contains_action_cue(artist: &str) -> bool {
    const STOCK_ACTION_CUES: &[&str] = &[
        "accept",
        "action",
        "activity",
        "add",
        "airplane",
        "alarm",
        "answer",
        "automation",
        "battery",
        "begin",
        "bluetooth",
        "brightness",
        "call",
        "calories",
        "cancel",
        "capture",
        "catch",
        "change",
        "clear",
        "clock",
        "compose",
        "connect",
        "connected",
        "connection",
        "contact",
        "contacts",
        "context",
        "count",
        "countdown",
        "create",
        "decline",
        "decrease",
        "decrement",
        "delete",
        "device",
        "dial",
        "dialer",
        "dialpad",
        "directions",
        "disconnect",
        "display",
        "edit",
        "email",
        "end",
        "finish",
        "flight",
        "food",
        "forget",
        "generate",
        "get",
        "hang",
        "hangup",
        "hold",
        "identify",
        "if",
        "increase",
        "increment",
        "internet",
        "language",
        "list",
        "listen",
        "location",
        "lock",
        "look",
        "log",
        "loud",
        "lower",
        "make",
        "meal",
        "memory",
        "message",
        "messages",
        "miss",
        "mute",
        "navigate",
        "navigation",
        "next",
        "note",
        "nutrition",
        "number",
        "online",
        "open",
        "pair",
        "pause",
        "percentage",
        "phone",
        "photo",
        "photograph",
        "photos",
        "pick",
        "picture",
        "play",
        "playlist",
        "previous",
        "private",
        "privacy",
        "put",
        "queue",
        "queued",
        "quick",
        "raise",
        "read",
        "recent",
        "record",
        "recording",
        "reject",
        "remove",
        "reminder",
        "remember",
        "respond",
        "restart",
        "resume",
        "route",
        "run",
        "scene",
        "search",
        "see",
        "send",
        "serial",
        "set",
        "settings",
        "show",
        "shoot",
        "sings",
        "skip",
        "snooze",
        "start",
        "status",
        "stop",
        "take",
        "text",
        "tickle",
        "time",
        "timer",
        "track",
        "tracker",
        "translate",
        "translation",
        "tutorial",
        "turn",
        "unhold",
        "unlock",
        "unpair",
        "unmute",
        "update",
        "video",
        "vision",
        "volume",
        "wake",
        "walk",
        "weather",
        "when",
        "wifi",
        "workout",
        "write",
    ];
    normalize_catalog_span(artist)
        .split_whitespace()
        .any(|token| STOCK_ACTION_CUES.contains(&token))
}

/// Apply the exact ranked-artist grammar to a raw utterance while preserving
/// the artist's original spelling and punctuation in an owned value. This is
/// the shared entry point for the runtime completion classifier and the
/// provider-backed production handler; neither is allowed to approximate the
/// grammar independently.
pub(crate) fn named_artist_lookup_and_play_top_artist(utterance: &str) -> Option<String> {
    if utterance.is_empty()
        || utterance.len() > MAX_UTTERANCE_BYTES
        || utterance.chars().any(char::is_control)
    {
        return None;
    }
    let command = normalized_command(utterance)?;
    named_artist_lookup_and_play_top_request(&command).map(str::to_string)
}

/// Apply the strict catalog-query grammar to a raw utterance while preserving
/// the query's spelling as the single source-authorized provider argument.
pub(crate) fn catalog_lookup_and_play_rank_one_query(utterance: &str) -> Option<String> {
    if utterance.is_empty()
        || utterance.len() > MAX_UTTERANCE_BYTES
        || utterance.chars().any(char::is_control)
    {
        return None;
    }
    let command = normalized_command(utterance)?;
    catalog_lookup_and_play_rank_one_request(&command).map(str::to_string)
}

fn deictic_artist(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "this artist" | "that artist" | "the artist" | "them" | "their"
    )
}

fn strip_leading_track_label(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    for prefix in ["the song ", "the track ", "song ", "track "] {
        if lower.starts_with(prefix) {
            return value[prefix.len()..].trim();
        }
    }
    value.trim()
}

fn strip_leading_artist_label(value: &str) -> &str {
    let lower = value.to_ascii_lowercase();
    for prefix in ["the artist ", "artist ", "the band ", "band "] {
        if lower.starts_with(prefix) {
            return value[prefix.len()..].trim();
        }
    }
    value.trim()
}

fn generic_or_deictic_track(value: &str) -> bool {
    matches!(
        value,
        "music"
            | "some music"
            | "something"
            | "anything"
            | "a song"
            | "a track"
            | "song"
            | "songs"
            | "track"
            | "tracks"
            | "favorite song"
            | "favorite songs"
            | "favorite track"
            | "favorite tracks"
            | "my favorite song"
            | "my favorite songs"
            | "my favorite track"
            | "my favorite tracks"
            | "favourite song"
            | "favourite songs"
            | "favourite track"
            | "favourite tracks"
            | "my favourite song"
            | "my favourite songs"
            | "my favourite track"
            | "my favourite tracks"
            | "saved song"
            | "saved songs"
            | "saved track"
            | "saved tracks"
            | "my saved song"
            | "my saved songs"
            | "my saved track"
            | "my saved tracks"
            | "this"
            | "this song"
            | "this track"
            | "this album"
            | "this artist"
            | "it"
            | "that"
            | "that song"
            | "that track"
            | "the most popular song by this artist"
            | "the biggest song by this artist"
    )
}

fn reserved_catalog_request(value: &str) -> bool {
    [
        "album ",
        "the album ",
        "artist ",
        "the artist ",
        "genre ",
        "the genre ",
        "playlist ",
        "the playlist ",
        "my playlist ",
        "music by ",
        "music from ",
        "a playlist ",
        "a mix ",
    ]
    .iter()
    .any(|prefix| value.starts_with(prefix))
}

/// Named playlists and complete library-collection commands are owned by
/// stock's device intent path. Library words inside a title or artist are data,
/// not action authority: `play My Favourite Game` must still reach the bounded
/// catalog classifier, while `play my favourites` remains reserved locally.
fn stock_owned_playlist_or_favorites_request(command: &str) -> bool {
    let normalized = normalize_catalog_span(command);
    let words = normalized.split_whitespace().collect::<Vec<_>>();
    // The generated-playlist planner runs before this classifier gate. Once it
    // declines, every remaining playlist/library phrase must stay with stock;
    // do not depend on an open-ended list of playback verbs here.
    if words
        .iter()
        .any(|word| matches!(*word, "playlist" | "playlists"))
    {
        return true;
    }
    complete_library_collection_request(&normalized)
}

fn complete_library_collection_request(command: &str) -> bool {
    let command = command.strip_prefix("please ").unwrap_or(command);
    let command = command.strip_suffix(" please").unwrap_or(command);
    let command = ["can you ", "could you ", "would you ", "will you "]
        .iter()
        .find_map(|prefix| command.strip_prefix(prefix))
        .unwrap_or(command);
    let collection = [
        "play ",
        "put on ",
        "throw on ",
        "fire up ",
        "crank ",
        "give me ",
        "i want ",
        "how about ",
    ]
    .iter()
    .find_map(|prefix| command.strip_prefix(prefix));
    collection.is_some_and(|collection| {
        matches!(
            collection,
            "favorites"
                | "my favorites"
                | "favorite song"
                | "favorite songs"
                | "favorite track"
                | "favorite tracks"
                | "my favorite song"
                | "my favorite songs"
                | "my favorite track"
                | "my favorite tracks"
                | "favourites"
                | "my favourites"
                | "favourite song"
                | "favourite songs"
                | "favourite track"
                | "favourite tracks"
                | "my favourite song"
                | "my favourite songs"
                | "my favourite track"
                | "my favourite tracks"
                | "liked song"
                | "liked songs"
                | "liked track"
                | "liked tracks"
                | "my liked song"
                | "my liked songs"
                | "my liked track"
                | "my liked tracks"
                | "saved song"
                | "saved songs"
                | "saved track"
                | "saved tracks"
                | "my saved song"
                | "my saved songs"
                | "my saved track"
                | "my saved tracks"
        )
    })
}

fn valid_catalog_value(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= MAX_TOPIC_BYTES
        && value.split_whitespace().count() <= MAX_CATALOG_QUERY_WORDS
        && !value.chars().any(char::is_control)
}

fn normalize_ai_field(value: Option<String>) -> Option<Option<String>> {
    let value = normalize_visual_field(value)?;
    if value
        .as_deref()
        .is_some_and(|value| !valid_catalog_value(value))
    {
        return None;
    }
    Some(value)
}

fn ai_catalog_fields(candidate: &AiMusicCandidate) -> [Option<&str>; 4] {
    [
        candidate.track.as_deref(),
        candidate.artist.as_deref(),
        candidate.album.as_deref(),
        candidate.genre.as_deref(),
    ]
}

fn valid_ai_catalog_combination(candidate: &AiMusicCandidate) -> bool {
    matches!(
        ai_catalog_fields(candidate),
        [Some(_), Some(_), None, None]
            | [Some(_), None, None, None]
            | [None, Some(_), Some(_), None]
            | [None, None, Some(_), None]
            | [None, Some(_), None, None]
            | [None, None, None, Some(_)]
    )
}

fn ai_fields_are_grounded(
    candidate: &AiMusicCandidate,
    utterance: &str,
    recent_track: Option<&MusicActivityRecord>,
) -> bool {
    let utterance = normalize_catalog_span(utterance);
    let allows_recent_playback = allows_conversation_music_grounding(&utterance);
    let field_is_grounded = |value: Option<&str>, verified_values: &[&str]| {
        value.is_none_or(|value| {
            let value = normalize_catalog_span(value);
            !value.is_empty()
                && (normalized_span_contains(&utterance, &value)
                    || (allows_recent_playback
                        && verified_values
                            .iter()
                            .any(|verified| normalize_catalog_span(verified) == value)))
        })
    };
    let verified_track = recent_track.and_then(valid_recent_track);
    let verified_titles = verified_track
        .map(|track| vec![track.title.as_str()])
        .unwrap_or_default();
    let verified_artists = verified_track
        .map(|track| track.artists.iter().map(String::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let verified_albums = verified_track
        .and_then(|track| track.album.as_deref())
        .map(|album| vec![album])
        .unwrap_or_default();

    field_is_grounded(candidate.track.as_deref(), &verified_titles)
        && field_is_grounded(candidate.artist.as_deref(), &verified_artists)
        && field_is_grounded(candidate.album.as_deref(), &verified_albums)
        && field_is_grounded(candidate.genre.as_deref(), &[])
}

fn normalized_span_contains(haystack: &str, needle: &str) -> bool {
    haystack == needle
        || haystack.starts_with(&format!("{needle} "))
        || haystack.ends_with(&format!(" {needle}"))
        || haystack.contains(&format!(" {needle} "))
}

fn allows_conversation_music_grounding(command: &str) -> bool {
    let padded = format!(" {command} ");
    [
        " it ",
        " that ",
        " this ",
        " their ",
        " them ",
        " they ",
        " him ",
        " his ",
        " her ",
        " same ",
        " the artist ",
        " that artist ",
        " this artist ",
        " that song ",
        " this song ",
        " that track ",
        " this track ",
    ]
    .iter()
    .any(|marker| padded.contains(marker))
}

fn bounded_music_context_item(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() || value.chars().any(char::is_control) {
        return None;
    }
    let mut bounded = String::new();
    for character in value.chars() {
        if bounded.len() + character.len_utf8() > MAX_MUSIC_CONVERSATION_ITEM_BYTES {
            break;
        }
        bounded.push(character);
    }
    let bounded = bounded.trim();
    (!bounded.is_empty()).then(|| bounded.to_string())
}

fn normalize_catalog_span(value: &str) -> String {
    value
        .chars()
        .flat_map(char::to_lowercase)
        .map(|character| {
            if character.is_alphanumeric() {
                character
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn fixed_ai_music_response(
    request: &SynapseUnderstandingRequest,
    thought: &'static str,
    response: &str,
) -> Option<PlannedMusicAction> {
    if action_is_excluded(request, RESPOND) {
        return None;
    }
    Some(PlannedMusicAction {
        action_name: RESPOND,
        thought,
        input_json: serde_json::json!({"Response": response}).to_string(),
    })
}

fn informational_question(command: &str) -> bool {
    let normalized = normalize_catalog_span(command);
    if normalized.starts_with("how about ") {
        return false;
    }
    [
        "what ", "who ", "why ", "how ", "when ", "where ", "which ", "is ", "are ", "does ",
        "do ", "did ",
    ]
    .iter()
    .any(|prefix| normalized.starts_with(prefix))
}

fn looks_like_prompt_injection(command: &str) -> bool {
    let lower = command.to_ascii_lowercase();
    [
        "ignore previous",
        "ignore all",
        "ignore the system",
        "system prompt",
        "developer message",
        "output json",
        "return json",
        "playmusic action",
        "action_name",
        "tool call",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn natural_list(values: &[String]) -> String {
    match values {
        [] => String::new(),
        [only] => only.clone(),
        [first, second] => format!("{first} and {second}"),
        _ => {
            let (last, rest) = values.split_last().expect("non-empty");
            format!("{}, and {last}", rest.join(", "))
        }
    }
}

fn current_turn_matches_request(turn: &SynapseUserRequestContent, utterance: &str) -> bool {
    let turn_request = if !turn.repaired_request.trim().is_empty() {
        turn.repaired_request.trim()
    } else {
        turn.request.trim()
    };
    normalize_for_link(turn_request) == normalize_for_link(utterance)
}

fn turns_within_stock_horizon(
    previous: &crate::proto::aibus::SynapseChatTurn,
    current: &crate::proto::aibus::SynapseChatTurn,
) -> bool {
    let (Some(previous), Some(current)) = (previous.timestamp.as_ref(), current.timestamp.as_ref())
    else {
        return false;
    };
    if !(0..1_000_000_000).contains(&previous.nanos) || !(0..1_000_000_000).contains(&current.nanos)
    {
        return false;
    }
    let previous_nanos = i128::from(previous.seconds) * 1_000_000_000 + i128::from(previous.nanos);
    let current_nanos = i128::from(current.seconds) * 1_000_000_000 + i128::from(current.nanos);
    let elapsed = current_nanos - previous_nanos;
    (0..=i128::from(STOCK_CONTEXT_SECONDS) * 1_000_000_000).contains(&elapsed)
}

fn normalize_for_link(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(['.', '?', '!'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

fn normalize_visual_field(value: Option<String>) -> Option<Option<String>> {
    let Some(value) = value else {
        return Some(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Some(None);
    }
    if value.chars().count() > MAX_VISUAL_FIELD_CHARS
        || value.chars().any(char::is_control)
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "unknown" | "unclear" | "unsure" | "null" | "n/a"
        )
    {
        return None;
    }
    Some(Some(value.to_string()))
}

fn normalized_command(value: &str) -> Option<String> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    let value = value.trim_end_matches(['.', '?', '!']).trim_end();
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn generated_topic(command: &str) -> Option<&str> {
    let lowered = command.to_lowercase();
    if lowered.len() != command.len() {
        // Unicode lowercasing can change byte length. Generated command words
        // are ASCII; reject the ambiguous case instead of slicing unsafely.
        return None;
    }
    let prefix_bytes = usize::from(lowered.starts_with("please ")) * "please ".len();
    let lower = lowered.get(prefix_bytes..)?;
    let command = command.get(prefix_bytes..)?;

    for prefix in [
        "make me a playlist for ",
        "make a playlist for ",
        "create a playlist for ",
        "generate a playlist for ",
        "make me a mix for ",
        "make a mix for ",
        "create a mix for ",
        "generate a mix for ",
        "play a playlist for ",
        "play a mix for ",
    ] {
        if lower.starts_with(prefix) {
            return command.get(prefix.len()..).map(str::trim);
        }
    }

    for (prefix, suffix) in [
        ("make me a ", " playlist"),
        ("make a ", " playlist"),
        ("create a ", " playlist"),
        ("generate a ", " playlist"),
        ("make me a ", " mix"),
        ("make a ", " mix"),
        ("create a ", " mix"),
        ("generate a ", " mix"),
        ("play a ", " mix"),
        ("play an ", " mix"),
    ] {
        if lower.starts_with(prefix) && lower.ends_with(suffix) {
            let topic_end = command.len().checked_sub(suffix.len())?;
            return command.get(prefix.len()..topic_end).map(str::trim);
        }
    }

    None
}

fn valid_topic(topic: &str) -> bool {
    if topic.is_empty()
        || topic.len() > MAX_TOPIC_BYTES
        || topic.chars().any(char::is_control)
        || topic.split_whitespace().count() > MAX_TOPIC_WORDS
    {
        return false;
    }

    let normalized = topic.to_lowercase();
    !matches!(
        normalized.as_str(),
        "a playlist"
            | "the playlist"
            | "playlist"
            | "a mix"
            | "the mix"
            | "mix"
            | "music"
            | "songs"
            | "something"
            | "anything"
    ) && !normalized.starts_with("my playlist ")
        && !normalized.starts_with("playlist called ")
}

fn looks_like_question(command: &str) -> bool {
    let lower = command.to_lowercase();
    [
        "can you ",
        "could you ",
        "would you ",
        "will you ",
        "do you ",
        "how ",
        "what ",
        "why ",
        "when ",
        "where ",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
}

fn contains_compound_command(command: &str) -> bool {
    let lower = format!(" {} ", command.to_lowercase());
    if lower.contains(';') || lower.contains(" and then ") || lower.contains(" then ") {
        return true;
    }
    const COMMANDS: &[&str] = &[
        "play", "call", "text", "send", "take", "record", "turn", "set", "delete", "stop", "open",
        "create", "make", "generate",
    ];
    COMMANDS
        .iter()
        .any(|command| lower.contains(&format!(" and {command} ")))
}

#[cfg(test)]
#[path = "music/tests.rs"]
mod tests;

#[cfg(test)]
mod grammar_probe_tests {
    use super::*;

    #[test]
    fn direct_top_grammar_probe_matches_the_natural_phrasing() {
        assert!(matches_direct_top_grammar(
            "play the most popular song by drake"
        ));
        assert!(matches_direct_top_grammar(
            "play the top song by Michael Jackson"
        ));
        assert!(!matches_direct_top_grammar("what time is it"));
    }

    #[test]
    fn best_and_plural_superlatives_route_to_the_top_artist_path() {
        // The stock-punted headline phrasing and its variants must resolve to
        // the named artist's top track, not a literal "the best song" search.
        for utterance in [
            "play the best song by michael jackson",
            "play the best songs by michael jackson",
            "play best track by drake",
            "play the top songs by drake",
            "play the biggest tracks by prince",
            "play most popular songs by adele",
        ] {
            assert!(
                matches_direct_top_grammar(utterance),
                "should match top-artist grammar: {utterance}"
            );
        }
        // The extracted artist is exactly the trailing slice, case preserved.
        assert_eq!(
            explicit_top_artist_request("play the best songs by Michael Jackson"),
            Some("Michael Jackson")
        );
        // A literal titled track (no superlative-by-artist shape) is untouched.
        assert!(explicit_top_artist_request("play thriller by michael jackson").is_none());
    }

    #[test]
    fn possessive_top_artist_grammar_matches_the_canonical_phrasing() {
        // "play <artist>'s most popular song" — the canonical shape — used to
        // fall through every deterministic path into the agentic loop. It now
        // resolves to the same named-artist top-track action as the "by" form,
        // with the artist extracted as an exact, case-preserved slice.
        for (utterance, artist) in [
            ("play Dr. Dre's most popular song", "Dr. Dre"),
            ("play Drake's biggest hit song", "Drake's biggest hit"), // see note below
            ("play Adele's top track", "Adele"),
            ("play Michael Jackson's best songs", "Michael Jackson"),
            ("play Prince\u{2019}s biggest tracks", "Prince"), // curly apostrophe
        ] {
            // The "biggest hit song" case documents the surface bound: only the
            // listed nouns (song/songs/track/tracks) close the phrase, so
            // "biggest hit song" is not the grammar and that row is a control —
            // it must NOT be treated as a top-artist request.
            if artist == "Drake's biggest hit" {
                assert!(
                    explicit_top_artist_request(utterance).is_none(),
                    "unlisted noun must not match: {utterance}"
                );
                continue;
            }
            assert_eq!(
                explicit_top_artist_request(utterance),
                Some(artist),
                "possessive top-artist grammar: {utterance}"
            );
            assert!(
                matches_direct_top_grammar(utterance),
                "diagnostic must agree: {utterance}"
            );
        }

        // Negative controls.
        // A specific track by possessive is NOT a top-song request.
        assert!(explicit_top_artist_request("play Dr. Dre's Still D.R.E.").is_none());
        // A deictic possessive is extracted but the call-site `deictic_artist`
        // guard defers it to the context-aware path; the parser returns the
        // deictic span, which that guard then rejects.
        assert_eq!(
            explicit_top_artist_request("play this artist's most popular song"),
            Some("this artist")
        );
        assert!(deictic_artist("this artist"));
        // An empty artist span never matches.
        assert!(explicit_top_artist_request("play 's most popular song").is_none());

        // BOUNDARY GUARD — do not widen this grammar to the "best of X" idiom.
        // The possessive form is safe because "<artist>'s most popular song"
        // cannot itself be a track title. "the best of X" is NOT safe: "The
        // Best of You" (Foo Fighters), "The Best of Me" and "The Best of Both
        // Worlds" are real song titles, so extracting the tail as an artist
        // would misroute them to artist-top-tracks. They are lexically
        // ambiguous and must stay on the agentic path, which can weigh context.
        // These MUST remain `None`; a failure here means someone widened the
        // deterministic surface into the misroute.
        for ambiguous in [
            "play the best of you",
            "play the best of me",
            "play the best of both worlds",
        ] {
            assert!(
                explicit_top_artist_request(ambiguous).is_none(),
                "ambiguous song-title idiom must stay agentic: {ambiguous}"
            );
        }
    }
}
