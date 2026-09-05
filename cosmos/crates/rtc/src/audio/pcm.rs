//! Bounded PCM conversion only. Callers still authorize capture, provider
//! disclosure and output separately, and retain the source track's binding.
//! Neither conversion nor finishing a stream establishes playback.
use super::{FRAME_SAMPLES, SAMPLE_RATE};
use std::{f64::consts::PI, sync::OnceLock};

pub const RECOGNITION_SAMPLE_RATE: u32 = 16_000;
pub const RECOGNITION_FRAME_SAMPLES: usize = FRAME_SAMPLES / 3;
const FRAME_BYTES: usize = FRAME_SAMPLES * 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FramingError {
    #[error("PCM ended within a signed 16-bit sample")]
    TruncatedSample,
    #[error("PCM ended within a 10ms frame")]
    PartialFrame,
}

/// Only a complete sample may be padded. An unmatched byte always fails.
#[derive(Clone, Copy)]
pub enum PartialFrame {
    Reject,
    PadSilence,
}

/// No Debug: microphone or synthesized content must not enter diagnostics.
#[must_use]
pub struct PcmFrame {
    samples: [i16; FRAME_SAMPLES],
    valid_samples: usize,
}
impl PcmFrame {
    /// Exactly 10ms, including any explicitly requested final silence padding.
    pub fn samples(&self) -> &[i16; FRAME_SAMPLES] {
        &self.samples
    }

    /// Counts source samples, excluding final silence padding.
    pub fn valid_samples(&self) -> usize {
        self.valid_samples
    }
}

/// Converts arbitrary little-endian, signed 16-bit mono byte chunks into the
/// transport's 48kHz/480-sample frames, with at most 959 pending bytes between
/// calls. It does not buffer the remaining chunk or queue completed frames.
pub struct Pcm48Framer {
    bytes: [u8; FRAME_BYTES],
    length: usize,
}
impl Default for Pcm48Framer {
    fn default() -> Self {
        Self {
            bytes: [0; FRAME_BYTES],
            length: 0,
        }
    }
}
impl Pcm48Framer {
    /// Returns bytes consumed and, at most, one complete frame. Continue with
    /// the unconsumed suffix only after the downstream consumer accepts this
    /// frame. On backpressure, retain that frame; do not replay consumed bytes.
    pub fn push(&mut self, input: &[u8]) -> (usize, Option<PcmFrame>) {
        let count = input.len().min(FRAME_BYTES - self.length);
        self.bytes[self.length..self.length + count].copy_from_slice(&input[..count]);
        self.length += count;
        if self.length == FRAME_BYTES {
            self.length = 0;
            (count, Some(self.decode(FRAME_SAMPLES)))
        } else {
            (count, None)
        }
    }

    /// Consumes this stream, preventing reuse across turns. Exact-frame and
    /// empty endings emit nothing. Padding is at most 479 samples, not the
    /// encoder-draining silence managed separately by AudioSender.
    pub fn finish(self, partial: PartialFrame) -> Result<Option<PcmFrame>, FramingError> {
        if self.length % 2 != 0 {
            return Err(FramingError::TruncatedSample);
        }
        if self.length == 0 {
            return Ok(None);
        }
        match partial {
            PartialFrame::Reject => Err(FramingError::PartialFrame),
            PartialFrame::PadSilence => Ok(Some(self.decode(self.length / 2))),
        }
    }

    fn decode(&self, valid_samples: usize) -> PcmFrame {
        let mut samples = [0; FRAME_SAMPLES];
        for (sample, bytes) in samples[..valid_samples]
            .iter_mut()
            .zip(self.bytes.chunks_exact(2))
        {
            *sample = i16::from_le_bytes([bytes[0], bytes[1]]);
        }
        PcmFrame {
            samples,
            valid_samples,
        }
    }
}

