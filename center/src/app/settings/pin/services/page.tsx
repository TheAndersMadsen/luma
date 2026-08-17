"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useState } from "react";
import type {
  GoogleMapsTravelMode,
  MeasurementSystem,
  TemperatureUnit,
  UpdateSettingsRequest,
} from "@/lib/pin-device";
import { StatusMessage } from "@/components/Status";
import settings from "../../settings.module.css";
import styles from "../_lib/panes.module.css";
import {
  AcknowledgementRow,
  DeviceRequired,
  FormRow,
  PaneLoadState,
  PaneSection,
  SaveBar,
  ToggleRow,
} from "../_lib/PaneShell";
import { SecretField } from "../_lib/SecretField";
import { UnsavedChangesGuard } from "../_lib/UnsavedChangesGuard";
import { usePinPaneSession } from "../_lib/pinSession";
import { useDeviceSettings } from "../_lib/useDeviceSettings";
import {
  UNCHANGED_SECRET_EDIT,
  secretEditFromInput,
  secretEditInputValue,
  secretEditRequestValue,
  type SecretEdit,
} from "../_lib/settingsFormState";

/*
 * Third-party service credentials and the consent gates that guard them.
 *
 * Ported from the retired Setup SPA's `SettingsPage.tsx:1496-2105`.
 *
 * Every one of these providers is OFF by default and several cannot be turned
 * on until an explicit acknowledgement is ticked — Google Routes needs an
 * attribution/compliance acknowledgement, OpenStreetMap and Azure Speech need a
 * location/TTS disclosure consent, Open Food Facts needs the ODbL attribution.
 * Those gates are the product, not decoration: enabling one of these sends
 * wearer data off the device. The acknowledgement checkbox is disabled once the
 * feature is on, exactly as in the SPA, so a wearer cannot silently retract a
 * consent while the disclosure keeps happening — they must disable the feature
 * first.
 *
 * The Spotify and Feature Flags entries link OUT rather than duplicating a
 * surface Center already owns or that is a different authority.
 */

const GOOGLE_MAPS_TRAVEL_MODES: readonly { value: GoogleMapsTravelMode; label: string }[] =
  [
    { value: "walk", label: "Walking" },
    { value: "bicycle", label: "Bicycling" },
    { value: "drive", label: "Driving" },
    { value: "two-wheeler", label: "Motorized two-wheeler" },
  ];

const SCOPE = "pin-services-pane";

