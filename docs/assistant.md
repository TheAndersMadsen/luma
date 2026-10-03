# The assistant runtime

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Cosmos uses one bounded foreground agent for the whole Pin, not a separate
general agent for music. Each request follows the smallest lane that can finish
it:

| Lane | Used for | Model evidence |
| --- | --- | --- |
| D1 | Closed device prerequisites and already-grounded actions, such as asking the Pin for its location before local weather | No model call is credited |
| A1 | One semantic task, direct answer, clarification, or one server lookup | Exact model provenance, step count, and terminal state are recorded |
| A2 | A compound request with multiple tool operations | The bounded run upgrades from A1 only after more than one tool call |

Each call from the Pin owns one 70-second absolute deadline across context
loading, model steps, server tools, and the terminal response. Individual
model steps remain bounded at 20 seconds. The Compatibility Layer raises the
stock client's 25-second limit per call to 90 seconds, so even a call that
spends its whole budget leaves 20 seconds for the answer to reach the Pin. The
Pin's default, stock transport makes one call per step: when the assistant
needs something from the Pin, such as its location before local weather, the
call ends with that request, and the Pin's answer arrives in a new call with
its own deadline. The stock ceiling of eight actions per request bounds how
many such steps one request can take. The stock Pin suppresses a superseded
run's actions. On the legacy transport its old RPC can remain open until
completion or deadline; an actual response disconnect drops the unheard
Cosmos wait. Bidirectional re-entry cancels the pending server step, while
an inbound half-close alone still allows its response. No detached Cosmos
agent continues after the foreground turn.

Tool results, saved wearer facts, and authenticated device context enter the
model as typed, untrusted data rather than system instructions. Missing data
produces one short clarifying question. Consequential actions such as placing
a call require an exact, scoped confirmation, and changing the action or its
arguments invalidates that confirmation. Reversible playback and volume
controls do not gain that extra confirmation step.

Both assistant transports check the account's location preference before
building model context. With Location access off, automatic nearby and local
weather requests return a short explanation before any GPS or provider call;
named places remain usable. Unreadable privacy state fails closed; new accounts
use stock defaults.
Opt-in diagnostics save only the latest content-free outcome within the same
turn deadline; no work continues in the background to save them.

Explicit one-off requests such as `translate "hello" to Polish` preserve the
source text's case and punctuation. On the Pin, the assistant issues the stock
`Translate` action; in Center, Cosmos performs the same translation directly.
After a successful result, Cosmos saves one language-pair history entry for the
wearer before returning success. This Center route and one-off history are
Luma extensions; the stock live-translation history shape is kept.

The optional OS3 tool follows the same bounded run without turning Cosmos into
a background worker. An unlocked wearer's explicit "ask OS3", "tell OS3", or
"using OS3" request reaches it as the argument-free first tool call without a
model step; a request about the wearer's other devices that does not name OS3
can reach the same first-step call when the model chooses it from the tool's
description. OS3 receives that wearer-authored request, with whitespace
normalized for its text protocol and cut to 2,000 characters, rather than text
written by the model or another tool. Cosmos closes
the connection within the Pin turn and seals any unfinished-work reference for
a later wearer follow-up. Permissions and confirmations stay in OS3, and a
pending result is never presented as complete.
Natural status and stop shortcuts use the wearer's retained task only while
the last conversation turn was not about something else: it was OS3, or no
earlier turn is available, as in Center's assistant. Status checks are
read-only and wait at most 10 seconds within the existing absolute turn
deadline; a local "yes" never
approves Rabbit permissions. See [OS3](services.md#os3-rabbit) for follow-up and stop commands.
Exact owner-authored OS3 stop commands first yield only that account's current
local OS3 wait, then resume its durable checkpoint to request the remote stop.
Stopping speech or the Cosmos wait is separate from stopping Rabbit's accepted
work; only a correlated canceled worker confirms the latter. These session
and cancellation policies are Luma extensions. Both transports use
the stock interstitial followed by one terminal `Respond` for Luma speech;
the legacy client buffers final actions until RPC completion, so this is not
streamed progress narration (`SynapseInterpreter.interpretLegacy`,
`LoadingMessageManager.onIntermediateAction`, `RespondActionHandler.handleAction`).

Music discovery is one specialist tool. For a ranked or subjective request
such as "play Dr. Dre's most popular song", the assistant makes one research
lookup (the connected answer engine, otherwise web search) and takes one exact
title and artist from it. For playback, `music_discover` checks that recording
against the active provider, and only an exact provider match becomes a stock
`PlayMusic` action, sent without another model call. If the provider has no
exact match and the same research named a different recording, the assistant
tries that one once while time allows; it never repeats the research. The
provider's own search order never counts as a ranking: unclear evidence or no
exact match ends in a short spoken answer instead of a guess. When the
provider is not linked or is turned off, or the Pin is not paired, the
assistant says which to fix in Center rather than reporting an outage. A
request for one of your playlists by name uses the stock `PlayMusic` playlist
field.
Navigation requests first obtain the Pin's current location, then use the
configured places and directions backends to return bounded, spoken route
guidance; the recovered stock System Navigation app has no dispatchable action
for a continuous turn-by-turn session, so Cosmos reports directions without
claiming that live navigation has started. Walking, driving, cycling, and public
transit are supported ("give me transit directions to Nyhavn"). A transit route
is spoken one walk and one ride at a time: the line, its direction, where and
when to board, and the stop to get off at. Transit uses the same Maps key and
Routes API, and covers the cities Google has transit schedules for.

After deployment, run the fixed production evaluation from the extracted
operator release:

```sh
./luma eval assistant production --repeat 2
```

It exercises direct reasoning, fresh web search, compound multi-tool work, and
consequential-action confirmation through the real production Engine. Every
case must correlate its returned actions with the expected model or
deterministic run, exact stock arguments, terminal state, and Pin deadline.
A case waiting on owner setup reads `BLOCKED` rather than `FAIL`: a
ranked-playback case while the assistant correctly asks you to link or turn on
a music provider, or pair the Pin, and an OS3 case while the deployment reports
OS3 as not set up; its line names that step. The command exits non-zero only
when a case fails.
To rerun one failed case without repeating the whole matrix, pass its reported
ID with `--case ID`.