// 7kHz cutoff, 127-tap normalized Blackman-windowed sinc. The transition to
// 8kHz avoids aliasing above the 16kHz output's Nyquist limit. Linear phase
// delays output by 63 source samples (1.3125ms); finish supplies that tail.
const FILTER_TAPS: usize = 127;
const FILTER_DELAY: usize = (FILTER_TAPS - 1) / 2;
fn coefficients() -> &'static [f64; FILTER_TAPS] {
    static COEFFICIENTS: OnceLock<[f64; FILTER_TAPS]> = OnceLock::new();
    COEFFICIENTS.get_or_init(|| {
        let mut values = [0.0; FILTER_TAPS];
        let cutoff = 7_000.0 / f64::from(SAMPLE_RATE);
        for (index, value) in values.iter_mut().enumerate() {
            let position = index as f64 - FILTER_DELAY as f64;
            let sinc = if position == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * PI * cutoff * position).sin() / (PI * position)
            };
            let angle = 2.0 * PI * index as f64 / (FILTER_TAPS - 1) as f64;
            let window = 0.42 - 0.5 * angle.cos() + 0.08 * (2.0 * angle).cos();
            *value = sinc * window;
        }
        let gain: f64 = values.iter().sum();
        for value in &mut values {
            *value /= gain;
        }
        values
    })
}

/// At most 10ms of mono 16kHz capture samples. No transport silence is added.
/// No Debug: these samples are ephemeral source content.
#[must_use]
pub struct RecognitionPcm {
    samples: [i16; RECOGNITION_FRAME_SAMPLES],
    length: usize,
}
impl RecognitionPcm {
    pub fn samples(&self) -> &[i16] {
        &self.samples[..self.length]
    }
}

/// Streaming 48kHz→16kHz mono converter with a fixed 127-sample history.
/// Filtering precedes decimation. It neither stores a recording nor enforces
/// a turn's duration; capture admission and duration bounds belong to runtime.
pub struct Mono48To16 {
    history: [i16; FILTER_TAPS],
    next: usize,
    warmup: usize,
    phase: usize,
}
impl Default for Mono48To16 {
    fn default() -> Self {
        Self {
            history: [0; FILTER_TAPS],
            next: 0,
            warmup: FILTER_DELAY,
            phase: 0,
        }
    }
}
impl Mono48To16 {
    /// Returns samples consumed and output. Each call processes at most 480
    /// source samples, with no allocation. Feed the unconsumed suffix next.
    /// The first output needs 64 input samples, regardless of chunk boundaries.
    pub fn push(&mut self, input: &[i16]) -> (usize, RecognitionPcm) {
        let count = input.len().min(FRAME_SAMPLES);
        (count, self.convert(&input[..count]))
    }

    /// Consumes the converter and emits the delayed tail with zero extension
    /// outside the captured interval. The full output contains ceil(N/3)
    /// samples aligned to source positions 0, 3, 6, ... < N, including partial
    /// final groups. Empty input stays empty. Discard the converter on abort;
    /// never flush a cancelled or unauthorized capture into another turn.
    pub fn finish(mut self) -> RecognitionPcm {
        self.convert(&[0; FILTER_DELAY])
    }

