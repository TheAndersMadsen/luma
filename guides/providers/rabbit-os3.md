# Connect Rabbit OS3

Rabbit OS3 is an optional assistant service for Luma. It lets an unlocked Pin
ask your OS3 account questions and hand work to computers you have connected
to OS3. For example, say "Ask OS3 for my Mac's battery level" or "Tell OS3 to
start the build on my Mac." Luma's required assistant and speech services work
without it, and server or Pin setup never waits for it.

This connection uses Rabbit's web session rather than a published OS3 API.
Rabbit can change that private protocol. Treat the session cookie you copy in
this guide exactly like a password.

**Rabbit account and product facts checked October 2026.** Rabbit currently
documents OS3 as available in a browser without an r1 and says to start at
`os3.rabbit.tech` with a Rabbit account. See Rabbit's
[OS3 overview](https://www.rabbit.tech/support/article/what-is-os3) and
[account guide](https://www.rabbit.tech/support/article/create-os3-account).
If Rabbit does not offer OS3 to your account, Luma cannot grant access; stop
and contact Rabbit support rather than trying a different cookie or buying a
subscription that Rabbit has not documented as required.

## What this enables

- Explicit requests beginning with phrases such as "Ask OS3", "Tell OS3", or
  "Use OS3 to" go straight to OS3 without a model-routing step in Luma.
- The assistant may also choose OS3 for a request about your other devices,
  such as "What's on my MacBook?" Name OS3 when you want to be certain.
- A later "What did OS3 find?" can check work retained for that wearer, even
  after a Cosmos restart.
- "Cancel OS3" or "Stop the OS3 task" asks Rabbit to stop the retained task.
  Stopping Luma's speech or wait alone does not stop work Rabbit already took.
- Rabbit keeps its own permissions, confirmations, and forms. Luma never
  approves them for you; open OS3 to complete them.

## Checklist

- [ ] You can sign in to a Rabbit account at
      [os3.rabbit.tech](https://os3.rabbit.tech).
- [ ] OS3 has a working model. Rabbit says OS3 uses a key you bring from a
      supported model provider, or a compatible local model; configure it
      under **OS3 → Settings → API keys**. See Rabbit's
      [BYOK guide](https://www.rabbit.tech/support/article/dlam-byok).
- [ ] For computer tasks, the computer is connected under
      **OS3 → Settings → Rabbit agents**, awake, and online. A computer is not
      needed for ordinary OS3 conversation.
- [ ] You can sign in to Center as the operator. Only the operator can see or
      change the OS3 connection.
- [ ] You are using current Chrome, Edge, or Firefox on a computer, so you can
      inspect the Rabbit request headers.

## Set up OS3

1. Open [os3.rabbit.tech](https://os3.rabbit.tech) and sign in with your Rabbit
   account. If you do not have one, follow Rabbit's current
   [account-creation guide](https://www.rabbit.tech/support/article/create-os3-account).

   You see: the OS3 workspace for your account. If your account cannot reach
   it, stop here; Luma needs a working OS3 web session and has no separate
   sign-up or access path.

2. In OS3, open **Settings → API keys**. Register a supported provider key and
   assign a model. Rabbit's supported providers and model rules can change, so
   use the list OS3 shows rather than a list copied elsewhere. Rabbit's
   [BYOK instructions](https://www.rabbit.tech/support/article/dlam-byok)
   explain the current choices.

   You see: the credential as configured with a model assigned. OS3 refuses
   requests until a model is assigned.

3. Optional: to let OS3 work on a computer, open
   **OS3 → Settings → Rabbit agents**, choose **Register rabbit agent**, and
   run the platform-specific command Rabbit gives you on that computer. Keep
   the computer awake and online. Rabbit's
   [computer setup guide](https://www.rabbit.tech/support/article/rabbit-agent)
   covers registration, naming, defaults, and removal.

   You see: the computer in OS3's Rabbit agents list. Rabbit calls a connected
   computer a node.

4. Still signed in to OS3, open the browser developer tools: press **F12**, or
   **Option-Command-I** on macOS. Choose **Network**, reload OS3, and select any
   request to `os3.rabbit.tech`. Under **Request Headers**, copy the whole
   value of **Cookie**.

   You see: one Cookie value, often containing several name-value pairs
   separated by semicolons. Copy the value only, not the `Cookie:` label.

   > [!WARNING]
   > This is your complete Rabbit web sign-in. Do not paste it into a command,
   > chat, issue, screenshot, or log. Paste it only into Center's password-style
   > field in the next step.

5. In Center, open **Settings → Assistant & voice**, expand
   **OS3 (Rabbit)**, turn on **Use OS3**, and paste the value into
   **OS3 session cookie**.

   You see: **Test OS3** becomes available. The cookie field is write-only;
   after it is saved, Center says **Saved. Leave blank to keep it** and never
   shows the value again.

6. Choose **Test OS3**. Testing also saves all current changes on this page.
   Do not edit another provider's draft at the same time unless you intend to
   save it too.

   You see: **Connected**, or **Connected as NAME** when Rabbit supplies your
   agent's display name. The page also shows when the assistant last used OS3.
   If you choose **Save changes** instead, a newly saved connection says
   **Not tested** until you run the test.

## Verify the whole path

**Test OS3** checks that Rabbit accepts the saved session and that Luma can
open the OS3 conversation connection. It does not exercise the model or a
connected computer.

1. Unlock the Pin and say: **"Ask OS3 to say hello."**

   You see and hear: **Checking with OS3**, followed by OS3's reply through
   the Pin's normal answer display and speech.

2. If you connected a computer, keep it awake and say:
   **"Ask OS3 for my Mac's battery level."** Use the name OS3 shows for the
   computer if it is not your Mac.

   You see and hear: OS3's answer, or a prompt to complete a permission or
   form in OS3. Complete that prompt in OS3 itself, then ask
   **"What did OS3 find?"**

3. After a release deployment, the operator can run the repeatable production
   case from the extracted operator release:

   ```sh
   ./luma eval assistant production --case os3-task-result --repeat 2
   ```

   You see: both rounds pass. A `BLOCKED` result means the deployment reports
   OS3 as not set up; it is not model evidence. Use
   `--case os3-task-same-turn --repeat 2` when Rabbit completes the harmless
   task in the same turn.

## Costs and limits

**Checked October 2026.** Rabbit says
[OS3 itself is free](https://www.rabbit.tech/support/article/rabbitos-3).
You pay the model provider you choose according to that provider's pricing.
Rabbit also documents free-provider tiers and local models, but their
availability and limits can change; check the provider before relying on one.
See Rabbit's [API-key cost guide](https://www.rabbit.tech/support/article/api-key-cost).
Luma does not require an r1 or a Rabbit subscription for this connection, and
Rabbit's current OS3 guides do not name a paid OS3 plan. If the Rabbit account
screen says otherwise, follow the terms shown for that account.

Luma adds these boundaries:

- OS3 is available only while the Pin is unlocked.
- Luma sends at most 2,000 characters of the wearer's request and handles one
  OS3 request at a time per Luma server.
- The Pin reads at most 600 characters from each OS3 message. Center can show
  up to 1,500 characters. Use OS3 itself for longer answers and for files.
- Luma can read bounded card text, file names, and a limited number of table
  rows. It does not attach or download files, submit forms, approve
  confirmations, or answer permission cards.
- Every request remains inside Luma's foreground assistant deadline. Rabbit
  may continue work it already accepted; ask for an update later.
- Rabbit does not publish an OS3 client API. A Rabbit-side protocol change may
  break the connection until Luma is updated.

## What Luma sends

When **Use OS3** is on, Cosmos—not Center or the Pin—contacts Rabbit. It sends:

- the saved Rabbit **Cookie** header to Rabbit's sign-in and OS3 services;
- the wearer's own spoken request, with whitespace normalized and cut to
  2,000 characters;
- the OS3 conversation identifier and protocol messages needed to continue or
  check that conversation; and
- browser handshake metadata, including the OS3 web origin and this desktop
  browser User-Agent for both HTTP and WebSocket requests:

  ```text
  Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36
  ```

Rabbit's edge refuses non-browser clients before checking their sign-in.
Rabbit approved this browser User-Agent for the maintainer's Luma integration
on 2026-09-23. The OS3 client is the only Cosmos client that uses it.

Cosmos stores the cookie in its owner-only state volume, never logs it, and
never sends it to the Pin. Center keeps no copy. Cosmos seals each wearer's
retained conversation ID and unfinished-work reference in that wearer's
account so a follow-up can survive a restart. Changing the cookie starts a new
conversation rather than resuming one made with another Rabbit account.

OS3 replies are untrusted data: they cannot instruct Luma to run another tool,
approve an action, or prove that pending work has finished. Anyone who can use
this Luma deployment's assistant can reach the connected OS3 account, even
though only the operator can view its settings. Requests and replies also pass
through Rabbit and appear in the Rabbit account's OS3 conversation. Review
Rabbit's current privacy terms before connecting a sensitive computer.

## Troubleshooting

<details>
<summary><strong>Test says Sign-in expired</strong></summary>

Rabbit rejected the stored web session. Sign in to `os3.rabbit.tech` again,
copy a fresh complete **Cookie** request-header value, paste it into
**OS3 session cookie**, and choose **Test OS3**. Do not remove individual
cookie parts.

</details>

<details>
<summary><strong>Test says Blocked</strong></summary>

Rabbit's network refused the connection before OS3 checked the sign-in. This
does not prove the cookie is bad. Wait and choose **Test OS3** again. If the
browser itself cannot sign in, use Rabbit's
[login troubleshooting](https://www.rabbit.tech/support/article/fix-os3-login-issues).

</details>

<details>
<summary><strong>Test says No instance or Refused</strong></summary>

Rabbit accepted the sign-in, but its conversation service named no instance
or refused the socket. Wait a moment and test again. Luma can fall back to
OS3's default host when the directory names no instance, so an actual request
may still work.

</details>

<details>
<summary><strong>Test says Unreachable, Timed out, or Dropped</strong></summary>

Rabbit's sign-in, session directory, or conversation socket did not complete
normally. Check that OS3 works in the same browser, then test again. After a
dropped question, ask **"What did OS3 find?"** before repeating the task;
Luma deliberately does not resend a question when it cannot tell whether
Rabbit accepted it.

</details>

<details>
<summary><strong>Test connects, but OS3 refuses requests</strong></summary>

The connection test does not test a model. In OS3, open
**Settings → API keys**, check the credential, and assign a model. Follow
Rabbit's [BYOK guide](https://www.rabbit.tech/support/article/dlam-byok).

</details>

<details>
<summary><strong>Conversation works, but the computer does not respond</strong></summary>

The connection test does not test Rabbit agent. In OS3, open
**Settings → Rabbit agents** and check that the intended computer is paired,
awake, online, and selected as the default or named in the request. Follow
Rabbit's [computer setup guide](https://www.rabbit.tech/support/article/rabbit-agent).

</details>

<details>
<summary><strong>The Pin says OS3 is busy</strong></summary>

Another request holds this Luma server's single OS3 conversation slot and too
little time remains to wait. Ask again later. An explicit **"Cancel OS3"**
from the same account can end Luma's earlier wait quickly, but only Rabbit's
confirmation proves its remote worker stopped.

</details>

## Rotate or remove the connection

To rotate an expired or exposed session:

1. Sign out of Rabbit sessions you no longer trust, then sign in to OS3 again.
2. Copy the fresh complete **Cookie** request-header value.
3. In Center, open **Settings → Assistant & voice → OS3 (Rabbit)**, paste it
   into **OS3 session cookie**, and choose **Test OS3**.

You see: **Connected** or **Connected as NAME**. Replacing the cookie clears
the old connection result and prevents Luma from resuming the prior cookie's
conversation.

To disconnect OS3 from Luma, turn off **Use OS3**, choose **Remove** beside
**OS3 session cookie**, then choose **Save changes**. The field says
**Will be removed when saved** before the save. Turning the switch off without
choosing **Remove** disables use but keeps the cookie stored for later.

To remove a computer as well, delete it under
**OS3 → Settings → Rabbit agents** and uninstall Rabbit agent from that
computer using Rabbit's instructions. Removing the Luma cookie does not
unpair Rabbit's agent or delete data held by Rabbit.
