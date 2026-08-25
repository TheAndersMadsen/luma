//! Validation helpers for the stock translation RPC. Translation is served by
//! Cosmos; the Pin-side service stays fail-closed.

use crate::config::ResolvedConfig;
use crate::proto::aibus::Locale;

pub(super) const MAX_TRANSLATION_TEXT_BYTES: usize = 8 * 1024;
const SUPPORTED_LANGUAGES: &[&str] = &["en", "fr", "it", "es", "pt", "de"];

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct ValidatedLocale {
    pub(super) language: String,
    pub(super) country: String,
}

impl ValidatedLocale {
    pub(super) fn tag(&self) -> String {
        if self.country.is_empty() {
            self.language.clone()
        } else {
            format!("{}-{}", self.language, self.country)
        }
    }

    pub(super) fn into_proto(self) -> Locale {
        Locale {
            language: self.language,
            country: self.country,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct TranslationInput {
    pub(super) text: String,
    pub(super) source: ValidatedLocale,
    pub(super) target: ValidatedLocale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum TranslationProviderError {
    Unavailable,
}

#[tonic::async_trait]
pub(super) trait TextTranslationProvider: Send + Sync {
    async fn translate(&self, input: &TranslationInput)
        -> Result<String, TranslationProviderError>;
}

pub(super) fn azure_tts_is_configured(config: &ResolvedConfig) -> bool {
    let configured = &config.config.azure_speech;
    configured.enabled
        && configured.cloud_consent_acknowledged
        && config.azure_speech_options.validate().is_ok()
}

pub(super) fn validate_locale(locale: &Locale) -> Result<ValidatedLocale, ()> {
    let language = locale.language.trim();
    if !(2..=3).contains(&language.len())
        || !language.bytes().all(|byte| byte.is_ascii_alphabetic())
    {
        return Err(());
    }

    let country = locale.country.trim();
    if !country.is_empty()
        && (country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_alphabetic()))
    {
        return Err(());
    }

    Ok(ValidatedLocale {
        language: language.to_ascii_lowercase(),
        country: country.to_ascii_uppercase(),
    })
}

pub(super) fn is_supported_pair(source: &ValidatedLocale, target: &ValidatedLocale) -> bool {
    source.language != target.language && is_supported_locale(source) && is_supported_locale(target)
}

pub(super) fn is_supported_locale(locale: &ValidatedLocale) -> bool {
    SUPPORTED_LANGUAGES.contains(&locale.language.as_str())
}

pub(super) fn validate_input_text(text: &str) -> Result<String, ()> {
    let text = text.trim();
    if text.is_empty()
        || text.len() > MAX_TRANSLATION_TEXT_BYTES
        || text.chars().any(|character| {
            character == '\0' || (character.is_control() && !character.is_whitespace())
        })
    {
        return Err(());
    }
    Ok(text.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_validation_normalizes_only_stock_shaped_codes() {
        assert_eq!(
            validate_locale(&Locale {
                language: "EN".into(),
                country: "us".into(),
            })
            .unwrap(),
            ValidatedLocale {
                language: "en".into(),
                country: "US".into(),
            }
        );
        assert!(validate_locale(&Locale {
            language: "en-US".into(),
            country: String::new(),
        })
        .is_err());
        assert!(validate_locale(&Locale {
            language: "en".into(),
            country: "USA".into(),
        })
        .is_err());
    }

    #[test]
    fn supported_pairs_match_the_stock_language_family_and_reject_identity() {
        let en = validate_locale(&Locale {
            language: "en".into(),
            country: "US".into(),
        })
        .unwrap();
        let es = validate_locale(&Locale {
            language: "es".into(),
            country: "ES".into(),
        })
        .unwrap();
        let ja = validate_locale(&Locale {
            language: "ja".into(),
            country: "JP".into(),
        })
        .unwrap();
        assert!(is_supported_pair(&en, &es));
        assert!(!is_supported_pair(&en, &en));
        assert!(!is_supported_pair(&en, &ja));
    }

    #[test]
    fn input_text_rejects_empty_oversized_and_binary_control_data() {
        assert_eq!(validate_input_text("  hello  ").unwrap(), "hello");
        assert!(validate_input_text(" ").is_err());
        assert!(validate_input_text(&"x".repeat(MAX_TRANSLATION_TEXT_BYTES + 1)).is_err());
        assert!(validate_input_text("hello\u{0001}").is_err());
    }
}
