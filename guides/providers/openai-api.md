# Connect the OpenAI API

> Part of the [provider setup guides](README.md). See
> [Configure services in Center](../../docs/services.md) for the full service map.

## What this enables

The OpenAI API lets Luma call an OpenAI model with a project API key and
pay-as-you-go API billing. This is different from connecting a ChatGPT or Codex
subscription. A ChatGPT subscription does not pay an API bill, and API credit
does not become ChatGPT credit. OpenAI's
[authentication documentation](https://developers.openai.com/codex/auth)
distinguishes ChatGPT subscription access from API-key usage billed at standard
API rates.

This connection enables the Pin's conversational answers, tool selection, and
photo understanding. It does not replace the separate Azure Speech connection
that lets the Pin hear and speak.

## Checklist

- [ ] Luma is running and you can sign in to Center as the operator.
- [ ] You can sign in to the [OpenAI API Platform](https://platform.openai.com/).
- [ ] API billing is enabled for the project you will use.
- [ ] The project can use a model with Chat Completions, image input, and
      function calling.

For a low-cost starting point, use `gpt-5.6-luna`. OpenAI's
[model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
documents Chat Completions, image input, and function calling for that exact
ID. Luma uses Chat Completions; a model available only through the Responses
API is not enough.

## 1. Create an OpenAI project key

1. Open the [API billing overview](https://platform.openai.com/settings/organization/billing/overview)
   and add a payment method or credits if the organization has none.
2. Select or create the project you want Luma usage to belong to.
3. Open [API keys](https://platform.openai.com/api-keys) and create a new secret
   key dedicated to Luma, for example `Luma Cosmos`.
4. Copy the secret when OpenAI shows it. The
   [API authentication guide](https://developers.openai.com/api/reference/overview#authentication)
   recommends keeping keys on a server and out of browsers and apps; that is
   how Luma uses it.

If your organization supports project budgets and usage limits, set them now.
Do not put the key in a shell command or on the Pin.

## 2. Enter the connection in Center

1. Open `https://YOUR_DOMAIN` and sign in as the operator.
2. Open **Settings → Assistant & voice**, then expand **Assistant**.
3. Set **Provider** to **OpenAI-compatible API**.

   **You see:** **API base URL**, **API key**, **Model**,
   **Reasoning effort**, and **Maximum response tokens**.

4. Enter:

   | Center field | Value |
   | --- | --- |
   | **API base URL** | `https://api.openai.com/v1` |
   | **API key** | Your new project key |
   | **Model** | `gpt-5.6-luna` |
   | **Reasoning effort** | **Provider default** to begin with |
   | **Maximum response tokens** | `512` to begin with |

5. Choose **Save changes**.

   **You see:** `Settings saved. Your next request will use them.` The key
   field is cleared and says `Saved. Leave blank to keep it`; this is expected
   because Center never returns stored secrets to the browser.

The OpenAI model catalog currently documents `none`, `low`, `medium`, `high`,
`xhigh`, and `max` for GPT-5.6 Luna. Luma's compatible-provider menu offers
Provider default, Minimal, Low, Medium, High, and Extra high. Start with
**Provider default** or **Low**; do not choose a value that the selected model
does not accept. Center accepts a response limit from 64 through 8,192 tokens.

## 3. Verify the connection

Choose **Test** in the Assistant card. Test first saves the visible draft, then
sends a real request containing a tiny image and asks the model to reply `OK`.

**You see:** **Working** and `Assistant and photo understanding are working.`

This proves authentication, model access, Chat Completions, and vision. It does
not prove Azure Speech or any optional search, maps, weather, or music service.
Once speech is ready, ask the Pin a simple question and a device question such
as its battery level.

## Costs and limits

**Checked October 2026.** OpenAI lists GPT-5.6 Luna at **$0.20 per million
input tokens**, **$0.02 per million cached input tokens**, and **$1.20 per
million output tokens**. Inputs over 272,000 tokens have higher long-context
rates, although Luma's bounded voice turns normally stay far below that. Check
the [current model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
before relying on these prices.

The model page lists no free API tier for GPT-5.6 Luna. Rate limits depend on
the API organization's usage tier; at the time checked, Tier 1 is 500 requests
per minute and 500,000 tokens per minute. Your project's **Limits** and
**Usage** pages are authoritative. One wearer request may use more than one
model step, and photo inputs are billed as input tokens.

These API charges are separate from ChatGPT Plus, Pro, Business, or Enterprise.
If you want Luma to consume an eligible ChatGPT/Codex allowance instead, use
the [Codex subscription guide](codex-subscription.md), not an API key.

## What Luma sends

Cosmos sends HTTPS Bearer requests to
`https://api.openai.com/v1/chat/completions`. A request can contain:

- Luma's system instructions, the wearer's request, and bounded conversation
  context;
- relevant wearer memory and authenticated device context, wrapped as data;
- tool definitions, calls, and returned observations;
- the selected model, `max_tokens`, and optional `reasoning.effort`;
- low-detail images for camera requests, the Assistant test, and photo
  understanding. Cosmos also sends uploaded capture thumbnails for background
  captioning so Center can find visible subjects.

The API key stays in Cosmos's owner-only server state. It is never sent to the
Pin, and Center stores no copy. Luma does not set `store: true` and does not use
OpenAI's Conversations, Threads, or Assistants storage APIs.

OpenAI says API inputs and outputs are not used to train its models unless the
customer explicitly opts in. Its default abuse-monitoring logs may retain
customer content for up to 30 days; eligible organizations can apply for
Modified Abuse Monitoring or Zero Data Retention. See OpenAI's
[API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint)
and Luma's [App privacy](../../docs/privacy.md).

## Troubleshooting

<details>
<summary><strong>Test reports a bad credential or settings</strong></summary>

Confirm the URL is exactly `https://api.openai.com/v1`, the key belongs to the
project with billing enabled, and the model is available to that project. A
ChatGPT subscription alone does not enable API billing.

</details>

<details>
<summary><strong>The model ID starts with <code>openai/</code></strong></summary>

That prefix is OpenRouter's model namespace. For the direct OpenAI endpoint,
use `gpt-5.6-luna`, not `openai/gpt-5.6-luna`.

</details>

<details>
<summary><strong>Test fails although a text request works</strong></summary>

The test checks photo understanding too. Use a model that accepts image input
through Chat Completions. Also make sure a project or organization policy has
not blocked that model.

</details>

<details>
<summary><strong>OpenAI rejects the reasoning setting</strong></summary>

Select **Provider default**. Different model generations accept different
efforts, and Luma omits the reasoning object entirely at Provider default.

</details>

<details>
<summary><strong>Requests return rate-limit or quota errors</strong></summary>

Check both the project's usage limit and the organization's billing balance.
OpenAI rate limits and billing quota are separate controls. A model-led tool
request can require multiple calls even though the wearer asked once.

</details>

## Rotate or remove the key

Create a replacement key in the same OpenAI project, paste it into **API key**
in Center, choose **Test**, and then revoke the old key in the API Platform.
OpenAI says key revocations normally take effect within seconds.

To remove it, choose **Remove** beside the Center key field and then
**Save changes**, or select another Assistant provider and save. Emptying a
newly typed value is not the same as removing the stored key; use **Remove**.
No Pin restart or re-provisioning is required.
