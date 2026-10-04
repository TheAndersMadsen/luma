# The assistant runtime

> Part of the [Luma docs](./README.md). See the [main README](../README.md) for the overview and quick start.


Cosmos runs one bounded foreground agent for the whole Pin. There is no
separate general agent for music. Each request takes the smallest lane that can
finish it:

| Lane | Used for | Model evidence |
| --- | --- | --- |
| D1 | Closed device prerequisites and already-grounded actions, such as asking the Pin for its location before local weather | No model call is credited |
| A1 | One semantic task, direct answer, clarification, or one server lookup | Exact model provenance, step count, and terminal state are recorded |
| A2 | A compound request with multiple tool operations | The bounded run upgrades from A1 only after more than one tool call |

## Deadlines

Each call from the Pin gets one 70-second absolute deadline. It covers context
loading, model steps, server tools, and the final response. Each model step is
limited to 20 seconds. The Compatibility Layer raises the stock client's
25-second limit per call to 90 seconds, so even a call that spends its whole
budget leaves 20 seconds for the answer to reach the Pin.

The Pin's default transport is the stock one, and it makes one call per step.
When the assistant needs something from the Pin, such as its location before
local weather, the call ends with that request. The Pin's answer arrives in a
new call with its own deadline. The stock ceiling of eight actions per request
limits how many such steps one request can take.

The stock Pin suppresses the actions of a superseded run. On the legacy
transport, the old RPC can stay open until it completes or reaches its
deadline. If the response connection actually drops, Cosmos stops the wait
whose answer no one will hear. On the bidirectional transport, re-entry cancels
the pending server step, but an inbound half-close alone still lets its
response through. No detached Cosmos agent keeps running after the foreground
turn.

## Untrusted data and confirmation

Tool results, saved wearer facts, and authenticated device context reach the
model as typed, untrusted data, not as system instructions. Missing data
produces one short clarifying question. Consequential actions such as placing a
call need an exact, scoped confirmation, and changing the action or its
arguments voids that confirmation. The action tools of an MCP server need the
same confirmation (see MCP servers). Reversible playback and volume controls do
not get the extra confirmation step.

## Location and diagnostics

Both assistant transports check the account's location preference before
building model context. With Location access off, automatic nearby and local
weather requests get a short explanation before any GPS or provider call. Named
places still work. If the privacy state cannot be read, the request fails
closed. New accounts use stock defaults.

Opt-in diagnostics save only the latest content-free outcome, within the same
turn deadline. No background work continues in order to save them.

## Translation

Explicit one-off requests such as `translate "hello" to Polish` keep the source
text's case and punctuation. On the Pin, the assistant issues the stock
`Translate` action. In Center, Cosmos performs the same translation directly.
After a successful result, Cosmos saves one language-pair history entry for the
wearer before it returns success. This Center route and the one-off history are
Luma extensions. The stock live-translation history shape is kept.

## OS3

The optional OS3 tool runs inside the same bounded run, so Cosmos never becomes
a background worker. When an unlocked wearer explicitly says "ask OS3", "tell
OS3", or "using OS3", the request reaches the tool as the argument-free first
tool call, with no model step. A request about the wearer's other devices that
does not name OS3 can reach the same first-step call when the model picks it
from the tool's description.

OS3 receives the wearer's own request, with whitespace normalized for its text
protocol and cut to 2,000 characters. It never receives text written by the
model or another tool. Cosmos closes the connection within the Pin turn and
seals any reference to unfinished work for a later follow-up from the wearer.
Permissions and confirmations stay in OS3, and a pending result is never
presented as complete.

