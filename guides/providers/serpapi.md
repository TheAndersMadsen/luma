# Set up SerpAPI for Luma

SerpAPI gives the assistant Google web results without running SearXNG. If a
**SearXNG URL** is also configured, SearXNG stays first and SerpAPI becomes the
automatic fallback when it is unavailable or has no broad-web result.

## Checklist

- [ ] A working Luma server and an operator account in Center.
- [ ] A SerpAPI account and private API key from **Your Account**. SerpAPI's
  [Account API documentation](https://serpapi.com/account-api) confirms that
  the private key is available there and shows the account's remaining quota.
- [ ] Enough monthly searches for the Pin's use and for one real search each time
  you choose **Test**.

No Luma feature/profile is required. The optional `search` feature runs bundled
SearXNG; SerpAPI works without it.

## Connect it

1. Sign in to [SerpAPI](https://serpapi.com/users/sign_in), open **Your
   Account**, and copy your private API key. Treat it like a password.

2. Sign in to Center as an operator. Open **Settings → Assistant & voice** and
   expand **Search & maps**.

3. Paste the key into **SerpAPI key**.

   You see: the field contains the key only while you are editing it. After it
   is saved, Center shows that it is configured and never reveals it again.

4. Choose **Test** beside **SerpAPI key**. Test saves pending settings, then
   makes a real Google search for `OpenAI` using this exact credential. It tests
   SerpAPI directly even when SearXNG is configured.

   You see: **Working** beside the button and
   **SerpApi returned search results.**

5. Choose **Save changes** if you made other pending changes.

   You see: **Settings saved. Your next request will use them.**

## Costs and limits

Checked October 2026. SerpAPI's current
[plans and pricing](https://serpapi.com/pricing) list a free plan with 250
searches per month and 50 successful searches per hour. Paid month-to-month
plans start at US$25 for 1,000 searches per month and 200 per hour. Plans,
prices, and quotas can change; use **Your Account** as the source of truth for
your plan and remaining searches. SerpAPI says cached identical searches are
free, while legitimately empty searches count; its
[Google Search API documentation](https://serpapi.com/search-api) has the
current billing behavior.

Every Luma web query sent to SerpAPI is one synchronous Google Search API
request. **Test** also consumes a search unless SerpAPI serves it from cache.
Luma waits up to five seconds and does not retry the provider request.

<details>
<summary>Troubleshooting</summary>

### Test says Failed

- Check for leading/trailing whitespace or a partial key, replace the value,
  and test again.
- Open SerpAPI **Your Account** and check account status, searches left, and
  hourly throughput. The free Account API check itself does not consume quota.
- A rejected key, exhausted plan, timeout, non-JSON reply, or a response larger
  than Luma's 256 KiB safety cap all fail the test.
- The test is independent of SearXNG. A working SearXNG connection cannot make
  a bad SerpAPI key show **Working**.

### Web search works but SerpAPI usage stays low

If **SearXNG URL** is configured, that is expected: Luma searches SearXNG first
and calls SerpAPI only for fallback. Clear the SearXNG URL if you intend
SerpAPI to be the primary raw-search provider.

### Results differ from a browser search

Luma sends no location, country, language, or signed-in Google context.
SerpAPI notes that omitted location can use the proxy location and that search
parameters and login context change results; see its
[Google Search API documentation](https://serpapi.com/search-api).

</details>

## What Luma sends

Cosmos sends an HTTPS `GET` to `https://serpapi.com/search.json` with exactly
these query parameters:

- `engine=google`;
- `q`: the wearer's search query, whitespace-normalized and capped at 512
  bytes;
- `api_key`: your SerpAPI private key.

SerpAPI therefore receives the query, the key/account association, and normal
network metadata such as the server IP. Luma does not send the wearer's Luma
account identifier, location, browser cookies, language, or Google login. From
the response it uses a direct answer, knowledge-graph description, or up to
four organic-result titles and snippets, then supplies that compact observation
to the assistant model.

## Rotate or remove the key

SerpAPI provides **Regenerate API Key** on its API Keys dashboard, as described
in its official [key-security guide](https://serpapi.com/blog/how-to-securely-store-api-keys/).
Regenerating invalidates the old key: copy the new value immediately, enter it
in **SerpAPI key**, and choose **Test**. Expect searches to fail between
regeneration and the successful Luma test.

To disconnect, choose **Remove** beside **SerpAPI key**, then **Save changes**.
If SearXNG is configured, web search continues through SearXNG; otherwise the
assistant no longer has Luma's raw web-search provider. If the key must stop
working everywhere, use **Regenerate API Key** in SerpAPI after removing it
from Luma.
