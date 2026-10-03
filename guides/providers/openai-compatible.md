# Connect another OpenAI-compatible provider

> Part of the [provider setup guides](README.md). See
> [Configure services in Center](../../docs/services.md) for the full service map.

## What this enables

Luma can use a hosted gateway, another model vendor, or your own inference
server when it implements the particular OpenAI-compatible surface Luma needs.
“OpenAI-compatible” is not a complete standard: two services can use that
label while differing on images, tools, reasoning, token parameters, or
response JSON.

This guide is for endpoints other than the dedicated OpenRouter and direct
OpenAI setups. If either of those is your provider, use its provider-specific
guide instead.

## Checklist

Before entering a key, confirm all of these:

- [ ] HTTPS is reachable from the **Cosmos server**, not merely from your
      laptop or LAN.
- [ ] The base URL can be followed by `/chat/completions`.
- [ ] Authentication accepts `Authorization: Bearer YOUR_KEY`.
- [ ] Requests and responses use non-streaming OpenAI Chat Completions JSON.
- [ ] The model accepts system, user, assistant, and tool messages.
- [ ] The model supports function/tool definitions and returns
      `choices[0].message.tool_calls` with JSON-string arguments.
- [ ] The model accepts image URL content, including `data:image/...` URLs,
      and can return text in `choices[0].message.content`.
- [ ] The endpoint accepts `max_tokens`.

Luma does **not** use the Responses API, `/completions`, an Anthropic-native
Messages endpoint, streaming-only output, browser cookies, query-string keys,
custom authentication headers, or a provider SDK. A translation gateway can
work if it faithfully supplies the contract above.

Reasoning is optional. At **Provider default**, Luma sends no reasoning field.
If you select an effort, it sends an OpenAI/OpenRouter-style object such as
`"reasoning": {"effort": "low"}`. Do not enable an effort unless the
provider documents that shape.

Before entering a key, also make sure:

- [ ] Luma is running and you can sign in to Center as the operator.
- [ ] You have the provider's API base URL, Bearer key, and exact model ID.
- [ ] You have checked the model's image-input and tool-calling documentation.
- [ ] You understand who operates the endpoint and where requests are stored.

For a self-hosted endpoint, use a real HTTPS hostname trusted by the Cosmos
container. `localhost` means the Cosmos container itself, not the Docker host.
Do not expose an unauthenticated inference server to the public internet just
to make it reachable.

## 1. Prepare the provider

1. Create a credential dedicated to Luma. Give it only model-inference access
   if the provider offers scopes.
2. Set a provider-side budget or rate limit where available.
3. Copy the exact API base URL. It usually ends in `/v1`, but use the
   provider's documented value. Do not include `/chat/completions`; Luma adds
   that path.
4. Copy the exact model identifier. Do not translate it to a friendly name.
5. Check the provider's data retention, training, subprocessors, and region.
   Those facts are provider-dependent; “OpenAI-compatible” says nothing about
   privacy.

## 2. Enter the connection in Center

1. Open `https://YOUR_DOMAIN` and sign in as the operator.
2. Open **Settings → Assistant & voice**, then expand **Assistant**.
3. Select **OpenAI-compatible API**.

   **You see:** **API base URL**, **API key**, **Model**,
   **Reasoning effort**, and **Maximum response tokens**.

4. Enter:

   | Center field | What to enter |
   | --- | --- |
   | **API base URL** | Provider base through `/v1`, without `/chat/completions` or a trailing slash |
   | **API key** | A Bearer credential dedicated to Luma |
   | **Model** | The provider's exact model ID |
   | **Reasoning effort** | **Provider default** for the first test |
   | **Maximum response tokens** | `512` for the first test |

5. Choose **Save changes**.

   **You see:** `Settings saved. Your next request will use them.` A stored key
   is represented only by `Saved. Leave blank to keep it`; Center never reads
   its value back.

Center removes a trailing slash from the saved base URL. It validates that the
value is a URL, but only the live test can prove the remote API contract.
Maximum response tokens accepts 64–8,192 in Center.

## 3. Verify the complete contract

Choose **Test**. Center saves the draft, then Cosmos posts a real low-detail
image request and asks for `OK`.

**You see:** **Working** and `Assistant and photo understanding are working.`

This checks the base URL, Bearer authentication, model ID, Chat Completions
response, and image input. It does **not** exercise tool calling, so finish with
a real Pin request that requires a tool, such as asking for the Pin's battery
level. Connect Azure Speech first so the Pin can hear and speak.