Natural status and stop shortcuts use the wearer's retained task only when the
last conversation turn was about OS3, or when there is no earlier turn, as in
Center's assistant. Status checks are read-only and wait at most 10 seconds,
inside the existing absolute turn deadline. A local "yes" never approves Rabbit
permissions. See [OS3](services.md#os3-rabbit) for follow-up and stop commands.

An exact OS3 stop command written by the owner first makes that account's
current local OS3 wait give way, and only that one. It then resumes the durable
checkpoint to ask for the remote stop. Stopping speech or the Cosmos wait does
not stop work Rabbit has already accepted. Only a correlated canceled worker
confirms that Rabbit stopped. These session and cancellation policies are Luma
extensions.

Both transports use the stock interstitial followed by one terminal `Respond`
for Luma speech. The legacy client buffers final actions until the RPC
completes, so this is not streamed progress narration
(`SynapseInterpreter.interpretLegacy`,
`LoadingMessageManager.onIntermediateAction`,
`RespondActionHandler.handleAction`).

## MCP servers

MCP servers are an optional Luma extension, like OS3. The owner adds a server
by name and URL, with any request headers it needs (usually `Authorization`),
and the assistant is offered that server's tools beside its own while the
server is switched on. A switch takes effect on the next request. Header
values stay in Cosmos and are never shown again; editing a server without
retyping one keeps it.

- **One transport.** Cosmos speaks Streamable HTTP to remote and local servers
  alike and never launches a program. A stdio-only server runs behind an HTTP
  bridge next to Cosmos.
- **Discovery happens when the owner saves, tests or enables a server.** The
  listed tools are stored, so a turn never waits on discovery.
- **Read-only by default.** A tool is offered only when its server marks it
  `readOnlyHint`, unless the owner allows actions for that server.
- **Asks before an action.** A tool its server does not mark `readOnlyHint`
  runs only after the wearer confirms that exact call. The assistant asks one
  question that names the tool, the server and every argument, for example
  `Run add on Bookmarks, with title "Example", url "https://example.com"?`,
  and runs the call when the next reply is "yes", "yes please", "confirm" or
  "confirmed" and the model then makes the same call. Another tool, a changed
  argument, any other reply, or another request in between voids it, and the
  lock, switch and action gates are checked again when the call runs. Only the
  wearer's own reply counts: tool output and other retrieved text cannot
  confirm anything. A call that cannot be read out exactly is not run, and the
  assistant says so: the question would be longer than 200 characters, or it
  contains markup that speech would drop, or an argument name is not a plain
  word. An action called beside other tools in one step is held back until it
  is called on its own. The owner can turn off Ask before actions for a
  server, and its actions then run at once. Read-only tools and
  `manage_tool_servers` never ask. A server saved before this switch existed
  asks.
- **One switch per tool.** Each listed tool has its own switch in Center. A
  tool the owner switches off is never offered, whatever its server allows,
  and a call to it is refused. Fewer offered tools also make the model quicker
  and less likely to pick the wrong one. The choice is kept by tool name: it
  survives a new listing, and a tool the server stops listing is still off if
  it comes back. A new tool starts switched on.
- **Bounded like every server tool.** A call runs inside the turn's deadline
  and at most 15 seconds. The model reads up to 24,000 characters of its
  result in the run that called it, because it digests the result and nothing
  reads it aloud; a longer result is cut, and the model is told how much it
  got so it can ask for less. The Pin records 4,000 characters of it, since it
  sends its recorded turns back with every later request. The result reaches
  the model as untrusted data.
- **A locked Pin is offered none of them**, unless the owner turns on Use while
  locked for a server. A Pin is locked whenever it is off the body. The
  assistant is told the names of the servers that are waiting for an unlocked
  Pin, so it says "that needs an unlocked Pin" instead of "I have no such
  tool". It is told names only.
- **By voice.** While at least one server is set up, the assistant has a
  built-in `manage_tool_servers` tool that lists the servers and switches one on
  or off by name ("turn on the home tools").
- **Sign-in instead of a header.** A server that asks for an OAuth sign-in
  (the MCP authorization flow, revision 2025-06-18) shows Sign in on its card.
  When adding a server, choose "Sign in with the provider" to save it without
  headers and go straight to its sign-in.
  Cosmos finds where the server signs in, registers itself there, and sends
  your browser to the provider; when you come back it keeps the tokens in
  `mcp-oauth.json` beside `mcp.json` and renews them on its own. Center never
  sees them. If a renewal is refused, the card asks you to sign in again. This
  needs Center on an `https` address and a provider that allows dynamic client
  registration. A server with an `Authorization` header of its own keeps using
  that header.

Tools are named `mcp_<server>_<tool>`. At most 40 are offered at once, and a
tool that is switched off does not count, so switching tools off makes room
for others. Cosmos keeps the first 48 tools a server lists.
Settings live in `mcp.json` in the Cosmos state directory, separate from the
provider settings, so a release without this feature still starts.

## Music

Music discovery is one specialist tool. For a ranked or subjective request such
as "play Dr. Dre's most popular song", the assistant makes one research lookup
(the connected answer engine, otherwise web search) and takes one exact title
and artist from it. For playback, `music_discover` checks that recording
against the active provider. Only an exact provider match becomes a stock
`PlayMusic` action, and it is sent without another model call.

If the provider has no exact match and the same research named a different
recording, the assistant tries that one once while time allows. It never
repeats the research. The provider's own search order never counts as a
ranking. Unclear evidence or no exact match ends in a short spoken answer
instead of a guess.

When the provider is not linked or is turned off, or the Pin is not paired, the
assistant says which one to fix in Center instead of reporting an outage. A
request for one of your playlists by name uses the stock `PlayMusic` playlist
field.

## Navigation

Navigation requests first get the Pin's current location. Then they use the
configured places and directions backends to return bounded, spoken route
guidance. The recovered stock System Navigation app has no dispatchable action
for a continuous turn-by-turn session, so Cosmos reports directions without
claiming that live navigation has started.

Walking, driving, cycling, and public transit are supported ("give me transit
directions to Nyhavn"). A transit route is spoken one walk and one ride at a
time: the line, its direction, where and when to board, and the stop to get off
at. Transit uses the same Maps key and Routes API, and covers the cities Google
has transit schedules for.

## Evaluate in production

After deployment, run the fixed production evaluation from the extracted
operator release:

```sh
./luma eval assistant production --repeat 2
```

It tests direct reasoning, fresh web search, compound multi-tool work, and
consequential-action confirmation through the real production Engine. Every
case must match its returned actions to the expected model or deterministic
run, exact stock arguments, terminal state, and Pin deadline.

A case that is waiting on owner setup reads `BLOCKED` instead of `FAIL`, and
its line names the step to take:

- A ranked-playback case, while the assistant correctly asks you to link or
  turn on a music provider, or to pair the Pin.
- An OS3 case, while the deployment reports OS3 as not set up.

The command exits non-zero only when a case fails. To rerun one failed case
without repeating the whole matrix, pass its reported ID with `--case ID`.
