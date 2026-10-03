# Connect Pirate Weather

Pirate Weather is an optional provider for current conditions and forecasts.
With it, the Pin can answer questions such as “What’s the weather here?” and
“Will it rain tomorrow?” Luma still needs its normal assistant and speech
connections.

**Provider details checked October 2026.** Pirate Weather describes itself as
an open, free, Dark Sky-compatible API and links its current registration
portal from the [official documentation](https://docs.pirateweather.net/en/latest/).

## What this enables

- Current conditions on the stock Pin weather path: summary, temperature,
  precipitation, UV index, and a compatible weather icon.
- Spoken daily forecasts for today and the coming week, including summary,
  high and low temperature, and precipitation probability and type when the
  provider supplies them.
- Weather for the Pin’s current coordinates when location access is on.
- Weather for a named place when Google Maps is also connected so Luma can
  resolve that name to coordinates.

Pirate Weather does not by itself turn “Copenhagen” into coordinates. Without
Google Maps, local weather can still work from the Pin’s own location, but a
named-place request cannot be resolved. Luma currently does not pass through
Pirate Weather alerts, wind, hourly detail, air quality, or historical weather,
even though the provider API offers more fields.

## Checklist

- [ ] You can receive email for a Pirate Weather portal account.
- [ ] You can sign in to Center as the operator.
- [ ] Location access is on under **Settings → Privacy** if you want weather
      “here”.
- [ ] Optional: Google Maps is connected if you want weather for named places.

## Get a Pirate Weather API key

1. Open Pirate Weather’s
   [Get an API key](https://pirate-weather.apiable.io/) page. Register or sign
   in through the portal.

   You see: the Pirate Weather API portal. The portal is JavaScript-based, so
   allow scripts for this page.

2. Select the free Pirate Weather API product or subscription shown by the
   portal and complete its subscription flow.

3. Open the subscription or API-key area and copy the issued API key. The
   portal’s labels can change; use the value it identifies as the API key or
   authentication token, not your account password.

   Pirate Weather’s [API specification](https://docs.pirateweather.net/en/latest/Specification/)
   confirms that each forecast request requires this token in the request
   path.

## Add it to Luma

1. In Center, open **Settings → Assistant & voice**.
2. Expand **Search & maps**.
3. Paste the key into **Weather API key**.
4. Choose **Test Pirate Weather**. Testing also saves every pending change on
   this page, so finish or discard other provider drafts first.

   You see: **Pirate Weather returned current conditions.** Center’s test asks
   for current conditions at fixed coordinates in Copenhagen. It proves that
   the saved key works and that Luma can render the response; it does not test
   the Pin’s location permission, named-place resolution, or tomorrow’s daily
   forecast.

After a successful save, Center clears the field and marks it configured. It
never reads the saved key back into the browser.

## Verify the whole path

1. Unlock the Pin and say: **“What’s the weather here?”**

   You see and hear: the Pin asks for its location once, then answers with
   current conditions. If location access is off, Luma explains that before
   contacting Pirate Weather.

2. Say: **“Will it rain here tomorrow?”**

   You see and hear: a forecast grounded in tomorrow’s daily result. If the
   provider returns no daily forecast, Luma does not invent one.

3. If Google Maps is connected, say: **“What will the weather be in Copenhagen
   tomorrow?”**

   You see and hear: Luma resolves Copenhagen through Google and then asks
   Pirate Weather for those coordinates.

## Costs and limits

**Checked October 2026.** Pirate Weather documents a free allowance of
**10,000 calls per month**. Its project page says a **US$2 monthly donation**
raises that key to **20,000 calls per month**. Check the portal before
subscribing because plans can change. See the provider’s
[current introduction and support terms](https://docs.pirateweather.net/en/latest/#introduction).

Each successful Center test uses one call. A Luma current-weather request uses
one call, and a spoken forecast request uses one call. The API returns quota
headers, and responds with HTTP 429 after the monthly allowance is exhausted;
Pirate Weather documents these in
[Alerts, Flags & Errors](https://docs.pirateweather.net/en/latest/API/alerts-flags-errors/).

Forecast quality and detail vary by place. Pirate Weather combines regional
and global numerical models, with higher-resolution sources in some regions;
its [data-source documentation](https://docs.pirateweather.net/en/latest/DataSources/)
explains the coverage and fallbacks. Treat a forecast as a forecast, not an
observation or safety warning.

## What Luma sends

For each request Cosmos sends Pirate Weather:

- the saved API key in the forecast URL path;
- latitude and longitude;
- `units=us`; and
- an exclusion list so Pirate Weather omits blocks Luma will not use.

For the stock current-weather RPC, Luma asks only for the current block. For a
spoken forecast, it asks for current conditions and daily data. It does not
send the wearer’s words, name, account identifier, or Pin identifier to Pirate
Weather. The service necessarily learns the requested coordinates and the
server IP address. When a place name must be resolved, that name goes to the
separately configured Google Maps provider; Pirate Weather receives only the
resulting coordinates.

The API key is part of Pirate Weather’s URL format. Cosmos deliberately avoids
logging that URL or network errors containing it. The key stays in Cosmos’s
owner-only state volume and is never sent to the Pin.

## Troubleshooting

<details>
<summary><strong>Test says the provider did not complete the request</strong></summary>

Confirm that you copied the API key rather than the portal password and that
the subscription is active. A newly created subscription may need a short
time to activate. Pirate Weather documents HTTP 401 for a missing or
unauthorized key and HTTP 429 for an exhausted quota.

</details>

<details>
<summary><strong>Weather here says no location is available</strong></summary>

Open **Settings → Privacy** and turn on **Location access**, then unlock the Pin
and try again. The provider test does not exercise this permission. Luma will
not substitute a guessed coordinate.

</details>

<details>
<summary><strong>Weather here works, but a city name does not</strong></summary>

Connect Google Maps under **Settings → Assistant & voice → Search & maps**.
Luma uses Google Places to resolve a named place before it can call Pirate
Weather. Testing Pirate Weather alone bypasses that step.

</details>

<details>
<summary><strong>The weather icon or wording seems less specific</strong></summary>

The stock Pin expects AccuWeather-style icon numbers, while Pirate Weather
returns Dark Sky-style icon names. Luma maps each known Pirate Weather icon to
the nearest icon the stock renderer supports and uses a generic partly-cloudy
icon for an unknown value. This mapping is approximate. Spoken answers expose
only the current and daily fields Luma maps, not every field in the provider
response.

</details>

## Rotate or remove the key

To rotate it, create or reveal a replacement in the Pirate Weather portal,
paste it into **Weather API key**, and choose **Test Pirate Weather**. Once the
new key passes, revoke the old key in the provider portal.

To disconnect it, choose **Remove** beside **Weather API key**, then **Save
changes**. Future forecasts become unavailable; local or named weather is not
silently routed to another provider. Revoke the unused key in Pirate Weather’s
portal as well.
