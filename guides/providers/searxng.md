# Set up SearXNG for Luma

SearXNG gives the assistant private, self-hosted web search. Luma prefers it
over SerpAPI whenever a **SearXNG URL** is configured. If both are configured,
Luma automatically tries SerpAPI only when SearXNG is unavailable, returns no
result, or returns no result from any of Luma's broad-web engines.

The easiest option is Luma's bundled SearXNG. It is part of the optional
`search` feature and needs no provider account or API key. You can instead use
another SearXNG instance that you operate. Do not use an arbitrary public
instance: its JSON API may be disabled, its operator can see your searches,
and it may rate-limit server traffic.

## Checklist

- [ ] A working Luma production server and an operator account in Center.
- [ ] For bundled search: the `search` feature selected during
  `./luma onboard production`.
- [ ] For another instance: an `http://` or `https://` base URL that Cosmos can
  reach, with JSON search output enabled. The official
  [Search API documentation](https://docs.searxng.org/dev/search_api.html)
  explains that `format=json` must be allowed in `settings.yml` or the server
  returns `403`.
- [ ] No username, password, query string, or fragment in the URL.

## Set up bundled SearXNG

1. On the server, run:

   ```sh
   ./luma onboard production
   ```

2. At **Features (pin, search, spotify, observability; or none)**, include
   `search`. Keep any other features you already use, review the summary, and
   confirm the configuration.

   You see: the final review lists `search` under **Features**.

3. Deploy the resulting configuration if onboarding tells you to do so.

4. Sign in to Center as an operator. Open **Settings → Assistant & voice**,
   expand **Search & maps**, and find **SearXNG URL**.

   You see: `http://searxng:8080`. This is the private service-network address;
   do not replace it with a public hostname.

5. Choose **Test** beside **SearXNG URL**. Test saves pending settings before
   making a real search for `OpenAI` and succeeds only when a configured
   broad-web engine returns results.

   You see: **Working** beside the button and
   **SearXNG returned search results.**

## Connect another self-hosted instance

Use SearXNG's maintained
[container installation guide](https://docs.searxng.org/admin/installation-docker)
or [administrator documentation](https://docs.searxng.org/admin/) to install
and secure the instance. Luma only requires these integration details:

1. In the instance's `settings.yml`, allow `json` under `search.formats`.
   Enable at least one of **Bing**, **ResultHunter**, **Yahoo**, or **Yandex**;
   those are the broad-web engine names Luma recognizes when it tests health.
   Restart SearXNG after changing its settings.

2. From the Cosmos server, verify that the base URL is reachable and that a
   request to `/search?q=OpenAI&format=json` returns JSON. Do not put a secret
   in a shell command or in the URL.

3. In Center, open **Settings → Assistant & voice → Search & maps**. In
   **SearXNG URL**, enter the base URL only, for example
   `https://search.example.com` or `https://example.com/searxng`. Do not append
   `/search`; Luma appends it.

4. Choose **Test**.

   You see: **Working** and **SearXNG returned search results.**

5. Choose **Save changes** if you made any other pending changes.

   You see: **Settings saved. Your next request will use them.**

An external SearXNG URL does not require Luma's `search` feature. That feature
exists only to run the bundled container.

## Costs and limits

Checked October 2026. SearXNG is free, open-source software; you pay for the
server and for any upstream search API that you choose to enable. It has no
single service-wide request quota because you operate it, but its upstream
engines can block or limit traffic. The official installation documentation
recommends configuring the limiter for exposed instances; Luma's bundled
instance is private to the application network.

Luma gives each SearXNG request five seconds, sends at most 512 bytes of
normalized query text, accepts at most 256 KiB of JSON, and keeps at most four
result summaries. The **Test** action performs one real search.

<details>
<summary>Troubleshooting</summary>

### Test says Failed

- Confirm Cosmos can reach the URL. `localhost` means the Cosmos container
  itself, not another container or the host.
- Confirm the URL is a base URL, not a `/search` URL, and has no credentials,
  query string, or `#fragment`.
- A `403` commonly means JSON is absent from `search.formats`; see the official
  [Search API](https://docs.searxng.org/dev/search_api.html).
- The test deliberately ignores SerpAPI fallback and requires a broad-web
  SearXNG result. A healthy page with only a narrow or last-resort result can
  therefore still show **Failed**.
- If the bundled instance is absent, rerun `./luma onboard production`, retain
  your existing features, add `search`, then deploy and test again.

### Search sometimes falls back to SerpAPI

That is expected when both are configured. Luma preserves SearXNG as the first
choice, but uses SerpAPI when SearXNG is unavailable, empty, or has no
broad-web result. Remove the SerpAPI key if queries must never leave your
self-hosted path.

</details>

## What Luma sends

For each assistant web search, Cosmos sends an HTTP `GET` to the configured
base URL plus `/search` with:

- `q`: the wearer's search query, whitespace-normalized and capped at 512
  bytes;
- `format=json`, `categories=general`, `language=en`, `safesearch=1`, and
  `pageno=1`.

Luma sends no wearer account identifier and no SearXNG credential. Your
SearXNG server sees the request and query; the engines enabled in that instance
receive whatever its configuration sends upstream. Cosmos reads result titles,
snippets, and engine names, ranks them for relevance, and gives at most four
compact results to the assistant model.

## Change or remove it

- To switch instances, replace **SearXNG URL**, choose **Test**, and confirm
  **Working**. Test saves the new URL.
- To stop using SearXNG but keep SerpAPI, clear **SearXNG URL** and choose
  **Save changes**. The next web search uses SerpAPI.
- To remove bundled SearXNG itself, rerun `./luma onboard production`, omit
  `search` while retaining every other feature you use, then deploy. Clear the
  old **SearXNG URL** in Center as well.
