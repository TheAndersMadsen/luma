# Connect Wolfram|Alpha

Wolfram|Alpha is an optional computational-knowledge provider. It gives Luma a
grounded tool for calculations, conversions, measurements, dates, physical
constants, populations, and similar questions that ordinary web search may
answer poorly.

**Provider details checked October 2026.** Wolfram offers immediate free API
access for non-commercial development and documents its current products at
the [Wolfram|Alpha APIs site](https://products.wolframalpha.com/api/).

## What this enables

- Natural-language calculations and factual computations.
- Unit and measurement conversions.
- Structured facts such as populations, distances, dates, and constants.
- Compact text designed for an assistant model rather than a web result page.

This connection does not replace Luma’s main assistant or web search. The
assistant decides when a question suits Wolfram|Alpha, and the provider may
decline or restrict subjects that work on the public Wolfram|Alpha website.

## Checklist

- [ ] You have or can create a Wolfram ID.
- [ ] Your use fits Wolfram’s API terms and selected plan. The advertised free
      allowance is for non-commercial use.
- [ ] You can sign in to Center as the operator.

## Create an AppID

1. Open the [Wolfram|Alpha Developer Portal](https://developer.wolframalpha.com/)
   and sign in with a Wolfram ID. Create a Wolfram ID if prompted.

   You see: the developer portal and its applications area.

2. Choose **Get an AppID**. Give the application a recognizable name such as
   `Luma`, add a short description, and select the application type that best
   matches your self-hosted use.

   These are the steps in Wolfram’s
   [official API getting-started documentation](https://products.wolframalpha.com/api/documentation/).

3. Finish creating the application and copy its AppID.

   You see: an AppID associated with that application. Treat it as a private
   credential even though Wolfram calls it an ID; Wolfram’s own library
   documentation says it must be kept secret.

## Add it to Luma

1. In Center, open **Settings → Assistant & voice**.
2. Expand **Search & maps**.
3. Paste the AppID into **Wolfram App ID**.
4. Choose **Test Wolfram|Alpha**. Testing also saves every pending change on
   this page.

   You see: **Wolfram|Alpha answered successfully.** Luma tests the exact query
   `2 + 2` through Wolfram’s LLM API. This proves the saved AppID can answer a
   basic request; it does not prove that every knowledge domain is included in
   your plan.

After a successful save, Center clears the field and marks it configured. It
never reads the saved AppID back into the browser.

## Verify the whole path

1. Unlock the Pin and ask: **“How many kilometers are in 26.2 miles?”**

   You see and hear: a computed conversion rather than a list of web results.

2. Ask: **“What is the population of Denmark?”**

   You see and hear: a concise answer grounded in Wolfram|Alpha when the
   assistant selects the computational-knowledge tool.

The Center test is the deterministic credential check. A spoken question also
depends on the configured assistant choosing the Wolfram tool, so a different
tool choice does not by itself mean the AppID failed.

## Costs and limits

**Checked October 2026.** Wolfram advertises **up to 2,000 non-commercial API
calls per month** with immediate free access. Commercial use and higher-volume
plans require contacting Wolfram for pricing. See
[Wolfram|Alpha API products](https://products.wolframalpha.com/api/) and the
[API pricing contact page](https://products.wolframalpha.com/api/pricing/).

The exact quota and number of AppIDs for your application appear in the plan
summary in the developer portal. Wolfram’s
[API terms](https://products.wolframalpha.com/api/termsofuse) say quotas can
change, prohibit circumventing them, restrict caching, and impose linking or
attribution requirements unless a separate agreement says otherwise. Review
those terms for your use, especially before any commercial or public-facing
deployment.

Each successful Center test uses one API call. Each assistant tool call uses
one. Luma makes no automatic background Wolfram queries.

## What Luma sends

When the assistant selects this tool, Cosmos makes an HTTPS GET request to
Wolfram|Alpha’s LLM API with:

- the saved AppID in the `appid` query parameter; and
- a text `input` query chosen from the wearer’s request, URL-encoded.

For example, the connection test sends `2 + 2`. A real request may be a concise
rephrasing selected by the assistant rather than the wearer’s exact sentence.
Luma does not send the wearer’s account ID, Pin ID, location, saved notes, or
audio.

The provider returns plain text formatted for a language model. Luma removes
`image:` lines, keeps at most 1,200 characters, and uses that text as untrusted
tool output in the current assistant turn; it does not maintain a separate
Wolfram result cache. The AppID stays in Cosmos’s owner-only state volume and
never goes to the Pin. Because the AppID is in the provider URL, Cosmos avoids
logging that URL or network errors that could contain it.

## Troubleshooting

<details>
<summary><strong>Test says the provider did not complete the request</strong></summary>

Copy the AppID again from the developer portal and replace **Wolfram App ID**.
Do not use a Wolfram account password or a Mathematica license number. Confirm
that the application is active and still has quota, then test again.

</details>

<details>
<summary><strong>A valid question returns no answer</strong></summary>

Wolfram documents that not every subject on its public website is available
through every API plan. Luma treats HTTP 400 or 501 as “no result” instead of
inventing an answer. Try a more explicit computational query; use web search
for prose, news, or a subject outside Wolfram’s API coverage.

</details>

<details>
<summary><strong>Center test works, but the Pin uses web search</strong></summary>

The test calls Wolfram directly, while an ordinary spoken turn lets the main
assistant choose the appropriate tool. Ask an unambiguous calculation or unit
conversion. The Wolfram connection supplements the assistant; it does not
route every factual question there.

</details>

<details>
<summary><strong>The answer is shorter than the Wolfram website</strong></summary>

Luma uses Wolfram’s text-oriented LLM API, discards image links, and caps the
tool observation at 1,200 characters so one result cannot crowd out the rest
of the assistant turn. It does not render Full Results pods or plots on the
Pin.

</details>

## Rotate or remove the AppID

Create a replacement AppID for the Luma application in the developer portal,
paste it into **Wolfram App ID**, and choose **Test Wolfram|Alpha**. After it
passes, deactivate the old AppID in Wolfram’s portal if the portal offers that
control.

To disconnect it, choose **Remove** beside **Wolfram App ID**, then **Save
changes**. The computational-knowledge tool becomes unavailable; Luma does not
silently send those queries to Wolfram without an AppID.
