# Set up Perplexity for Luma

Perplexity adds Luma's **ask_online** capability: a web-connected service that
returns a synthesized answer and citations for current or factual questions.
It is separate from raw **web_search** through SearXNG or SerpAPI. Configuring
Perplexity does not replace either raw-search provider and is not their
automatic fallback.

For ranked or subjective music research, Luma prefers Perplexity when it is
connected because it can return a ready title and artist. If the wearer
explicitly asks to “search the web,” Luma keeps the raw web-search path.

## Checklist

- [ ] A working Luma server and an operator account in Center.
- [ ] A Perplexity API project with billing or credits configured as required by
  Perplexity.
- [ ] A dedicated API key. Perplexity's
  [key-management guide](https://docs.perplexity.ai/docs/admin/api-key-management)
  says a project must exist first and the complete key is shown only once.

No Luma feature/profile is required. The `search` feature controls only
bundled SearXNG.

## Connect it

1. Open the [Perplexity API Console](https://console.perplexity.ai/), create a
   project if needed, and generate a dedicated key named for this Luma server.
   Copy it before leaving the page.

2. Sign in to Center as an operator. Open **Settings → Assistant & voice** and
   expand **Search & maps**.

3. Paste the key into **Perplexity API key**.

4. Leave **Perplexity model** blank to use Luma's default, `sonar`. Only enter
   another model identifier when Perplexity documents it as compatible with
   synchronous Sonar chat completions; a model that belongs only to the newer
   Agent API will fail here.

5. Choose **Test** beside **Perplexity API key**. Test saves pending settings,
   then asks Perplexity `Reply with OK.` using the selected model.

   You see: **Working** beside the button and
   **Perplexity answered successfully.**

6. Choose **Save changes** if you made other pending changes.

   You see: **Settings saved. Your next request will use them.** After saving,
   Center records only that the key is configured and never displays it again.

## Costs, compatibility, and limits

Checked October 2026. Perplexity is pay-as-you-go and requires no API
subscription, according to its
[API quickstart](https://docs.perplexity.ai/docs/getting-started/quickstart).
Use the API Console and current
[pricing page](https://docs.perplexity.ai/docs/getting-started/pricing) for the
charge applied to your project; each Center test is a real, billable-capable
request.

Luma currently uses Perplexity's synchronous Sonar chat-completions shape with
the `sonar` model by default. Perplexity says Sonar Chat Completions support
ended on September 27, 2026, while synchronous requests continue to work by
being reformulated as Agent API requests. It recommends Agent API for new
integrations; see its
[migration notice](https://docs.perplexity.ai/docs/agent-api/migrate-from-sonar/overview).
That provider-managed compatibility is why the Luma test is the reliable check
for this integration today.

Perplexity's current limits depend on the organization's cumulative-credit
usage tier. Its
[rate-limit documentation](https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers)
lists Agent API limits from 1 query per second at Tier 0 to 33 at Tiers 4–5 and
says rejected `429` requests are not billed. Luma makes one request at a time,
waits at most 15 seconds, and does not retry inside the same tool call.

<details>
<summary>Troubleshooting</summary>

### Test says Failed

- Replace the value with the complete key. Perplexity keys conventionally
  begin `pplx-`, but paste the entire value shown by the console.
- Confirm the project has credit/billing access and has not hit its current
  usage tier's rate limit.
- Clear **Perplexity model** and test the default `sonar`. A wrong or
  Agent-API-only model returns an error.
- Check [Perplexity status](https://status.perplexity.com/) if the same saved
  key worked recently. Luma treats timeouts and unreadable responses as
  unavailable.
- The test makes a live request and can take several seconds. It succeeds on a
  valid non-empty answer; it does not require the literal text `OK`.

### Perplexity is configured but a question uses web search

That can be correct. The assistant has separate raw-search and synthesized
answer tools and chooses between them. An explicit request to “search the web”
is forced through **web_search**. Perplexity is preferred for current prices,
availability, and ranked music research when appropriate.

</details>

## What Luma sends

Cosmos sends an HTTPS `POST` to
`https://api.perplexity.ai/chat/completions` with:

- `Authorization: Bearer YOUR_KEY`;
- JSON containing the configured model and one message with role `user` whose
  content is the question chosen for **ask_online**.

Luma does not send the wearer's Luma account identifier, location, prior chat
history, or a system prompt in this request. Perplexity receives the question,
key/project association, and normal network metadata such as the server IP. It
may search the web to synthesize the answer. Cosmos removes speech-hostile
inline citation markers, keeps up to three returned citation URLs, caps the
combined observation at 1,200 characters, and supplies it to the assistant
model.

## Rotate or remove the key

Perplexity's recommended rotation order is create, update and verify, then
revoke. Generate a new key while the old one still works, paste it into
**Perplexity API key**, choose **Test**, and wait for **Working**. Then revoke
the old key in the API Console. See Perplexity's
[rotation guidance](https://docs.perplexity.ai/docs/admin/api-key-management#api-key-rotation).

To disconnect, choose **Remove** beside **Perplexity API key**, then **Save
changes**. Raw SearXNG or SerpAPI web search remains available if configured.
Revoke the removed key in Perplexity so it cannot be used elsewhere. You may
also clear **Perplexity model**; it has no effect without a key.
