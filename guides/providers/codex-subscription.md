# Connect a Codex subscription

> Part of the [provider setup guides](README.md). See
> [Configure services in Center](../../docs/services.md) for the full service map.

## What this enables

Luma can use Codex access included with an eligible ChatGPT plan instead of an
OpenAI API key. Cosmos runs the official `codex app-server`, asks it to start a
ChatGPT device-code sign-in, and lets that app server store and refresh the
session on your server.

This is not the OpenAI API-key path. It consumes the Codex allowance or credits
associated with the ChatGPT account you approve, not an API Platform balance.
OpenAI explains that API billing and ChatGPT billing are
[separate sign-in and billing paths](https://developers.openai.com/codex/auth).

## Checklist

- [ ] Luma is running and you can sign in to Center as the operator.
- [ ] You can sign in to the ChatGPT account whose Codex usage Luma should use.
- [ ] That account or workspace permits Codex and the model you plan to select.
- [ ] You can open OpenAI's verification page in a browser.

Luma's default for this path is `gpt-5.6-sol`, which OpenAI still lists as
available during its current model rollout. OpenAI now recommends
`gpt-6.1-sol` for complex work when the account and client have access, or
`gpt-6-luna` for focused, high-volume work. Workspace admins and staged
rollouts can restrict what appears. Check OpenAI's
[current Codex model page](https://developers.openai.com/codex/models) before
changing Luma's tested default.

## 1. Select Codex in Center

1. Open `https://YOUR_DOMAIN` and sign in as the operator.
2. Open **Settings → Assistant & voice**, then expand **Assistant**.
3. Set **Provider** to **Codex subscription**.

   **You see:** a **Connect Codex** button plus **Model**,
   **Reasoning effort**, **Speed**, and **Maximum response tokens**.

4. Set **Model** to an exact model ID your plan permits. Keep
   Luma's `gpt-5.6-sol` default initially. If OpenAI rejects it, choose an exact
   currently available ID shown in the Codex model documentation, such as
   `gpt-6.1-sol` or `gpt-6-luna` when available to the account.
5. Start with **Reasoning effort: Provider default** and
   **Speed: Standard**.
6. Leave **Maximum response tokens** at 512. Luma currently applies this field
   to OpenAI-compatible HTTP requests; the Codex app-server path is instead
   bounded by its structured output and Luma's turn deadlines.

## 2. Approve the device code

1. Choose **Connect Codex**. This selects and saves the Codex provider before
   sign-in starts.

   **You see:** `Codex is selected. Finish the sign-in shown below.` Center
   shows a verification link, a short user code, and a 15-minute countdown.

2. Open the displayed verification link. Sign in to the intended ChatGPT
   account if OpenAI asks, enter the displayed code, and approve the request.
   The browser holds the account sign-in; do not copy a password or session
   cookie into Center.
3. Return to Center. It checks status every few seconds.

   **You see:** `Codex is connected to Cosmos.` The card changes to
   **Codex connected** and, when OpenAI supplies them, shows the account email
   and plan.

The code expires after 15 minutes. If it disappears before approval finishes,
choose **Connect Codex** again to generate a new one.

## 3. Verify the connection

Choose **Test** in the Assistant card. It saves the selected model and controls,
then asks Codex to inspect a tiny test image and reply `OK`.

**You see:** **Working** and `Assistant and photo understanding are working.`

This tests the stored ChatGPT session, selected model, and image path. It does
not test Azure Speech or optional search and maps services. After speech is
connected, ask the Pin a plain question and then a device question such as its
battery level.

## Models, speed, costs, and limits

**Checked October 2026.** OpenAI includes ChatGPT Work and Codex with Free, Go,
Plus, Pro, Business, Edu, and Enterprise plans, but available models, included
allowance, rolling limits, credit rates, and reset times differ. OpenAI directs
users to the ChatGPT/Codex **Usage** dashboard for the live balance. See the
[current Codex pricing and limit guide](https://developers.openai.com/codex/pricing)
and [model availability](https://developers.openai.com/codex/models).

Luma exposes the app server's Standard and Fast service tiers. Center describes
Fast as about 1.5× faster and consuming more ChatGPT credits. OpenAI's current
pricing guide says purchased credits use 2× the Standard rate where Fast is
available, while included subscription usage has different multipliers. Use
Standard until latency matters. Higher reasoning efforts also consume more of
the allowance. One spoken request may require multiple Codex turns as Luma
runs tools, although every foreground run remains bounded.

Purchased ChatGPT usage credits are not OpenAI API credits, and API credits do
not extend this connection. If this account exhausts its Codex allowance,
Luma cannot silently fall back to a saved API key; select and save the
OpenAI-compatible provider explicitly if you want to switch.

## What Luma sends

Cosmos starts the pinned official Codex binary in its own private state and
workspace directories. For each model step it creates an ephemeral,
read-only-sandboxed Codex thread containing:

- Luma's system instructions, the wearer's request, and bounded conversation
  context;
- relevant wearer memory and authenticated device context as typed data;
- Luma tool descriptions and results, embedded in a structured prompt;
- the selected model, reasoning effort, and Standard/Fast service tier;
- low-detail images for a camera request or photo understanding.

Luma sets approval to `never`, network access to restricted in the external
sandbox, and requires a small JSON answer shape. It deletes each ephemeral
thread after consuming the answer. If a Pin turn is abandoned, Luma interrupts
the Codex turn and deletes the thread rather than letting subscription work
continue in the background.

The official app server owns ChatGPT OAuth token storage and refresh. The
tokens stay in Cosmos's state volume; Center receives only whether Codex is
available and connected, plus the plan/email metadata OpenAI returns. Nothing
is copied to the Pin. OpenAI's
[authentication documentation](https://developers.openai.com/codex/auth) says
ChatGPT sign-in follows workspace permissions and ChatGPT retention and
residency settings. Provider processing still follows OpenAI's terms and
account data controls.
See also Luma's [App privacy](../../docs/privacy.md).

## Troubleshooting

<details>
<summary><strong>The button says Codex unavailable</strong></summary>

The running Cosmos image cannot find or start the bundled Codex app server.
Verify that the deployment is a complete current Luma release, then run
`./luma verify production`. Changing the model or refreshing the browser will
not repair a missing server binary.

</details>

<details>
<summary><strong>The code expired or sign-in never completes</strong></summary>

Choose **Connect Codex** again and use the new code before its 15-minute timer
ends. Make sure you approve it under the intended ChatGPT account and return to
the same Center page so its status polling remains visible.

</details>

<details>
<summary><strong>Connected, but Test fails for the selected model</strong></summary>

The account may not be entitled to that model. Choose an ID the
[current model page](https://developers.openai.com/codex/models) lists for the
account, confirm the workspace admin permits Codex, and check the account's
Codex Usage page for an exhausted allowance. A connected session proves
identity, not model quota.

</details>

<details>
<summary><strong>Usage disappears faster than expected</strong></summary>

Return **Speed** to Standard and lower **Reasoning effort**. Luma's tool loop
can use more than one model step for a single spoken request. OpenAI notes that
usage varies with the model, context, reasoning, speed, and tools.

</details>

## Rotate, change account, or disconnect

To use a different ChatGPT account, choose **Disconnect** in the Assistant
card. **You see:** `Codex was disconnected from Cosmos.` Then choose
**Connect Codex** and approve the new device code while signed in to the new
account.

Disconnect calls the official app server's account logout and removes Cosmos's
ability to use that session. For a broader account-security response, also use
OpenAI's account security controls to sign out sessions or change credentials.
To stop using subscriptions, select **OpenAI-compatible API**, enter that
provider's URL, key, and model, test it, and save. No Pin restart or
re-provisioning is required.