export default function PinServicesPane() {
  const { client, connectionError, attachedWithoutServer } = usePinPaneSession();
  const controller = useDeviceSettings(SCOPE);
  const { settings: saved, capabilities } = controller;

  const measurementId = useId();
  const temperatureId = useId();
  const travelModeId = useId();
  const languageCodeId = useId();
  const azureRegionId = useId();
  const azureVoiceId = useId();

  const [weatherKey, setWeatherKey] = useState("");
  const [measurementSystem, setMeasurementSystem] =
    useState<MeasurementSystem>("metric");
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit>("celsius");

  const [googleMapsApiKeyEdit, setGoogleMapsApiKeyEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);
  const [googleMapsGeolocationEnabled, setGoogleMapsGeolocationEnabled] =
    useState(false);
  const [googleMapsRoutesEnabled, setGoogleMapsRoutesEnabled] = useState(false);
  const [googleMapsRoutesAcknowledged, setGoogleMapsRoutesAcknowledged] =
    useState(false);
  const [googleMapsTravelMode, setGoogleMapsTravelMode] =
    useState<GoogleMapsTravelMode>("walk");
  const [googleMapsLanguageCode, setGoogleMapsLanguageCode] = useState("en-US");

  const [braveSearchApiKeyEdit, setBraveSearchApiKeyEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);

  const [openStreetMapEnabled, setOpenStreetMapEnabled] = useState(false);
  const [openStreetMapConsent, setOpenStreetMapConsent] = useState(false);

  const [openFoodFactsEnabled, setOpenFoodFactsEnabled] = useState(false);
  const [openFoodFactsAcknowledged, setOpenFoodFactsAcknowledged] = useState(false);

  const [azureSpeechKeyEdit, setAzureSpeechKeyEdit] =
    useState<SecretEdit>(UNCHANGED_SECRET_EDIT);
  const [azureSpeechRegion, setAzureSpeechRegion] = useState("");
  const [azureSpeechVoiceName, setAzureSpeechVoiceName] = useState("");
  const [azureSpeechEnabled, setAzureSpeechEnabled] = useState(false);
  const [azureSpeechConsent, setAzureSpeechConsent] = useState(false);

  const [trustAllContacts, setTrustAllContacts] = useState(false);
  const [allowAllInbound, setAllowAllInbound] = useState(false);

  useEffect(() => {
    if (!saved) return;
    setWeatherKey("");
    setMeasurementSystem(saved.weather.measurement_system);
    setTemperatureUnit(saved.weather.temperature_unit);
    setGoogleMapsApiKeyEdit(UNCHANGED_SECRET_EDIT);
    setGoogleMapsGeolocationEnabled(saved.google_maps.geolocation_enabled);
    setGoogleMapsRoutesEnabled(saved.google_maps.routes_enabled);
    setGoogleMapsRoutesAcknowledged(saved.google_maps.routes_compliance_acknowledged);
    setGoogleMapsTravelMode(saved.google_maps.routes_travel_mode);
    setGoogleMapsLanguageCode(saved.google_maps.language_code);
    setBraveSearchApiKeyEdit(UNCHANGED_SECRET_EDIT);
    setOpenStreetMapEnabled(saved.openstreetmap.enabled);
    setOpenStreetMapConsent(saved.openstreetmap.location_consent_acknowledged);
    setOpenFoodFactsEnabled(saved.open_food_facts.enabled);
    setOpenFoodFactsAcknowledged(saved.open_food_facts.attribution_acknowledged);
    setAzureSpeechKeyEdit(UNCHANGED_SECRET_EDIT);
    setAzureSpeechRegion(saved.azure_speech.region ?? "");
    setAzureSpeechVoiceName(saved.azure_speech.voice_name ?? "");
    setAzureSpeechEnabled(saved.azure_speech.enabled);
    setAzureSpeechConsent(saved.azure_speech.cloud_consent_acknowledged);
    setTrustAllContacts(saved.contacts?.trust_all_contacts ?? false);
    setAllowAllInbound(saved.contacts?.allow_all_inbound ?? false);
  }, [saved]);

  const request = useMemo<UpdateSettingsRequest | null>(() => {
    if (!saved) return null;
    const req: UpdateSettingsRequest = {};

    const weather: NonNullable<UpdateSettingsRequest["weather"]> = {};
    if (weatherKey !== "") weather.pirate_weather_api_key = weatherKey;
    if (
      capabilities.weatherUnits &&
      measurementSystem !== saved.weather.measurement_system
    ) {
      weather.measurement_system = measurementSystem;
    }
    if (
      capabilities.weatherUnits &&
      temperatureUnit !== saved.weather.temperature_unit
    ) {
      weather.temperature_unit = temperatureUnit;
    }
    if (Object.keys(weather).length > 0) req.weather = weather;

    const googleMaps: NonNullable<UpdateSettingsRequest["google_maps"]> = {};
    const googleMapsApiKey = secretEditRequestValue(googleMapsApiKeyEdit);
    if (googleMapsApiKey !== undefined) googleMaps.api_key = googleMapsApiKey;
    if (googleMapsGeolocationEnabled !== saved.google_maps.geolocation_enabled) {
      googleMaps.geolocation_enabled = googleMapsGeolocationEnabled;
    }
    if (googleMapsRoutesEnabled !== saved.google_maps.routes_enabled) {
      googleMaps.routes_enabled = googleMapsRoutesEnabled;
    }
    if (
      googleMapsRoutesAcknowledged !==
      saved.google_maps.routes_compliance_acknowledged
    ) {
      googleMaps.routes_compliance_acknowledged = googleMapsRoutesAcknowledged;
    }
    if (googleMapsTravelMode !== saved.google_maps.routes_travel_mode) {
      googleMaps.routes_travel_mode = googleMapsTravelMode;
    }
    if (googleMapsLanguageCode !== saved.google_maps.language_code) {
      googleMaps.language_code = googleMapsLanguageCode;
    }
    if (Object.keys(googleMaps).length > 0) req.google_maps = googleMaps;

    const braveSearch: NonNullable<UpdateSettingsRequest["brave_search"]> = {};
    const braveSearchApiKey = secretEditRequestValue(braveSearchApiKeyEdit);
    if (braveSearchApiKey !== undefined) braveSearch.api_key = braveSearchApiKey;
    if (Object.keys(braveSearch).length > 0) req.brave_search = braveSearch;

    const openFoodFacts: NonNullable<UpdateSettingsRequest["open_food_facts"]> = {};
    if (openFoodFactsEnabled !== saved.open_food_facts.enabled) {
      openFoodFacts.enabled = openFoodFactsEnabled;
    }
    if (
      openFoodFactsAcknowledged !== saved.open_food_facts.attribution_acknowledged
    ) {
      openFoodFacts.attribution_acknowledged = openFoodFactsAcknowledged;
    }
    if (Object.keys(openFoodFacts).length > 0) req.open_food_facts = openFoodFacts;

    const azureSpeech: NonNullable<UpdateSettingsRequest["azure_speech"]> = {};
    const azureKey = secretEditRequestValue(azureSpeechKeyEdit);
    if (azureKey !== undefined) azureSpeech.subscription_key = azureKey;
    if (azureSpeechRegion !== (saved.azure_speech.region ?? "")) {
      azureSpeech.region = azureSpeechRegion;
    }
    if (azureSpeechVoiceName !== (saved.azure_speech.voice_name ?? "")) {
      azureSpeech.voice_name = azureSpeechVoiceName;
    }
    if (azureSpeechEnabled !== saved.azure_speech.enabled) {
      azureSpeech.enabled = azureSpeechEnabled;
    }
    if (azureSpeechConsent !== saved.azure_speech.cloud_consent_acknowledged) {
      azureSpeech.cloud_consent_acknowledged = azureSpeechConsent;
    }
    if (Object.keys(azureSpeech).length > 0) req.azure_speech = azureSpeech;

    const openstreetmap: NonNullable<UpdateSettingsRequest["openstreetmap"]> = {};
    if (openStreetMapEnabled !== saved.openstreetmap.enabled) {
      openstreetmap.enabled = openStreetMapEnabled;
    }
    if (
      openStreetMapConsent !== saved.openstreetmap.location_consent_acknowledged
    ) {
      openstreetmap.location_consent_acknowledged = openStreetMapConsent;
    }
    if (Object.keys(openstreetmap).length > 0) req.openstreetmap = openstreetmap;

    if (trustAllContacts !== (saved.contacts?.trust_all_contacts ?? false)) {
      req.contacts = { ...req.contacts, trust_all_contacts: trustAllContacts };
    }
    if (allowAllInbound !== (saved.contacts?.allow_all_inbound ?? false)) {
      req.contacts = { ...req.contacts, allow_all_inbound: allowAllInbound };
    }

    return Object.keys(req).length > 0 ? req : null;
  }, [
    allowAllInbound,
    azureSpeechConsent,
    azureSpeechEnabled,
    azureSpeechKeyEdit,
    azureSpeechRegion,
    azureSpeechVoiceName,
    braveSearchApiKeyEdit,
    capabilities.weatherUnits,
    googleMapsApiKeyEdit,
    googleMapsGeolocationEnabled,
    googleMapsLanguageCode,
    googleMapsRoutesAcknowledged,
    googleMapsRoutesEnabled,
    googleMapsTravelMode,
    measurementSystem,
    openFoodFactsAcknowledged,
    openFoodFactsEnabled,
    openStreetMapConsent,
    openStreetMapEnabled,
    saved,
    temperatureUnit,
    trustAllContacts,
    weatherKey,
  ]);

  if (!client) {
    return (
      <DeviceRequired
        attachedWithoutServer={attachedWithoutServer}
        what="this Pin's service credentials"
        connectionError={connectionError}
      />
    );
  }

  if (!saved) {
    return (
      <PaneLoadState
        error={controller.loadError}
        onRetry={controller.reload}
        rows={6}
      />
    );
  }

  const saving = controller.saveStatus === "saving";
  const hasStoredGoogleMapsKey = saved.google_maps.has_api_key;
  const hasStoredBraveSearchKey = saved.brave_search.has_api_key;
  const hasStoredAzureKey = saved.azure_speech.has_subscription_key;
  const hasEffectiveAzureKey =
    azureSpeechKeyEdit.kind === "set"
      ? azureSpeechKeyEdit.value.trim() !== ""
      : azureSpeechKeyEdit.kind === "clear"
        ? false
        : hasStoredAzureKey;
  const azureReady =
    hasEffectiveAzureKey &&
    azureSpeechRegion.trim() !== "" &&
    azureSpeechVoiceName.trim() !== "" &&
    azureSpeechConsent;

  return (
    <>
      <SaveBar
        status={controller.saveStatus}
        error={controller.saveError}
        dirty={request !== null}
        onSave={() => {
          if (request) void controller.save(request);
        }}
      />

      <fieldset
        className={styles.fieldset}
        disabled={saving}
        aria-busy={saving}
      >
        <PaneSection title="Weather" testId="pin-services-weather">
          <FormRow
            label="PirateWeather API key"
            help="Write-only. The Pin reports only whether a key is stored."
          >
            <SecretField
              value={weatherKey}
              onChange={setWeatherKey}
              hasExisting={saved.weather.has_api_key}
              ariaLabel="PirateWeather API key"
            />
          </FormRow>

          {capabilities.weatherUnits ? (
            <>
              <FormRow
                label="Measurement system"
                htmlFor={measurementId}
                help="Controls Google Routes distances. Fitness exports stay kilometre-based regardless."
              >
                <select
                  id={measurementId}
                  className={styles.select}
                  value={measurementSystem}
                  onChange={(event) =>
                    setMeasurementSystem(event.target.value as MeasurementSystem)
                  }
                >
                  <option value="metric">Metric</option>
                  <option value="imperial">Imperial</option>
                </select>
              </FormRow>
              <FormRow
                label="Temperature unit"
                htmlFor={temperatureId}
                help="Controls stock and spoken weather."
              >
                <select
                  id={temperatureId}
                  className={styles.select}
                  value={temperatureUnit}
                  onChange={(event) =>
                    setTemperatureUnit(event.target.value as TemperatureUnit)
                  }
                >
                  <option value="celsius">Celsius</option>
                  <option value="fahrenheit">Fahrenheit</option>
                </select>
              </FormRow>
            </>
          ) : null}
        </PaneSection>

        {capabilities.braveSearch ? (
          <PaneSection title="Web search" testId="pin-services-brave-search">
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Brave Search gives the assistant current web results for questions
                about news, events, products, and other time-sensitive topics.
              </p>
            </div>

            <FormRow
              label="Brave Search API key"
              help="Write-only. The Pin reports only whether a key is stored."
            >
              {braveSearchApiKeyEdit.kind === "clear" ? (
                <div className={styles.actionRow}>
                  <span className={styles.formHelp}>
                    The stored key will be cleared when you save. A key supplied
                    through BRAVE_SEARCH_API_KEY on the device remains active.
                  </span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setBraveSearchApiKeyEdit(UNCHANGED_SECRET_EDIT)}
                  >
                    Undo
                  </button>
                </div>
              ) : (
                <>
                  <SecretField
                    value={secretEditInputValue(braveSearchApiKeyEdit)}
                    onChange={(value) =>
                      setBraveSearchApiKeyEdit(secretEditFromInput(value))
                    }
                    hasExisting={hasStoredBraveSearchKey}
                    placeholder="Enter a Brave Search subscription key"
                    ariaLabel="Brave Search API key"
                  />
                  {hasStoredBraveSearchKey ? (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setBraveSearchApiKeyEdit({ kind: "clear" })}
                    >
                      Clear stored key
                    </button>
                  ) : null}
                </>
              )}
            </FormRow>
          </PaneSection>
        ) : null}

        {capabilities.googleMaps ? (
          <PaneSection title="Google Maps Platform" testId="pin-services-google-maps">
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Optional Google Geolocation and Routes web services. Both are off by
                default and controlled independently.
              </p>
            </div>

            <FormRow
              label="Google Maps API key"
              help="Write-only. Restrict the key to the Geolocation and Routes APIs and apply appropriate quotas."
            >
              {googleMapsApiKeyEdit.kind === "clear" ? (
                <div className={styles.actionRow}>
                  <span className={styles.formHelp}>
                    The stored API key will be cleared when you save. A key supplied
                    through GOOGLE_MAPS_API_KEY on the device remains active.
                  </span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setGoogleMapsApiKeyEdit(UNCHANGED_SECRET_EDIT)}
                  >
                    Undo
                  </button>
                </div>
              ) : (
                <>
                  <SecretField
                    value={secretEditInputValue(googleMapsApiKeyEdit)}
                    onChange={(value) =>
                      setGoogleMapsApiKeyEdit(secretEditFromInput(value))
                    }
                    hasExisting={hasStoredGoogleMapsKey}
                    placeholder="Enter a restricted Google Maps Platform key"
                    ariaLabel="Google Maps API key"
                  />
                  {hasStoredGoogleMapsKey ? (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setGoogleMapsApiKeyEdit({ kind: "clear" })}
                    >
                      Clear stored key
                    </button>
                  ) : null}
                </>
              )}
            </FormRow>

            <FormRow label="Geolocation">
              <ToggleRow
                ariaLabel="Google geolocation"
                copy="Send radio and network observations to Google to estimate the Pin's location."
                checked={googleMapsGeolocationEnabled}
                onChange={setGoogleMapsGeolocationEnabled}
              />
              <StatusMessage tone="warning">
                Privacy: when enabled, Wi-Fi access-point identifiers, cell-tower
                details, and IP/network observations can leave the device and be sent
                to Google. Keep this disabled if you do not consent to that off-device
                processing.
              </StatusMessage>
            </FormRow>

            <FormRow label="Routes">
              <ToggleRow
                ariaLabel="Google routes"
                copy="Send the origin coordinates and destination to Google and return route steps."
                checked={googleMapsRoutesEnabled}
                onChange={setGoogleMapsRoutesEnabled}
              />
              <StatusMessage tone="danger">
                <strong>Attribution, legal, privacy and safety work required.</strong>{" "}
                Ai Pin Revival and the stock arcOS route UI do not supply the Google
                Maps attribution, disclosures, or compliance UX required for Google
                Routes content. Before enabling, implement and verify attribution on
                every route-result surface, public terms and privacy notices,
                applicable regional requirements, and a road-safe experience. Route
                guidance can be incomplete or wrong; users must obey signs, remain
                alert, and avoid unsafe interaction while moving.
              </StatusMessage>
              <p className={styles.formHelp}>
                Review Google&rsquo;s official{" "}
                <a
                  href="https://developers.google.com/maps/documentation/routes/policies"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Routes policies and attribution
                </a>
                ,{" "}
                <a
                  href="https://cloud.google.com/maps-platform/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Maps Platform terms
                </a>
                ,{" "}
                <a
                  href="https://policies.google.com/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Google Privacy Policy
                </a>
                , and{" "}
                <a
                  href="https://cloud.google.com/terms/maps-platform/eea-safety-requirements"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  road-safety requirements
                </a>
                . Requirements can change; review them for your account and region.
              </p>
              <AcknowledgementRow
                checked={googleMapsRoutesAcknowledged}
                onChange={setGoogleMapsRoutesAcknowledged}
              >
                I independently acknowledge responsibility for implementing and
                maintaining all linked attribution, terms, privacy, regional, and
                road-safety requirements before Routes is enabled.
              </AcknowledgementRow>
            </FormRow>

            <FormRow
              label="Route travel mode"
              htmlFor={travelModeId}
              help="Walking is the strict default. Select a different mode only when the route surface and safety behaviour support it."
            >
              <select
                id={travelModeId}
                className={styles.select}
                value={googleMapsTravelMode}
                onChange={(event) =>
                  setGoogleMapsTravelMode(event.target.value as GoogleMapsTravelMode)
                }
              >
                {GOOGLE_MAPS_TRAVEL_MODES.map((mode) => (
                  <option key={mode.value} value={mode.value}>
                    {mode.label}
                  </option>
                ))}
              </select>
            </FormRow>

            <FormRow
              label="Language code"
              htmlFor={languageCodeId}
              help="BCP 47-style language tag, for example en-US or da-DK."
            >
              <input
                id={languageCodeId}
                className={styles.input}
                type="text"
                value={googleMapsLanguageCode}
                onChange={(event) => setGoogleMapsLanguageCode(event.target.value)}
                placeholder="en-US"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormRow>
          </PaneSection>
        ) : null}

        {capabilities.openStreetMap ? (
          <PaneSection
            title="OpenStreetMap location services"
            testId="pin-services-osm"
          >
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Optional Nominatim reverse geocoding and Overpass nearby search for
                stock arcOS and assistant tools.
              </p>
              <StatusMessage tone="warning">
                Privacy: these public community services receive exact coordinates.
                Nearby search also sends the search text and radius. Requests use Ai
                Pin Revival&rsquo;s identifying application user agent and are rate and
                size limited, but they are still off-device disclosures.
              </StatusMessage>
              <AcknowledgementRow
                checked={openStreetMapConsent}
                onChange={setOpenStreetMapConsent}
                disabled={openStreetMapEnabled}
              >
                I acknowledge and consent to sending location and nearby search data
                to OpenStreetMap community services.
              </AcknowledgementRow>
              <ToggleRow
                ariaLabel="OpenStreetMap location services"
                copy="Enable reverse geocoding and nearby search."
                checked={openStreetMapEnabled}
                onChange={setOpenStreetMapEnabled}
                disabled={!openStreetMapConsent && !openStreetMapEnabled}
              />
            </div>
          </PaneSection>
        ) : null}

        {capabilities.openFoodFacts ? (
          <PaneSection title="Open Food Facts" testId="pin-services-off">
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Validated barcode and bounded explicit food-name lookup. Ai Pin Revival
                does not send captured images to Open Food Facts and does not request
                product images.
              </p>
              <AcknowledgementRow
                checked={openFoodFactsAcknowledged}
                onChange={setOpenFoodFactsAcknowledged}
                disabled={openFoodFactsEnabled}
              >
                I acknowledge the Open Food Facts attribution and ODbL/DbCL license
                obligations for every product-data surface.
              </AcknowledgementRow>
              <ToggleRow
                ariaLabel="Open Food Facts lookups"
                copy="Enable barcode and name lookups."
                checked={openFoodFactsEnabled}
                onChange={setOpenFoodFactsEnabled}
                disabled={!openFoodFactsAcknowledged && !openFoodFactsEnabled}
              />
              <StatusMessage tone="warning">
                {saved.open_food_facts.attribution}
              </StatusMessage>
              <p className={styles.formHelp}>
                Review the{" "}
                <a
                  href={saved.open_food_facts.license_url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  ODbL license
                </a>{" "}
                and Open Food Facts&rsquo; current API and license guidance. The separate
                stock Food Settings.Global gate may also need enabling from{" "}
                <Link href="/settings/pin/flags">device flags</Link> before arcOS
                exposes the feature.
              </p>
            </div>
          </PaneSection>
        ) : null}

        {capabilities.azureSpeech ? (
          <PaneSection title="Azure Speech" testId="pin-services-azure">
            <div className={styles.formRow}>
              <p className={styles.formHelp}>
                Optional cloud text-to-speech for the stock SpeechService. Local
                on-device TTS remains the default.
              </p>
            </div>

            <FormRow label="Azure Speech subscription key">
              {azureSpeechKeyEdit.kind === "clear" ? (
                <div className={styles.actionRow}>
                  <span className={styles.formHelp}>
                    The stored key will be cleared when you save. A key supplied
                    through AZURE_SPEECH_KEY on the device remains active.
                  </span>
                  <button
                    type="button"
                    className={styles.linkButton}
                    onClick={() => setAzureSpeechKeyEdit(UNCHANGED_SECRET_EDIT)}
                  >
                    Undo
                  </button>
                </div>
              ) : (
                <>
                  <SecretField
                    value={secretEditInputValue(azureSpeechKeyEdit)}
                    onChange={(value) =>
                      setAzureSpeechKeyEdit(secretEditFromInput(value))
                    }
                    hasExisting={hasStoredAzureKey}
                    placeholder="Enter the Azure Speech resource key"
                    ariaLabel="Azure Speech subscription key"
                  />
                  {hasStoredAzureKey ? (
                    <button
                      type="button"
                      className={styles.linkButton}
                      onClick={() => setAzureSpeechKeyEdit({ kind: "clear" })}
                    >
                      Clear stored key
                    </button>
                  ) : null}
                </>
              )}
            </FormRow>

            <FormRow label="Azure resource region" htmlFor={azureRegionId}>
              <input
                id={azureRegionId}
                className={styles.input}
                type="text"
                value={azureSpeechRegion}
                onChange={(event) => setAzureSpeechRegion(event.target.value)}
                placeholder="southeastasia"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormRow>

            <FormRow
              label="Configured voice"
              htmlFor={azureVoiceId}
              help="Request-provided voice aliases are ignored; only this operator-selected voice is sent to Azure."
            >
              <input
                id={azureVoiceId}
                className={styles.input}
                type="text"
                value={azureSpeechVoiceName}
                onChange={(event) => setAzureSpeechVoiceName(event.target.value)}
                placeholder="en-US-AvaMultilingualNeural"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </FormRow>

            <FormRow label="Cloud speech">
              <StatusMessage tone="danger">
                Privacy: enabling cloud speech sends the text being spoken and
                necessary service metadata to the configured Azure region. Do not
                enable it without an appropriate privacy notice, data-processing
                terms, and informed user consent.
              </StatusMessage>
              <AcknowledgementRow
                checked={azureSpeechConsent}
                onChange={setAzureSpeechConsent}
                disabled={azureSpeechEnabled}
              >
                I acknowledge and consent to sending TTS text to Azure for cloud
                processing.
              </AcknowledgementRow>
              <ToggleRow
                ariaLabel="Azure cloud speech"
                copy="Enable Azure cloud speech."
                checked={azureSpeechEnabled}
                onChange={setAzureSpeechEnabled}
                disabled={!azureReady && !azureSpeechEnabled}
              />
              <p className={styles.formHelp}>
                Enabling this provider does not switch stock TTS by itself. In{" "}
                <Link href="/settings/pin/flags">device flags</Link>, set the remote
                speech timeout to a positive value only after verifying local fallback
                and cloud consent.
              </p>
            </FormRow>
          </PaneSection>
        ) : null}

        <PaneSection title="Calls and messages" testId="pin-services-contacts">
          <FormRow label="Trust all contacts">
            <ToggleRow
              ariaLabel="Trust all contacts"
              copy="Allow calls and messages from any saved contact."
              checked={trustAllContacts}
              onChange={setTrustAllContacts}
              disabled={allowAllInbound}
            />
          </FormRow>
          <FormRow
            label="Allow all inbound calls and messages"
            help="When this is on, the trusted-contacts setting no longer narrows anything."
          >
            <ToggleRow
              ariaLabel="Allow all inbound calls and messages"
              copy="Allow calls and messages from everyone, even people who are not in contacts."
              checked={allowAllInbound}
              onChange={setAllowAllInbound}
            />
          </FormRow>
        </PaneSection>
      </fieldset>

      <PaneSection title="Elsewhere" testId="pin-services-elsewhere">
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>Spotify</span>
            <span className={settings.additionRowDesc}>
              Pairing is an account-level service in Center, not a device credential.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/account/services">
            Open
          </Link>
        </div>
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>eSIM and cellular</span>
            <span className={settings.additionRowDesc}>
              Profiles, activation, and wireless status.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/pin/esim">
            Open
          </Link>
        </div>
        <div className={settings.additionRow}>
          <span className={settings.additionRowText}>
            <span className={settings.additionRowTitle}>Device feature flags</span>
            <span className={settings.additionRowDesc}>
              The Pin&rsquo;s own assignment set and Settings.Global gates — a different
              authority from your account&rsquo;s Features list.
            </span>
          </span>
          <Link className={settings.additionLink} href="/settings/pin/flags">
            Open
          </Link>
        </div>
      </PaneSection>

      <UnsavedChangesGuard when={request !== null} />
    </>
  );
}