If you operate the endpoint, also test these failure cases before relying on
it: invalid key, unknown model, image input, one tool call, multiple tool calls,
an empty-argument tool, `max_tokens: 512`, and a response that approaches the
20-second model-step deadline. Luma normalizes missing or non-object tool
arguments to `{}`, but it does not translate a different API protocol.

## Costs and limits

**Checked October 2026.** There is no universal OpenAI-compatible price,
context window, output cap, free tier, rate limit, or availability promise.
Use the provider's current model and billing pages. Budget for more than one
model request per wearer turn: Luma can call a model, execute a tool, and call
the model again before answering. Photo inputs may have separate or tokenized
charges.

For self-hosting, the cost is the compute and operations you supply. A model
that technically runs but cannot answer within Luma's 20-second model-step
limit will behave as unavailable. Luma's **Maximum response tokens** is a
generation ceiling, not a context-window setting.

## What Luma sends

Cosmos posts to `BASE_URL/chat/completions` with a Bearer key. Depending on the
turn, the JSON contains:

- `model`, `messages`, `max_tokens`, and optionally `reasoning.effort`;
- Luma system instructions and the wearer's current request;
- bounded prior context, relevant wearer memory, and authenticated device
  context, with untrusted data kept in explicit envelopes;
- OpenAI-style function tools with JSON Schema parameters;
- assistant tool-call messages and tool-result messages;
- low-detail image URL parts for camera requests and photo understanding.

The endpoint must return `choices[0].message`. Luma reads text from `content`,
optional rationale from `reasoning`, and calls from `tool_calls[].function`.
It does not require streaming or a provider-generated conversation ID.

The key stays in Cosmos's owner-only server state and never reaches the Pin.
Center holds no second copy. The prompt, wearer content, memory selected for
the turn, tool data, and images do leave your server for the endpoint, unless
the endpoint itself runs inside infrastructure you control. A proxy or gateway
may forward them again. Review every processor in that route and compare it
with Luma's [App privacy](../../docs/privacy.md).

## Troubleshooting

<details>
<summary><strong>The URL works in a browser, but Test gets 404</strong></summary>

Enter the API base, not a dashboard, model page, or full completion URL. If the
provider documents `https://example.test/v1/chat/completions`, enter
`https://example.test/v1`. Luma appends `/chat/completions`.

</details>

<details>
<summary><strong>Test gets 401 or 403</strong></summary>

Luma supports a Bearer key only. Confirm the key's scopes, allowed models,
budget, source-IP rules, and expiry. An endpoint that requires `x-api-key`,
signed requests, cookies, or query authentication needs a compatible gateway.

</details>

<details>
<summary><strong>Text works, but Center's Test fails</strong></summary>

The model or gateway probably lacks OpenAI-style image input, rejects data
URLs, or returns a different content shape. The Assistant provider must support
photo understanding; the test intentionally checks it.

</details>

<details>
<summary><strong>Test works, but tool requests fail</strong></summary>

The test does not exercise tools. Confirm the endpoint accepts `tools` and
returns OpenAI-style `tool_calls`, including valid JSON arguments. Some local
model servers advertise Chat Completions but omit tool calling for particular
models or templates.

</details>

<details>
<summary><strong>The endpoint rejects <code>max_tokens</code> or reasoning</strong></summary>

Reasoning can be omitted by selecting **Provider default**. `max_tokens`
cannot currently be renamed or omitted from Center when its value is nonzero;
use a gateway that translates it or choose a compatible endpoint. Center's UI
does not allow zero.

</details>

<details>
<summary><strong>A local endpoint times out</strong></summary>

Check connectivity from the Cosmos container, TLS trust, model cold-start
time, and generation speed. A call must finish inside Luma's 20-second model
step. Preload the model or use faster hardware/model settings rather than
raising Luma's bounded foreground deadline.

</details>

## Rotate or remove the key

Create the replacement credential at the provider, paste it into **API key**,
choose **Test**, and then revoke the old credential. To move to a new endpoint,
change URL, key, and model together so Test validates the combination.

To remove the saved credential, choose **Remove** beside **API key** and then
**Save changes**. Clearing newly typed text keeps the previously stored value;
only **Remove** schedules deletion. Revoke the credential at the provider too.
No Pin restart or re-provisioning is required.
