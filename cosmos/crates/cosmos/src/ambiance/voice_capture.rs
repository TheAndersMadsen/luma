//! Capture is the runtime's bounded receive interval. An endpoint or transport
//! sample count never establishes complete reception of a sender's utterance.
use super::PinMedia;
use crate::ambiance::{InputStamp, RuntimeResult, voice::LocalVoice};
use cosmos_rtc::audio::{
    AudioReceiver, Binding as AudioBinding, FRAME_SAMPLES, SAMPLE_RATE, TrackId, pcm::Mono48To16,
};
use cosmos_stt::{Cancellation, Language, LocalRecognizer, Pcm16Mono, Recognition};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;
use tonic::Status;

const CAPTURE_LIMIT: Duration = Duration::from_secs(15);
const RECEIVE_TAIL: Duration = Duration::from_millis(300);
const RECOGNITION_LIMIT: Duration = Duration::from_secs(20);
const MAX_SOURCE_SAMPLES: usize = SAMPLE_RATE as usize * 15;

impl PinMedia {
    /// Capture and recognize one admitted native request. `end` belongs to
    /// this exact invocation; losing it cancels capture. The caller primes the
    /// publication with synthetic zeros, then enables its microphone only
    /// after `ready`. On end it stops microphone input and retains publication
    /// through completion. A bounded receive tail is a server endpoint rule,
    /// not an acknowledgment that all sender audio arrived.
    pub async fn capture_voice(
        &self,
        stamp: InputStamp,
        track: TrackId,
        language: Language,
        recognizer: &LocalRecognizer,
        ready: oneshot::Sender<()>,
        end: oneshot::Receiver<()>,
    ) -> Result<Option<RuntimeResult>, Status> {
        let Some(mut intake) = self.begin_local_voice(stamp.clone(), track.clone()).await? else {
            return Ok(None);
        };
        let binding = AudioBinding {
            epoch: stamp.epoch,
            generation: intake.fence.generation,
            track,
        };
        let mut receiver = intake
            .while_pending(async {
                self.session
                    .subscribe(binding)
                    .await
                    .map_err(|_| audio_unavailable())
            })
            .await?;
        let deadline = Instant::now() + CAPTURE_LIMIT;
        let pcm = tokio::time::timeout_at(
            deadline.into(),
            intake.while_pending(capture_interval(
                &intake,
                &mut receiver,
                ready,
                end,
                deadline,
            )),
        )
        .await
        .map_err(|_| Status::deadline_exceeded("voice capture deadline exceeded"))??;
        // Stop subscription before allocating native recognition work. Drop
        // also retires queued PCM if this cleanup is itself interrupted.
        intake
            .while_pending(async {
                receiver.stop().await;
                Ok(())
            })
            .await?;
        let pcm = Pcm16Mono::new(pcm).map_err(|_| audio_unavailable())?;
        let cancellation = Cancellation::default();
        let deadline = intake.deadline.min(Instant::now() + RECOGNITION_LIMIT);
        let recognition = intake
            .while_pending(async {
                recognizer
                    .transcribe(pcm, language, deadline, cancellation.clone())
                    .await
                    .map_err(recognition_error)
            })
            .await;
        let recognition = match recognition {
            Ok(result) => result,
            Err(error) => {
                cancellation.cancel();
                return Err(error);
            }
        };
        match recognition {
            Recognition::Transcript(text) => intake.complete(text).await.map(Some),
            Recognition::NoMatch => {
                // NoMatch is not proof of silence or of an absent speaker.
                tokio::time::timeout_at(
                    intake.deadline.into(),
                    intake.runtime.cancel(
                        intake.authenticated.principal.expose_for_authorization(),
                        &intake.fence,
                    ),
                )
                .await
                .map_err(|_| Status::deadline_exceeded("voice intake deadline exceeded"))??;
                intake.cancel.armed = false;
                Ok(Some(RuntimeResult::Cancelled))
            }
        }
    }
}

async fn capture_interval(
    intake: &LocalVoice,
    receiver: &mut AudioReceiver,
    ready: oneshot::Sender<()>,
    mut end: oneshot::Receiver<()>,
    deadline: Instant,
) -> Result<Vec<f32>, Status> {
    intake.check().await?;
    ready
        .send(())
        .map_err(|_| Status::cancelled("voice requester left"))?;
    let latest_end = deadline - RECEIVE_TAIL;
    let mut tail = None;
    let mut source_samples = 0usize;
    let mut converter = Mono48To16::default();
    let mut samples = Vec::with_capacity(cosmos_stt::MAX_SAMPLES);
    loop {
        let until = tail.unwrap_or(latest_end);
        tokio::select! {
            biased;
            ended = &mut end, if tail.is_none() => {
                ended.map_err(|_| Status::cancelled("voice endpoint was not received"))?;
                let received = Instant::now();
                if received >= latest_end {
                    return Err(Status::deadline_exceeded("voice endpoint exceeded capture budget"));
                }
                intake.check().await?;
                tail = Some(received + RECEIVE_TAIL);
            }
            _ = tokio::time::sleep_until(until.into()) => {
                if tail.is_none() {
                    return Err(Status::deadline_exceeded("voice endpoint was not received"));
                }
                break;
            }
            frame = receiver.recv() => {
                let frame = frame.map_err(|_| audio_unavailable())?;
                intake.check().await?;
                source_samples = source_samples.checked_add(FRAME_SAMPLES).ok_or_else(audio_unavailable)?;
                if source_samples > MAX_SOURCE_SAMPLES {
                    return Err(Status::resource_exhausted("voice capture exceeded sample budget"));
                }
                let (consumed, converted) = converter.push(&frame);
                if consumed != frame.len() {
                    return Err(audio_unavailable());
                }
                append(&mut samples, converted.samples())?;
            }
        }
    }
    intake.check().await?;
    // Flush only after an authorized endpoint. Error/drop discards the FIR
    // history and pending samples rather than adding its tail to another turn.
    append(&mut samples, converter.finish().samples())?;
    if samples.is_empty() {
        return Err(audio_unavailable());
    }
    Ok(samples)
}

fn append(samples: &mut Vec<f32>, block: &[i16]) -> Result<(), Status> {
    if samples.len().saturating_add(block.len()) > cosmos_stt::MAX_SAMPLES {
        return Err(Status::resource_exhausted(
            "voice capture exceeded sample budget",
        ));
    }
    samples.extend(block.iter().map(|sample| f32::from(*sample) / 32768.0));
    Ok(())
}

fn recognition_error(error: cosmos_stt::Error) -> Status {
    match error {
        cosmos_stt::Error::Busy => Status::resource_exhausted("local recognition is busy"),
        cosmos_stt::Error::Cancelled => Status::cancelled("local recognition cancelled"),
        cosmos_stt::Error::Deadline => {
            Status::deadline_exceeded("local recognition deadline exceeded")
        }
        _ => Status::unavailable("local recognition unavailable"),
    }
}
fn audio_unavailable() -> Status {
    Status::unavailable("voice audio unavailable")
}

#[cfg(test)]
#[path = "voice_capture_tests.rs"]
mod tests;
