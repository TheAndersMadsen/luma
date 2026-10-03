# Connect OpenRouter

> Part of the [provider setup guides](README.md). See
> [Configure services in Center](../../docs/services.md) for the full service map.

## What this enables

OpenRouter gives Luma one API key and one endpoint for a large catalog of
models. It is a good first choice when you want to compare models or change
model vendors without changing the rest of your Luma setup. OpenRouter routes
each request to the model provider; it is not a model itself.

This connection enables the Pin's conversational answers, tool selection, and
photo understanding. Search, maps, weather, speech, and music have their own
connections in Center.

## Checklist

- [ ] Luma is running and you can sign in to Center as the operator.
- [ ] You have an [OpenRouter account](https://openrouter.ai/).
- [ ] Your account has credits, unless you are deliberately trying a free
      model.
- [ ] You have selected a model that supports **text input**, **image input**,
      **tool calling**, and the OpenAI-compatible **Chat Completions** API.

`openai/gpt-5.6-luna` is Luma's OpenRouter-oriented default and a sensible
low-cost starting point. Do not use a display name: copy the exact model ID
from the [OpenRouter model catalog](https://openrouter.ai/models). Free models
are useful for a trial, but their availability, capabilities, and low limits
make them a poor default for a voice assistant.

## 1. Create a key in OpenRouter

1. Sign in and open [OpenRouter API Keys](https://openrouter.ai/settings/keys).
2. Create a key dedicated to Luma, for example `Luma Cosmos`.
3. Set a spend limit if the key form offers one. OpenRouter also supports
   account and workspace [budgets and guardrails](https://openrouter.ai/guides/features/guardrails).
4. Copy the key when OpenRouter shows it. Treat it like a password.

Do not paste the key into a shell command, a message, or the Pin. The next step
puts it directly into Center's password field.

## 2. Enter the connection in Center

1. Open `https://YOUR_DOMAIN` and sign in as the operator.
2. Open **Settings → Assistant & voice**, then expand **Assistant**.
3. Set **Provider** to **OpenAI-compatible API**.

   **You see:** fields for **API base URL**, **API key**, **Model**,
   **Reasoning effort**, and **Maximum response tokens**.

4. Enter these values:

   | Center field | Value |
   | --- | --- |
   | **API base URL** | `https://openrouter.ai/api/v1` |
   | **API key** | The key you just copied |
   | **Model** | The exact catalog ID, for example `openai/gpt-5.6-luna` |
   | **Reasoning effort** | **Provider default** to begin with |
   | **Maximum response tokens** | `512` to begin with |

5. Choose **Save changes**.

   **You see:** `Settings saved. Your next request will use them.` The key
   field becomes blank and says `Saved. Leave blank to keep it`. Center never
   reads the stored key back into the browser.

Reasoning support varies by model. If you later choose an effort, Luma can send
**Minimal**, **Low**, **Medium**, **High**, or **Extra high** as
`reasoning.effort`. Leave **Provider default** selected when the model page
does not document the value you want. The response limit in Center accepts
64–8,192 tokens; 512 keeps spoken answers bounded and is normally enough.

## 3. Verify the connection

Choose **Test** in the Assistant card. Testing saves the current draft first,
then makes a real multimodal request: a tiny test image and the instruction to
reply with `OK`.

**You see:** **Working** and `Assistant and photo understanding are working.`

That proves the key, URL, model ID, Chat Completions response shape, and image
input all work. It does not test Azure Speech or optional search and maps
providers. After Azure Speech is connected, ask the Pin a simple question and
then one that needs a device tool, such as its battery level.

## Costs and limits

**Checked October 2026.** OpenRouter charges model inference at the price shown
on each [model page](https://openrouter.ai/models) and deducts it from prepaid
USD credits. Its Standard plan charges a 5.5% fee when credits are purchased,
not an extra inference markup. The current terms set a $5 minimum credit
purchase; unused credits may expire after 365 days. Free-only accounts are
listed at 50 requests per day, while paid accounts have higher global limits
and each upstream provider may impose its own limits. These figures can
change, so check the [current pricing](https://openrouter.ai/pricing) and
[support FAQ](https://openrouter.ai/support/) before funding the account.

Luma may make several model calls for one spoken request because a tool result
can lead to another bounded model step. Image inputs also consume billable
input tokens. Use a dedicated key limit and review OpenRouter's **Activity**
page until you know your normal spend.

## What Luma sends

For an ordinary assistant step, Cosmos sends an authenticated Bearer request
to `https://openrouter.ai/api/v1/chat/completions`. Its JSON can include:

- Luma's system instructions, the wearer's request, and the current bounded
  conversation context;
- relevant wearer memory and authenticated device context, clearly wrapped as
  data rather than system instructions;
- available tool names, descriptions, and JSON schemas, followed by tool calls
  and their results when a task needs them;
- the exact model ID, response-token limit, and optional reasoning effort;
- low-detail photo inputs for a camera question or photo understanding.

Cosmos sends no provider key to the Pin. Center stores no second copy; Cosmos
keeps the key in its owner-only state. Luma does not add OpenRouter's optional
app-attribution headers, enable Broadcast, or request provider-side web search.

OpenRouter sees the request and forwards it to a selected upstream provider.
Those providers have different retention and training policies. Review
OpenRouter's [provider comparison](https://openrouter.ai/providers/) and
[privacy policy](https://openrouter.ai/privacy/). If you require zero data
retention, enforce it in OpenRouter's Privacy/Guardrails settings and restrict
the allowed providers; choosing a model name alone is not a retention policy.
Luma's own privacy boundaries are described in [App privacy](../../docs/privacy.md).

## Troubleshooting

<details>
<summary><strong>Test says the credential or settings are wrong</strong></summary>

Confirm that the base URL is exactly `https://openrouter.ai/api/v1`, not the
model page URL, and that the model ID includes its provider prefix. Make a new
key if the original was copied only partially. A key budget or guardrail can
also reject a valid request.

</details>

<details>
<summary><strong>A text model works elsewhere but Luma's Test fails</strong></summary>

Luma's test includes an image. Select a model and route with image input as
well as Chat Completions and tool calling. A text-only model is not a complete
Luma assistant provider.

</details>

<details>
<summary><strong>The provider rejects reasoning or maximum tokens</strong></summary>

Choose **Provider default** for reasoning first. Luma sends `max_tokens`, so an
endpoint that only accepts a different parameter is not compatible with this
integration. If the model has a very small output allowance, lower **Maximum
response tokens**, but do not go below Center's minimum of 64.

</details>

<details>
<summary><strong>Requests fail intermittently or answers change</strong></summary>

OpenRouter may route the same model through more than one upstream provider.
Check the model's provider routes, your privacy restrictions, and OpenRouter's
Activity log. Pin a provider in OpenRouter if consistent routing matters.

</details>

## Rotate or remove the key

To rotate safely, create a new OpenRouter key, paste it into **API key** in
Center, choose **Test**, and only then delete the old key in OpenRouter.

To stop using OpenRouter, either select another Assistant provider and save,
or choose **Remove** beside **API key** and then **Save changes**. Merely
clearing text you just typed does not remove a stored key; the explicit
**Remove** button does. Finally revoke the key in
[OpenRouter API Keys](https://openrouter.ai/settings/keys). No Pin restart or
re-provisioning is needed.