    fn convert(&mut self, input: &[i16]) -> RecognitionPcm {
        let mut output = RecognitionPcm {
            samples: [0; RECOGNITION_FRAME_SAMPLES],
            length: 0,
        };
        for &sample in input {
            self.history[self.next] = sample;
            self.next = (self.next + 1) % FILTER_TAPS;
            if self.warmup != 0 {
                self.warmup -= 1;
                continue;
            }
            if self.phase == 0 {
                let mut value = 0.0;
                for (tap, coefficient) in coefficients().iter().enumerate() {
                    let index = (self.next + FILTER_TAPS - 1 - tap) % FILTER_TAPS;
                    value += coefficient * f64::from(self.history[index]);
                }
                output.samples[output.length] =
                    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16;
                output.length += 1;
            }
            self.phase = (self.phase + 1) % 3;
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_bytes(bytes: &[u8], chunk_size: usize) -> Vec<PcmFrame> {
        let mut framer = Pcm48Framer::default();
        let mut frames = Vec::new();
        for chunk in bytes.chunks(chunk_size) {
            let mut input = chunk;
            while !input.is_empty() {
                let (count, frame) = framer.push(input);
                assert!(count > 0 && count <= FRAME_BYTES);
                input = &input[count..];
                if let Some(frame) = frame {
                    frames.push(frame);
                }
            }
        }
        if let Some(frame) = framer.finish(PartialFrame::PadSilence).unwrap() {
            frames.push(frame);
        }
        frames
    }

    #[test]
    fn pcm_framing_preserves_signed_endianness_at_every_byte_boundary() {
        let samples: Vec<i16> = [i16::MIN, -1, 0, 1, i16::MAX]
            .into_iter()
            .cycle()
            .take(FRAME_SAMPLES * 3 + 19)
            .collect();
        let bytes: Vec<u8> = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        for chunk_size in [1, 2, 3, 479, 959, 960, 961, bytes.len()] {
            let frames = frame_bytes(&bytes, chunk_size);
            assert_eq!(frames.len(), 4);
            let actual: Vec<i16> = frames
                .iter()
                .flat_map(|frame| &frame.samples()[..frame.valid_samples()])
                .copied()
                .collect();
            assert_eq!(actual, samples, "chunk size {chunk_size}");
            assert_eq!(frames[3].valid_samples(), 19);
            assert!(frames[3].samples()[19..].iter().all(|sample| *sample == 0));
        }
    }

    #[test]
    fn pcm_framing_requires_explicit_partial_end_and_rejects_truncated_samples() {
        for partial in [PartialFrame::Reject, PartialFrame::PadSilence] {
            let mut framer = Pcm48Framer::default();
            assert!(framer.push(&[0x23]).1.is_none());
            assert!(matches!(
                framer.finish(partial),
                Err(FramingError::TruncatedSample)
            ));
        }
        let mut framer = Pcm48Framer::default();
        assert!(framer.push(&[0x23, 0x01]).1.is_none());
        assert!(matches!(
            framer.finish(PartialFrame::Reject),
            Err(FramingError::PartialFrame)
        ));
        for samples in [0, FRAME_SAMPLES, FRAME_SAMPLES * 2] {
            let frames = frame_bytes(&vec![0; samples * 2], 17);
            assert_eq!(frames.len(), samples / FRAME_SAMPLES);
            assert!(
                frames
                    .iter()
                    .all(|frame| frame.valid_samples() == FRAME_SAMPLES)
            );
        }
    }

    #[test]
    fn pcm_framing_leaves_a_large_chunk_with_its_caller() {
        let bytes = [0x11; FRAME_BYTES * 30 + 1];
        let mut framer = Pcm48Framer::default();
        let (count, frame) = framer.push(&bytes);
        assert_eq!(count, FRAME_BYTES);
        assert_eq!(frame.unwrap().valid_samples(), FRAME_SAMPLES);
        assert!(framer.finish(PartialFrame::Reject).unwrap().is_none());
        // The unconsumed odd byte was not retained or silently accepted.
        assert_eq!(bytes.len() - count, FRAME_BYTES * 29 + 1);
    }

    fn resample(input: &[i16], chunk_size: usize) -> Vec<i16> {
        let mut converter = Mono48To16::default();
        let mut output = Vec::new();
        for chunk in input.chunks(chunk_size) {
            let mut remaining = chunk;
            while !remaining.is_empty() {
                let (count, converted) = converter.push(remaining);
                assert!(count > 0 && count <= FRAME_SAMPLES);
                assert!(converted.samples().len() <= RECOGNITION_FRAME_SAMPLES);
                output.extend_from_slice(converted.samples());
                remaining = &remaining[count..];
            }
        }
        output.extend_from_slice(converter.finish().samples());
        output
    }

    #[test]
    fn pcm_resampling_preserves_length_and_content_across_arbitrary_chunks() {
        for length in [0usize, 1, 2, 3, 4, 62, 63, 64, 65, 479, 480, 481, 4_811] {
            let input: Vec<i16> = (0..length)
                .map(|index| (((index * 7_919 + 31) % 60_001) as i32 - 30_000) as i16)
                .collect();
            let expected = resample(&input, FRAME_SAMPLES);
            assert_eq!(expected.len(), length.div_ceil(3), "length {length}");
            for size in [1, 2, 3, 7, 63, 127, 479, 481, 10_000] {
                assert_eq!(
                    resample(&input, size),
                    expected,
                    "length {length}, chunk {size}"
                );
            }
        }
    }

    #[test]
    fn pcm_resampling_has_bounded_lookahead_and_keeps_the_final_impulse() {
        let mut converter = Mono48To16::default();
        assert!(converter.push(&[0; 63]).1.samples().is_empty());
        assert_eq!(converter.push(&[0]).1.samples().len(), 1);
        assert_eq!(converter.finish().samples().len(), 21);

        for impulse_at in [0, 63, 300, 477, 480] {
            let mut input = vec![0; 481];
            input[impulse_at] = 20_000;
            let output = resample(&input, 11);
            let peak = output
                .iter()
                .enumerate()
                .max_by_key(|(_, value)| value.abs())
                .unwrap()
                .0;
            assert_eq!(peak, impulse_at / 3);
            assert!(
                output[peak] > 5_000,
                "final content cannot be discarded during flush"
            );
        }
    }

    fn tone(frequency: f64) -> Vec<i16> {
        (0..9_600)
            .map(|index| {
                // Nonzero phase also exercises Nyquist and frequencies whose
                // aliased output is DC; a zero sine would falsely pass.
                (12_000.0 * (2.0 * PI * frequency * index as f64 / 48_000.0 + PI / 7.0).cos())
                    .round() as i16
            })
            .collect()
    }

    fn rms(samples: &[i16]) -> f64 {
        (samples
            .iter()
            .map(|sample| f64::from(*sample).powi(2))
            .sum::<f64>()
            / samples.len() as f64)
            .sqrt()
    }

    #[test]
    fn pcm_resampling_preserves_speech_band_and_rejects_aliasing() {
        for frequency in [100.0, 1_000.0, 3_000.0, 6_000.0] {
            let input = tone(frequency);
            let output = resample(&input, 157);
            let gain = rms(&output[100..output.len() - 100]) / rms(&input[300..input.len() - 300]);
            assert!((0.99..1.01).contains(&gain), "{frequency} Hz gain {gain}");
        }
        for frequency in [8_000.0, 9_000.0, 12_000.0, 16_000.0, 20_000.0, 24_000.0] {
            let input = tone(frequency);
            let output = resample(&input, 157);
            let gain = rms(&output[100..output.len() - 100]) / rms(&input[300..input.len() - 300]);
            assert!(
                gain < 0.003_163,
                "{frequency} Hz alias exceeds -50dB: {gain}"
            );
        }
    }

    #[test]
    fn pcm_resampling_keeps_dc_silence_and_saturates_filter_overshoot() {
        assert!(resample(&[0; 960], 13).iter().all(|value| *value == 0));
        for dc in [i16::MIN, -10_000, 10_000, i16::MAX] {
            let output = resample(&[dc; 960], 13);
            assert!(
                output[50..250]
                    .iter()
                    .all(|value| (i32::from(*value) - i32::from(dc)).abs() <= 1)
            );
        }
        // Full-scale sign transition causes FIR ringing. It must clip instead
        // of wrapping polarity on either side of the transition.
        let mut input = vec![i16::MIN; 480];
        input.extend_from_slice(&[i16::MAX; 480]);
        let output = resample(&input, 157);
        assert!(output[140..157].iter().all(|value| *value < 0));
        assert!(output[163..180].iter().all(|value| *value > 0));
        assert!(output[140..160].contains(&i16::MIN));
        assert!(output[160..180].contains(&i16::MAX));
    }
}
