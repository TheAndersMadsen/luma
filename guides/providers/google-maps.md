# Set up Google Maps for Luma

Google Maps is optional. It gives Luma grounded place searches, reverse
geocoding, radio-based location fixes, and spoken route guidance. It does not
start continuous turn-by-turn navigation.

Luma calls Google from Cosmos on your server. The API key stays on the server;
Center does not show it again after saving, and the key is never sent to the
Pin.

## Before you start

You need:

- a Google account;
- a Google Cloud project with billing enabled;
- the stable public egress IP address of your Luma server, if you want to apply
  Google's recommended IP restriction; and
- an operator account in Center.

Google requires a billing-enabled project even when usage remains within a
free usage cap. Its [Google Maps Platform getting-started
guide](https://developers.google.com/maps/get-started) explains the project,
billing, API-enablement, and credential prerequisites.

For the complete Luma integration, enable these four APIs in the same project:

| Google service | What Luma uses it for |
| --- | --- |
| **Places API (New)** | Nearby searches and resolving a named route destination |
| **Routes API** | Walking, driving, cycling, and transit directions |
| **Geocoding API** | Turning the Pin's coordinates into an address for questions such as “Where am I?” |
| **Geolocation API** | Best-effort coordinates from Wi-Fi access points and cell towers when the Pin asks for a radio-based fix |

Do not enable **Places API (Legacy)** or **Directions API (Legacy)** for Luma.

## Set it up

1. Open the [Google Cloud project selector](https://console.cloud.google.com/projectselector2/home/dashboard)
   and create a project, or select a project used only for this Luma server.

   You see: the new project name in the project selector at the top of Google
   Cloud Console.

2. Link a billing account to the project. Google Maps Platform will not serve
   normal API traffic without billing. Follow Google's [billing setup
   instructions](https://developers.google.com/maps/get-started#step_1_set_up_your_google_cloud_project_and_account).

   You see: **Billing account** on the project's Billing overview, with no
   prompt to link an account.

3. Open the [Google Maps Platform API
   Library](https://console.cloud.google.com/google/maps-apis/api-list), search
   for each service below, open it, and choose **Enable**:

   1. **Places API (New)**
   2. **Routes API**
   3. **Geocoding API**
   4. **Geolocation API**

   If the page says **Manage**, that API is already enabled. Google's
   [API-enablement instructions](https://developers.google.com/maps/get-started#step_2_enable_the_apis_or_sdks_to_use)
   describe the same Console flow.

   You see: all four names under **APIs & Services → Enabled APIs & services**.

4. Open [Google Maps Platform →
   Credentials](https://console.cloud.google.com/google/maps-apis/credentials),
   choose **Create credentials → API key**, and copy the new key.

   Treat the key like a password. Do not put it in a command, source file,
   issue, or chat message.

   You see: a new API key in the project's credentials list.

5. Select the key and restrict it before using it:

   - Under **Application restrictions**, choose **IP addresses** and add the
     public egress IP address of the Luma server. If the server's egress address
     changes, update this restriction before testing again.
   - Under **API restrictions**, choose **Restrict key** and select only
     **Places API (New)**, **Routes API**, **Geocoding API**, and **Geolocation
     API**.
   - Choose **Save**.

   Luma makes server-side HTTPS requests, so Android-app and website-referrer
   restrictions are the wrong types. Google recommends both API restrictions
   and IP restrictions for a server-side web-service key in its [Maps API
   security guidance](https://developers.google.com/maps/api-security-best-practices#protect_web_service_api_keys).

   You see: the key lists **IP addresses** and the four allowed APIs. Google may
   take a few minutes to apply a new restriction.

6. In Center, sign in as the operator and open **Settings → Assistant & voice →
   Search & maps**. Paste the key into the field named **Google Maps key**.

   Choose **Test** next to that field. Testing saves this pending key before it
   contacts Google; you do not need to choose **Save changes** first.

   You see: the button says **Testing…**, then **Working**, and the page says
   **Google Maps returned nearby places and a route.** Center clears the key
   field and later shows **Saved. Leave blank to keep it**.

   This test searches for coffee near fixed Copenhagen coordinates, resolves
   Nyhavn, and requests a walking route. It verifies **Places API (New)** and
   **Routes API** only. It does not use the Pin, the wearer's saved location,
   **Geocoding API**, or **Geolocation API**.

7. To use automatic nearby search, directions, or “Where am I?” on the Pin,
   open **Settings → Privacy & data** and turn on **Location access** only if the
   wearer consents.

   **Save last location** is separate. It only lets Cosmos retain the latest
   sealed location sent by the Pin; it does not enable Google Maps and is not
   required for a live location-based answer. Location access is a Luma consent
   control, not the Pin's Android sensor switch.

   You see: **Location access** is on. For an end-to-end check, ask the Pin
   “Where am I?”, then “Find coffee near me” and “Give me walking directions to
   the nearest one.” The first question checks reverse geocoding; the latter two
   check real Pin-location place search and routing. A named city or place can
   still be searched when automatic Location access is off.

## Costs and limits

Checked October 2026. Google can change prices, free usage caps, and quotas, so
confirm them on the [official Maps Platform pricing
list](https://developers.google.com/maps/billing-and-pricing/pricing) before
relying on them.

Luma's current request shapes can produce these billing events:

| Luma operation | Google billing event | Monthly free usage cap | First paid tier, per 1,000 events (USD) |
| --- | --- | ---: | ---: |
| A full nearby-place search | Places API Nearby Search Enterprise + Atmosphere | 1,000 | $40.00 |
| Resolving a route destination to its ID | Places API Text Search Essentials (IDs Only) | Unlimited | No charge listed |
| Reverse geocoding coordinates | Geocoding | 10,000 | $5.00 |
| A Wi-Fi/cell location fix | Geolocation | 10,000 | $5.00 |
| Computing a route | Routes: Compute Routes Essentials | 10,000 | $5.00 |

One spoken request may cause more than one billing event. For example, a route
uses a Places text search to identify the destination and then a Routes request.
Choosing **Test** causes one full nearby search, one destination-ID search, and
one route request.

The price of Luma's full nearby search is driven by the place fields it asks
Google to return, including ratings, opening state, phone, website, and editorial
summary. Places (New) charges according to the highest field category in a
request; Google documents this in [Places usage and
billing](https://developers.google.com/maps/documentation/places/web-service/usage-and-billing).

Luma itself returns at most 20 places, limits a search circle to 50 km, uses 1
km when no valid radius is supplied, and gives the Center provider test 30
seconds. Google separately lists a 3,000-queries-per-minute limit for both
[Compute Routes](https://developers.google.com/maps/documentation/routes/usage-and-billing#usage_limits)
and [Geocoding](https://developers.google.com/maps/documentation/geocoding/usage-and-billing#usage_limits).
See the project's **Google Maps Platform → Quotas** page for the quotas actually
assigned to your project and API.

Create a Cloud Billing budget and alerts, and consider lowering per-API quotas
to match personal use. A budget alert is only a notification: it does **not**
stop API use or cap spending. Google explains that distinction and the delay
between quota and billing systems in [Manage Google Maps Platform
costs](https://developers.google.com/maps/billing-and-pricing/manage-costs#budgets-and-alerts).
An overly low quota can make Pin requests fail, so lower it gradually and test
again.

## What Luma sends

Cosmos sends only the data needed for the requested Maps operation:

- **Authentication:** every request carries the Google Maps key. Places and
  Routes receive it in the `X-Goog-Api-Key` header; the current Geocoding and
  Geolocation endpoints receive it in the HTTPS query string.

- **Nearby or named-place search:** the search words; when location is relevant,
  latitude, longitude, and a radius; English as the response language; and a
  field mask for the place details Luma can speak or return. Google can return
  place IDs, names, formatted addresses, types, coordinates, ratings and rating
  counts, current open state, phone numbers, websites, and editorial summaries.
- **Directions:** the Pin's latitude and longitude, the Google place ID resolved
  from the spoken destination, the requested travel mode when one was named, and
  English as the response language. Google can return route distance, duration,
  and bounded step or transit details.
- **Reverse geocoding:** latitude and longitude. Google returns address
  components such as street, locality, region, country, and postal code.
- **Radio-based geolocation:** whether Google may consider the request IP;
  observed Wi-Fi MAC addresses with signal strength, signal-to-noise ratio,
  channel, and age; and observed cell identifiers, network and country codes,
  radio type, carrier, age, signal strength, and timing advance. Google's
  [Geolocation request reference](https://developers.google.com/maps/documentation/geolocation/requests-geolocation)
  describes how those radio observations produce a coordinate and accuracy
  radius.

The whole assistant transcript, Luma account identifier, notes, captures, and
contacts are not added to these requests. The place query or destination itself
can reveal what the wearer asked to find, and coordinates are precise location
data. Google also receives ordinary network metadata from the Luma server.

## Rotate or remove the key

To rotate a working key:

1. In Google Cloud, open **Google Maps Platform → Credentials**, select the key,
   and choose **Rotate key**. Google temporarily accepts both versions.
2. In Center, open **Settings → Assistant & voice → Search & maps**, paste the new
   value into **Google Maps key**, and choose **Test**.
3. After Center shows **Working** and the success message, return to Google Cloud
   and delete the previous key from the rotated key's **Previous Key** section.

Google recommends checking usage before rotation or deletion and documents the
overlap procedure in [Be careful when rotating API
keys](https://developers.google.com/maps/api-security-best-practices#be_careful_when_rotating_api_keys).
No Cosmos restart or Pin reprovisioning is needed; the next request uses the
saved value.

To stop using Google Maps in Luma, open the same **Google Maps key** field,
choose **Remove**, and then **Save changes**. After that succeeds, delete the key
in Google Cloud if nothing else uses it. You can also disable the four APIs in
that project when they have no other consumer. Deleting the Cloud key first can
leave Luma configured with a key that every request rejects.

<details>
<summary>Troubleshooting</summary>

### “Google refused this key for place search”

Confirm that billing is linked, **Places API (New)** is enabled, the key's API
restriction includes it, and the server's current public egress IP is allowed.
Do not substitute **Places API (Legacy)**.

### “Place search works, but Google refused this key for directions”

Enable **Routes API** and add it to the key's API restrictions. Do not enable
**Directions API (Legacy)** instead.

### “Google Maps did not answer a test place search”

Wait a few minutes after enabling an API or changing restrictions, then test
again. Check that the project still has active billing and that an IP
restriction names the server's egress IP, not the Pin's IP or the address of the
computer running Center.

### The test passes, but “Where am I?” fails

The Center test does not exercise **Geocoding API** or the wearer's location.
Enable **Geocoding API**, include it in the key restrictions, turn on **Settings
→ Privacy & data → Location access**, and try from the Pin again.

### A radio-based location fix is refused

Enable **Geolocation API** and include it in the key restrictions. A valid
request can still return no result when Google cannot place the observed Wi-Fi
access points or cell towers; that is different from a refused key.

### The card says Configured, but requests fail

**Configured** means a value is saved, not that every Google API accepted it.
Choose **Test** for Places and Routes, then use the Pin checks above for
Geocoding and the real location flow. Review **Google Maps Platform → Metrics**
and **Quotas** for rejected traffic or an exhausted quota.

### Nothing changed after pasting a replacement

Choose **Test** or **Save changes**. Merely typing in the password field leaves
the new value as an unsaved draft. Leaving an already configured field blank
keeps the stored key; only **Remove** queues its deletion.

</details>
