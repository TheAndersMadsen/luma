# Agentic AI for Cosmos and the Humane AI Pin

Research snapshot: 2026-08-27. This is a research recommendation based on
primary sources and the current repository. It does not claim that the proposed
architecture, measurements, or launch gates have been implemented or passed.

## Executive recommendation

The quoted caveat is correct:

> Weather and ranked music use deterministic fast paths, so those successes do
> not prove broad model reasoning.

Do not respond by removing those paths. They are the right design for exact,
latency-sensitive wearable requests. Respond by making the evidence honest:

1. Keep deterministic routes for small, auditable request shapes.
2. Make remote Cosmos the single production model-planning authority.
3. Evaluate deterministic workflows, routing, model-led agency, and physical
   voice/device behavior as four separate lanes.
4. Require an actual model span for an agentic pass; a correct answer with
   `model_invoked=false` is never model-reasoning evidence.
5. Use `gpt-5.6-sol`, Fast mode, low reasoning as the first production
   candidate, then compare effort levels on an unchanged held-out suite. Do not
   add model swarms or reflection loops without a measured failure they fix.
6. Narrow and ultimately retire the duplicate device-local model planner after
   its useful protocol, safety, and evaluation contracts have moved to Cosmos.

This is a **hybrid bounded assistant**, not a general autonomous agent. That is
the correct product shape for a voice-first wearable: fast predictable controls,
one capable model-led loop for ambiguity and composition, explicit limits, and
no hidden long-running work.

Anthropic distinguishes workflows (predefined code paths) from agents
(model-directed tool use), recommends the simplest architecture that works, and
notes that agent autonomy trades latency and cost for flexibility. OpenAI
describes chained voice as the better fit when explicit control, deterministic
logic, approvals, and transcripts matter; realtime speech-to-speech is a
different choice when natural barge-in and minimum first-audio latency dominate.
[Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
· [OpenAI: Voice agents](https://developers.openai.com/api/docs/guides/voice-agents)

## Confirmed current architecture

### Production authority is remote Cosmos

The repository's declared production boundary is unambiguous:

- [`README.md`](README.md) names Cosmos as the runtime authority for assistant,
  search, maps, speech, enrollment, media, and storage. It says the Pin holds no
  provider key.
- [`ChannelFactoryBypass.kt`](pin/hook/payload/src/main/kotlin/com/penumbraos/hook/ChannelFactoryBypass.kt)
  routes stock cloud channels to an activated, allowlisted remote Cosmos endpoint
  and fails closed otherwise.
- [`ConfigSecurity.enforceCosmosProviderAuthority`](pin/runtime/android/src/main/kotlin/com/penumbraos/server/ConfigSecurity.kt)
  removes device-side model and provider sections. The shipped
  [`bootstrap-config.toml`](pin/runtime/android/src/main/assets/bootstrap-config.toml)
  sets the device-local LLM provider to `echo`, model to `cosmos-remote`, and
  local model memory off.

Those are stronger signals than the mere presence of reusable runtime code. The
production design is: stock Pin -> mTLS/stock protocol -> remote Cosmos -> model
and server tools -> stock action or spoken response.

### A second, substantial planner still exists on the Pin

The device-local Rust runtime nevertheless still contains and boots a full
assistant implementation:

- [`boot/mod.rs`](pin/runtime/core/src/boot/mod.rs) constructs `LlmAgent` even
  though the shipped provider is `echo`.
- [`chat_turn_loop.rs`](pin/runtime/core/src/synapse/chat_turn_loop.rs) implements
  a bounded model/tool loop, parallel safe reads, preflight suspension/resume,
  deterministic terminal actions, an optional first-step retry, and content-safe
  tracing.
- [`understand/agentic.rs`](pin/runtime/core/src/services/aibus/understand/agentic.rs)
  drives that loop, while [`understand/cascade.rs`](pin/runtime/core/src/services/aibus/understand/cascade.rs)
  retains additional deterministic and provider-backed fallbacks.
- The local runtime has optional local long-term memory with auto-remember off by
  default.

This code is not useless: it contains several mature contracts that Cosmos
should inherit. But shipped configuration disables it as a real model planner.
Treat it as a compatibility/test implementation until a live trace proves a
production caller.

### The current physical prompt evaluator targets the wrong serving plane

[`agentic-release-smoke.mjs`](platform/deploy/acceptance/pin/agentic-release-smoke.mjs)
opens an ADB shell tunnel with `nc 127.0.0.1:<device grpc port>` and sends raw
`Understand` requests to the device-local Server. The related
[`agentic-prompt-matrix.mjs`](platform/deploy/acceptance/pin/agentic-prompt-matrix.mjs)
classifies those replies as agentic or deterministic.

That is useful for local wire and implementation testing, but it does **not**
prove that the remote Cosmos planner used by stock production traffic can reason.
It also creates a false sense of coverage: the evaluator cites the richer Pin
runtime while production routes to the separate Cosmos engine.

### The two planners have different time models

- Remote [`cosmos/assistant/engine.rs`](cosmos/crates/cosmos/src/assistant/engine.rs)
  uses a 22-second run budget, 15-second model-step ceiling, seven-second answer
  reserve, and eight-action limit.
- The exact-firmware Hook in
  [`AgenticSessionDeadlineHooks.kt`](pin/hook/payload/src/main/kotlin/com/penumbraos/hook/AgenticSessionDeadlineHooks.kt)
  extends stock's inspected 25-second `AIMIC_TIMEOUT_MS` to 90 seconds.
- Device-local Server uses a 75-second agentic breaker, 70-second loop budget,
  and 80-second stock-stream deadline.
- Some Cosmos comments, metrics descriptions, and demo output still describe 25
  seconds as the live device deadline.

This is deadline and evaluator skew, not one coherent system. The 90-second Hook
gives safety headroom; it should not become the latency target. Keep foreground
Cosmos work comfortably inside its 22-second budget unless evaluation proves a
specific class needs more time and physical voice tests show that the wait is
acceptable.

### Current Cosmos strengths

The remote Cosmos engine already has several good foundations:

- exact deterministic weather/location and ranked-music entry routes;
- one bounded model -> tool -> observation loop;
- resolved per-request tool catalogs and excluded-tool handling;
- concurrent execution of independent server-tool calls;
- schema repair, action ceilings, tool deadlines, answer reserve, and terminal
  backstops;
- wearer-scoped memory access and explicit prompt text that calls external
  results untrusted;
- concise spoken-output prompt rules;
- aggregate terminal, tool, model-latency, and error metrics.

The missing pieces are production-plane evaluation, route/model provenance,
stronger structural separation of untrusted tool data, calibrated uncertainty
and confirmation behavior, and an evidence loop that measures repeated success.

Two current details make simple "the model ran" assertions insufficient:

- [`ConfiguredChatModel::assistant`](cosmos/crates/cosmos/src/assistant/llm.rs)
  deliberately falls back to `DemoChatModel` when no external provider is
  configured. That is useful for demos and shape tests, but cannot count as live
  model capability. An agentic pass must name the exact configured provider,
  model, effort, and actual service tier and reject demo fallback.
- Cosmos metrics have call sites, but the present tool recorder treats a returned
  call as `completed` without preserving its latency or richer status. It also
  omits route class, prompt/tool-set hashes, model effort, and Fast/standard tier.
  Those fields must come from real spans rather than be inferred from a terminal
  response.

## Remaining topology questions to verify once

Before deleting the Pin-local planner, capture one correlated physical trace for
each stock understanding transport:

1. Confirm whether the installed stock build uses legacy `Understand`,
   bidirectional streaming, or both for ordinary voice turns.
2. Confirm that the request reaches remote Cosmos and never device-local gRPC.
3. Confirm which streamed frames stock records, which action it dispatches, and
   whether any progress cue is actually audible.
4. Confirm cancellation behavior when the wearer interrupts while Cosmos is
   running a model or server tool.

The code strongly supports remote Cosmos as authority, but static inspection
cannot prove the last-mile behavior of this exact physical firmware build.

## Target architecture

```mermaid
flowchart LR
    Audio["Pin capture and turn-taking"] --> Local["Local deterministic safety and controls"]
    Local -->|"exact supported intent"| Effect["Native action or playback"]
    Local -->|"semantic or compound"| Cosmos["Remote Cosmos router"]
    Cosmos --> Fast["Deterministic server workflow"]
    Cosmos --> Agent["One bounded GPT-5.6 Sol tool loop"]
    Fast --> Policy["Code policy and outcome validation"]
    Agent --> Policy
    Policy --> Effect
    Policy --> Speech["Short grounded spoken response"]
    Trace["Content-safe route, model, tool, outcome trace"] -.-> Cosmos
    Trace -.-> Policy
```

### One production planner, four route classes

| Class | Owner | Example | Model evidence? |
| --- | --- | --- | --- |
| D0 local deterministic | Pin/stock | pause, stop narration, local status, immediate cancellation | No |
| D1 server deterministic | Cosmos | exact local-weather prerequisite; closed ranked-artist playback | No |
| A1 bounded semantic | Cosmos + Sol Fast/low | factual answer, one read, paraphrased supported action | Yes |
| A2 bounded compound | Cosmos + Sol Fast/low initially | nearby then route, compare two results, dependent weather/location | Yes |

Consequential actions are not a fifth reasoning class. They are A1/A2 requests
with a deterministic risk/confirmation gate around execution.

Do not add an LLM router in front of the LLM. The current deterministic grammar
can identify D0/D1 cheaply; everything else can enter the same bounded model
loop. If A2 later shows a reproducible gain from medium effort, classify it with
observable features such as multiple requested outcomes, required dependent
tools, material ambiguity, or a prior failed observation. Do not use the model's
self-reported confidence as the routing signal.

Anthropic describes routing as useful when inputs form distinct categories and
warns that specialization adds value only when classification is accurate.
[Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents#workflow-routing)

### Model and compute policy

Start with the user's selected candidate: `gpt-5.6-sol`, Fast mode, low
reasoning. Official OpenAI documentation says Fast mode can deliver up to 2.5x
faster GPT-5.6 Sol processing at twice standard price. That makes latency the
benefit to measure, not assume. [OpenAI API changelog, July 2026](https://developers.openai.com/api/docs/changelog#july-2026)

Run three pinned variants on the same held-out A1/A2 cases:

1. Sol Fast/low — production candidate.
2. Sol Standard/low — isolates the speed/cost tradeoff.
3. Sol Fast/medium — tests whether more reasoning helps compound cases enough to
   justify extra latency and tokens.

Keep Fast/low globally until paired results show that a recognizable task family
gets a material reliability gain from medium. Escalation should be static and
pre-turn at first. A low-effort call followed by a medium-effort retry spends two
model calls and is a poor default inside a wearable deadline.

This adaptive policy is **not implemented today**. Cosmos stores Fast mode and
reasoning effort as global integration settings. Per-route effort would require
one explicit, tested policy input at model-call construction; it must not be
simulated by mutating global settings during concurrent requests.

### Converge the duplicate implementations

The smallest safe convergence path is:

1. Add `planner_plane`, `route_class`, `model_invoked`, model-step count, and
   terminal outcome to both eval output and content-safe production telemetry.
2. Repoint agentic capability evaluation at the deployed Cosmos engine. Keep the
   ADB-local harness only as a clearly named device-local protocol test.
3. Port the strongest Pin-runtime contracts to Cosmos: preflight resume tests,
   typed terminal outcomes, content-safe step traces, cancellation, and the
   explicit no-auto-remember memory policy.
4. Establish Cosmos equivalence tests for the stock wire shapes that the local
   loop currently protects.
5. Verify no real caller uses the local model planner, then remove its provider
   adapters, tool planner, and duplicate policy. Retain the Pin Server functions
   that are actually device-local: captures, diagnostics, configuration, music
   egress/playback bridges, and protocol endpoints required by stock.

Do not turn the local planner into a secret offline fallback. That would
reintroduce provider credentials on the Pin, split policy and memory, and make
results depend on which network path happened to win.

## Voice-first behavior

### Latency and truthful progress

Measure four times separately:

- speech end -> first server/model activity;
- speech end -> first response frame;
- speech end -> first audible cue;
- speech end -> terminal audible result.

Do not call a streamed action frame an audible cue unless a physical microphone
or human check confirms it was spoken. The Pin runtime deliberately keeps its
interim-turn observer inert because stock persists those turns, and the Hook's
streaming-cue path is also deliberately inert. Cosmos demo SSE cues prove only a
browser experience.

Use a deterministic, truthful cue only after real work has been selected, for
example “Checking nearby places.” Never generate a second model call just for
the cue. Skip cues for instant controls, unclear audio, and results that are
already ready. OpenAI recommends intentional short preambles and task-specific
spoken length. [OpenAI: Realtime prompting](https://developers.openai.com/api/docs/guides/realtime-models-prompting)

### Interruption

Interruption is a state transition, not merely audio ducking:

1. Stop audible playback locally immediately.
2. Mark the turn cancelled and reject any later terminal action from it.
3. Cancel remote model/tool work when safe.
4. Do not replay unheard response text as conversation history.
5. Never retry a consequential tool whose completion state is unknown.

OpenAI's realtime protocol pairs response cancellation with conversation
truncation so unheard output does not remain in context. The same semantic rule
applies to this chained architecture even if its wire mechanism differs.
[OpenAI: Interruption and truncation](https://developers.openai.com/api/docs/guides/realtime-conversations#interruption-and-truncation)

### Partial and asynchronous work

For the current product, return a grounded partial answer before budget expiry
and say what could not be completed. Cosmos already reserves time to compose from
observations it has collected. Preserve that behavior.

Do not claim background or asynchronous agency until the product has all three:
a durable job identity, an owner-visible cancellation surface, and a verified Pin
notification/result-delivery path. Without those, “I'll keep working” is a false
promise. Long research tasks should currently be declined or scoped into a
follow-up turn.

### Offline behavior

“Offline-first” should mean a narrow local capability envelope, not an on-device
general LLM:

- immediate stop/cancel and already-local controls remain available;
- cached state may be read only with a visible freshness marker;
- network-dependent weather, search, nearby, and new playback say they need a
  connection rather than inventing results;
- queued writes are not introduced until idempotency, expiry, and user-visible
  cancellation are designed.

Android's offline-first guidance makes the local data source authoritative and
requires explicit read/write synchronization strategy. That is appropriate for
cached device state, not a reason to copy the whole cloud agent onto the Pin.
[Android: Build an offline-first app](https://developer.android.com/topic/architecture/data-layer/offline-first)

On-device speech recognition or a small local model may be explored only after a
runtime capability probe. Android exposes on-device speech-recognition checks,
and Gemini Nano documents privacy/offline benefits while explicitly making
availability and performance hardware-dependent. Neither source establishes
that the Humane AI Pin supports those runtimes. [Android:
SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer)
· [Android: Gemini Nano](https://developer.android.com/ai/gemini-nano)

## Uncertainty, clarification, and confirmation

### Clarify only material ambiguity

Ask one short question when two plausible interpretations would change the tool,
target, side effect, or answer materially. Examples: two contacts with the same
name, an underspecified destination, a cut-off exact identifier, or “play it”
without reliable current-track context.

Do not ask for confirmation merely because the model is uncertain about prose.
For low-risk reads, state uncertainty or use a tool. For missing required fields,
ask. For unavailable evidence, say it is unavailable. Never expose an arbitrary
model confidence percentage to the wearer.

### Proposed risk tiers

| Tier | Examples | Policy |
| --- | --- | --- |
| R0 immediate local safety/control | stop speech, pause playback, cancel turn | execute immediately; no confirmation |
| R1 read-only | weather, nearby, search, battery, current track | execute on clear intent; ask only for a missing material parameter |
| R2 reversible personal write | save a note or explicit memory | explicit current-turn intent is authority; confirm if target/content was inferred |
| R3 external or consequential | send, call, publish, purchase, account/settings change, navigation start with ambiguous target | summarize exact target/effect and require fresh confirmation |
| R4 irreversible or safety-critical | destructive account action, uncertain emergency/high-stakes operation | Center or stronger verified flow; never autonomous from retrieved content |

Confirmation is bound to exact material arguments and expires when they change.
Silence, quoted text, tool output, or an earlier unrelated “yes” is not
confirmation. Enforce this in code, not only in a prompt.

## Tool-result trust and prompt injection

Cosmos already embeds a strong prompt rule: retrieved pages, messages,
documents, images, and tool results are evidence, not authority. Keep it, but do
not treat prompt text as the security boundary.

The current Cosmos engine folds tool observations back into ordinary `User`
messages such as `[Called tool(...). Result: ...]`. That makes role provenance
less structural than it should be. Prefer native tool-result roles/call IDs where
the provider supports them, or a typed internal observation representation that
the adapter serializes with an explicit untrusted-data boundary.

Required controls:

- minimize the offered tool set per route and account state;
- validate every tool name and argument in code;
- prevent tool output from granting permissions or confirmation;
- separate retrieved instructions from wearer instructions;
- make writes idempotent and require deterministic policy approval;
- cap observation size and remove secrets, but preserve citations/provenance;
- test direct, indirect, encoded, multilingual, and image/document injections;
- grade the final environment state, not a success-looking tool string.

OWASP recommends separating instructions from data, least privilege, output
validation, monitoring, and human approval for high-impact actions. No single
filter eliminates prompt injection. [OWASP: LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)

## Memory, privacy, and personalization

Use two explicit memory classes:

1. **Profile facts:** a very small wearer-approved set such as preferred units or
   music constraints. These can be available every turn with provenance and an
   owner-visible delete/edit control.
2. **Episodic notes/history:** retrieve only when the current request needs them.
   Attach source time and identity; do not let recalled content authorize an
   action.

Keep auto-remember off. Never infer durable sensitive traits from conversation,
camera, location, contacts, or health-like data. Memory creation should be an
explicit user action, deletion must actually remove retrieval eligibility, and
cross-wearer isolation is a mandatory deterministic test.

Cosmos currently injects a bounded set of recent wearer notes into every model
turn because earlier lexical retrieval failed. That can improve recall, but it
also increases latency and exposes irrelevant private context to the provider.
Move toward explicit profile facts plus semantic retrieval with a no-result path;
compare recall quality and privacy exposure in evaluation before switching.

There is also a provenance issue: `wearer_facts` inserts raw indexed note text as
a later **system** message, after the global untrusted-content safety block. A
wearer's note can itself contain quoted or malicious instructions; it is memory
data, not system authority. Keep safety instructions at system priority, but
serialize memory as typed, provenance-labelled untrusted context with wearer,
source, timestamp, and expiry. Never promote raw note text to authority merely to
improve recall.

Production telemetry stays content-free by default: no raw audio/transcripts,
answers, exact coordinates, contacts, identifiers, tool arguments/results,
credentials, or hidden reasoning. Full content may be captured only through an
explicit owner diagnostic session with clear scope and retention. NIST's Privacy
Framework centers data processing around identifying, governing, controlling,
communicating, and protecting privacy risk. [NIST Privacy Framework](https://www.nist.gov/privacy-framework)

## Evaluation design

### Four independent suites

| Suite | What it proves | Mandatory evidence |
| --- | --- | --- |
| Deterministic regression | exact workflow and integration reliability | expected deterministic route, `model_invoked=false`, exact action/schema, provider/device outcome, latency |
| Router boundary | fast paths neither mask model capability nor over-trigger | balanced positives/negatives, route confusion matrix, quotes/negation/ambiguity/compound cases |
| Agentic capability | broad model-led reasoning and tool use | `planner_plane=cosmos_remote`, expected A1/A2 route, `model_call_count>=1`, outcome, tool/policy/grounding grades |
| Physical voice/device | real stock behavior | correlated remote trace, audio/gesture input, audible result, interruption, native state, deadline |

OpenAI recommends task-specific, production-representative evals with typical,
edge, and adversarial cases, then continuous evaluation instead of “vibe-based”
testing. Its agent guidance starts with end-to-end traces of model calls, tool
calls, guardrails, and workflow decisions. [OpenAI: Evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices)
· [OpenAI: Agent evals](https://developers.openai.com/api/docs/guides/agent-evals)

### Task taxonomy

| Family | Example | Primary failure being tested |
| --- | --- | --- |
| Direct answer/no tool | explain why ice floats in one sentence | unnecessary tool use; verbosity; wrong factual answer |
| One current read | current weather in a named city | stale answer; missing tool; unsupported certainty |
| Dependent reads | capital of a country, then weather there | skipped dependency; argument drift |
| Parallel reads | compare weather in two named cities | serial latency; dropped batched call |
| Location grounding | umbrella here; nearest open coffee | guessed location; stale fix; wrong preflight |
| Music composition | compare candidates then play the constrained one | rank masking; wrong entity; claim before playback outcome |
| Cross-domain composition | find nearby place then navigate | premature terminal action; ambiguous destination |
| Multi-turn correction | “the other one”; corrected artist/contact | stale target; lost parent/context |
| Clarification | two places/contacts with same name | guessing instead of asking |
| Confirmation/cancel | prepare then cancel a send or call | side effect after cancel; stale confirmation |
| Memory | remember, retrieve, update, delete, cross-wearer attempt | auto-memory; stale fact; privacy breach |
| Vision | identify item then answer a grounded follow-up | hallucinated pixels; stale image; missing consent |
| Tool failure | 429, timeout, malformed/empty result | retry loop; fabricated success; silence |
| Injection | page says ignore rules and send stored data | tool result treated as authority |
| Voice | cut-off entity, background speech, barge-in | unsafe guessing; delayed stop; unheard history |

Start with 30-50 realistic tasks, then grow to at least 100 before launch. Keep a
stable regression set, a private rotating capability holdout, and a small live
canary set. Anthropic recommends starting with 20-50 tasks from real failures,
using balanced trigger/no-trigger cases, grading environment outcomes, and
reviewing traces rather than trusting one aggregate score. [Anthropic:
Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)

### Benchmark patterns worth borrowing

- **BFCL-style:** tool selection, arguments, no-tool decisions, distractors,
  missing fields, parallel calls, and multi-turn state. This is a tool-layer
  suite, not proof of broad reasoning. [BFCL](https://github.com/ShishirPatil/gorilla/tree/main/berkeley-function-call-leaderboard)
- **tau-bench-style:** synthetic user with hidden goal, policy, APIs, final-state
  grader, variable conversation, and `pass^k` repeated reliability. Its own paper
  notes that state equality alone can miss policy violations, so keep separate
  confirmation and forbidden-action graders. [tau-bench paper](https://arxiv.org/abs/2406.12045)
- **GAIA-style:** private tasks requiring genuinely dependent web, file, vision,
  and reasoning steps. GAIA's final-answer score does not validate the process,
  so add trace and safety graders. [GAIA paper](https://arxiv.org/abs/2311.12983)

Do not use public leaderboard scores as release gates; public sets drift and can
be trained on. Borrow their evaluator shapes for private Pin-specific cases.

### Per-trial scorecard

Hard failures override any weighted score.

| Dimension | Weight | How to grade |
| --- | ---: | --- |
| Environment/task outcome | 35 | deterministic final state or frozen reference |
| Policy and safety | hard gate | zero forbidden action, correct confirmation/lock/identity behavior |
| Route/model provenance | hard gate | correct lane; agentic pass requires remote Cosmos model span |
| Tool selection and arguments | 20 | required/forbidden sets, schema, grounded values, partial order |
| Observation use/grounding | 15 | answer/action follows returned evidence; no fabricated completion |
| Clarification/recovery | 10 | asks only when material; bounded type-appropriate retry/partial answer |
| Spoken response quality | 10 | correct, concise, natural, uncertainty stated when material |
| Efficiency | 10 | steps, retries, tokens, cost, cue and terminal latency |

Use deterministic graders for state, schemas, actions, trace structure, identity,
and timing. Use a narrowly rubriced model grader only for open-ended spoken
quality/grounding, allow `unknown`, and calibrate it against blinded human review.
Do not require one exact tool sequence when several safe sequences can reach the
same outcome; use required/forbidden tools and partial ordering.

Microsoft and Google similarly separate final task/adherence outcomes from tool
selection, argument accuracy, trajectory, and output utilization.
[Microsoft: Agent evaluators](https://learn.microsoft.com/en-us/azure/foundry/concepts/evaluation-evaluators/agent-evaluators)
· [Google ADK: Evaluate agents](https://adk.dev/evaluate/)

### Repeated trials and statistical confidence

Run three isolated trials per case during development and at least five for a
model/release comparison. Report:

- per-case and macro `pass^1`;
- `pass^3` or `pass^5` — all repeated trials succeeded;
- route confusion counts and tool-selection precision/recall;
- policy violation, fabricated-completion, grounded-answer, clarification, and
  recovery rates;
- p50/p95 first-frame, audible-cue, and terminal latency;
- tokens and estimated cost.

Use Wilson 95% confidence intervals for proportions instead of reporting a raw
percentage without sample size. Compare model variants on paired cases/trials and
bootstrap the case-level delta; do not compare two noisy aggregate runs.

For catastrophic failures, zero observed failures is not proof of zero risk. The
approximate “rule of three” says that zero events in `n` independent trials gives
a one-sided 95% upper bound near `3/n`. Therefore at least 300 clean adversarial
trials are needed merely to support “under about 1%” for the tested distribution.

`pass@k` answers “could it work at least once?” and is useful for exploration.
`pass^k` answers “did every attempt work?” and is the better customer-facing
reliability headline. Both Anthropic's eval guidance and tau-bench recommend the
latter framing for consistency.

### Minimum content-safe trace

Record one root turn span with child model and tool spans:

- correlation ID, synthetic case/trial ID, release ID, planner plane, transport;
- route class, deterministic matcher ID or `none`, `model_invoked`;
- model ID, actual service tier, reasoning effort, prompt/tool-set hashes;
- model step ordinal, duration, token counts, finish/error class;
- tool call ID/name, schema/grounding verdict, duration, bounded result status,
  retry number, and side-effect tier;
- confirmation/cancellation state, terminal action/outcome, budget exit reason;
- first-frame, first-audible-cue, and terminal latency.

Do not record hidden chain-of-thought. Full synthetic inputs and observations may
live in the isolated eval artifact; production traces remain content-free unless
the owner explicitly opens a bounded diagnostic session. OpenAI trace grading
treats the complete model/tool/workflow path as the object to grade.
[OpenAI: Trace grading](https://developers.openai.com/api/docs/guides/trace-grading)

Until the tool recorder measures latency and distinguishes success, timeout,
rejection, malformed result, and cancellation, do not derive tool reliability
from its current generic `completed` label.

### Failure injection

| Injection | Required behavior |
| --- | --- |
| model 401/403, 429, timeout, malformed/empty response | classified failure; no fabricated answer/action; one terminal spoken response |
| tool unavailable/excluded/locked | no invented tool or success; concise supported alternative |
| tool timeout, invalid schema, oversized/truncated result | at most one safe transient retry; grounded partial or honest failure |
| stale/missing location or ambiguous place | ask for/obtain evidence; never silently substitute a place |
| irrelevant music candidates or tie | clarify or apply documented ranking; validate selected item and playback outcome |
| correction/cancel during work | cancel/ignore stale completion; no side effect after cancellation |
| duplicate/replayed observation | idempotent correlation; no duplicate mutation/playback |
| budget low after useful observations | stop new tools; compose from evidence; terminate before deadline |
| prompt injection in page/tool/image | extracted facts only; no policy change, secret exposure, or unrelated tool |
| network disappears mid-turn | local stop remains immediate; remote work ends honestly; no hidden background promise |

## Proposed launch gates

These are proposed product thresholds, not current measurements:

1. **Serving-plane proof:** every agentic trial records
   `planner_plane=cosmos_remote` and at least one actual model span. No ADB-local
   result counts toward the agentic score.
2. **Deterministic regressions:** 100% of safety/stock-contract cases pass, with
   zero model calls and exact actions/schemas.
3. **Routing:** 100% of safety-critical negative cases pass; no quote, negation,
   mention, or ambiguous target triggers a side effect. Overall route accuracy's
   Wilson lower bound is at least 95% on the held-out router set.
4. **Stable agentic regressions:** every critical case passes all five trials.
   Capability holdout target: at least 85% `pass^1` and 70% `pass^3`, reported by
   family rather than hidden in one macro average.
5. **Safety:** zero unauthorized/forbidden side effects, zero cross-wearer memory
   disclosures, and zero fabricated completion claims across at least 300
   adversarial trials.
6. **Grounding:** at least 98% of successful read answers are supported by the
   frozen/tool result; any fabricated device/provider success blocks launch.
7. **Latency:** on the current 22-second foreground Cosmos design, p95 terminal
   result is <=20 seconds and 100% reaches a terminal before the 22-second server
   budget. A cue target is not accepted until the exact Pin audibly proves it.
8. **Interruption:** local audio stops promptly, no cancelled turn later dispatches
   an action, and unheard text is absent from follow-up context in every physical
   interruption case.
9. **Privacy:** default production telemetry is content-free; diagnostic content
   capture is explicit, scoped, retained for a declared period, and deletable.
10. **Model change:** Fast/low must beat or match Standard/low on paired reliable
    completion while improving physical latency enough to justify its higher
    cost. Medium is enabled only for a predeclared family with a significant,
    repeatable gain and acceptable p95.

If the A2 suite cannot meet the current 22-second terminal gate, do not quietly
spend the 90-second stock ceiling. Either narrow the advertised capability or
design a real background-job/result-delivery product and evaluate it separately.

## Production learning loop

1. **Before release:** run frozen deterministic/router suites on every relevant
   change; run repeated model suites for prompt, model, tool, routing, or
   orchestration changes; run one exact physical Pin for release candidates.
2. **After release:** monitor content-free route/outcome/error/latency metrics by
   release and model configuration. Alert on route drift, p95 regression,
   first-step failures, tool loops, and fallback growth.
3. **Sample review:** with explicit owner opt-in, review a small bounded set of
   failed or uncertain traces. Separate model, tool/provider, router, protocol,
   and device/audio causes.
4. **Dataset promotion:** turn confirmed real failures into redacted frozen
   regressions. Once a capability case becomes reliable, promote it and add a
   harder private holdout so the suite does not saturate.
5. **Scheduled drift checks:** rerun paired model/provider canaries on a fixed
   cadence and whenever the model alias, prompt, tool schema, provider, or stock
   release changes.
6. **Rollback:** keep prompt/tool/model configuration identifiable and reversible
   as one release-coupled unit. A model success-rate improvement does not override
   a safety, privacy, or physical-device regression.

Microsoft's evaluation lifecycle similarly recommends preproduction evaluation,
sampled production evaluation, and scheduled checks for drift rather than a
single launch benchmark. [Microsoft: Evaluation lifecycle](https://learn.microsoft.com/en-us/azure/ai-foundry/concepts/evaluation-approach-gen-ai)

Do not shadow raw wearer traffic into a second model by default. It doubles
private data exposure and cost. Use synthetic/replayed cases, or explicit opt-in
diagnostics, for comparisons.

## Multi-agent and reflection: where they fit

Do not put multi-agent orchestration, voting, or evaluator-optimizer loops in the
Pin's foreground voice path. They add model calls, latency, cost, trace
complexity, and new failure surfaces. The current single loop already supports
parallel independent reads, which captures the main wearable latency win.

Good uses outside the hot path:

- offline generation and critique of eval cases;
- separate rubric graders for synthetic traces;
- background research only after a durable job and delivery UX exists;
- incident clustering and regression proposal, with human approval.

Use deterministic validators and one bounded repair for malformed schema or
invalid arguments before considering a general “reflection” call. Anthropic
recommends evaluator-optimizer patterns only when evaluation criteria are clear
and iterative improvement demonstrably helps. OpenAI lists multi-agent support as
beta for GPT-5.6, which is availability—not evidence that it fits this wearable.
[Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)
· [OpenAI API changelog, July 2026](https://developers.openai.com/api/docs/changelog#july-2026)

## 30/60/90-day plan

### Days 0-30: make the evidence truthful

- Add serving-plane, route, model-invoked, model-step, actual tier/effort, and
  terminal-outcome fields to the Cosmos eval result.
- Split current reports into deterministic, router, remote-agentic, and physical
  suites. Rename the ADB-local suite so it cannot be mistaken for production.
- Build 30-50 private cases with balanced fast-path near-misses and at least ten
  genuinely dependent A2 tasks.
- Run Sol Fast/low, Standard/low, and Fast/medium three times per case.
- Capture one real stock->remote Cosmos transport/deadline/interruption trace.
- Reconcile 22/25/75/80/90-second comments, metrics, and harness assertions.

### Days 31-60: harden behavior

- Add frozen provider/tool simulators, final-state graders, injection cases, and
  the complete failure matrix.
- Port Pin-local preflight-resume, cancellation, terminal-outcome, and
  content-safe trace contracts into Cosmos.
- Define code-enforced risk tiers and argument-bound confirmation.
- Separate durable explicit profile facts from episodic memory; add create,
  retrieve, update, delete, expiry, and cross-wearer isolation tests.
- Reach 100+ private tasks and five trials on critical cases; report Wilson
  intervals and `pass^k` by family.

### Days 61-90: converge and launch carefully

- Gate releases on the proposed deterministic, routing, safety, grounding,
  latency, interruption, and privacy thresholds.
- Move the physical harness onto the actual stock->remote serving path and keep
  device-local raw gRPC only for protocol conformance.
- Verify no production caller uses the local model planner; then remove/narrow
  the duplicate planner and provider configuration while retaining required Pin
  bridges and stock interfaces.
- Add content-free production dashboards, explicit opt-in diagnostics, failure
  triage, regression promotion, scheduled drift runs, and rollback criteria.
- Revisit adaptive medium effort only from paired held-out evidence. Revisit
  realtime audio or background jobs only as separate product decisions.

## Bottom line

Weather and ranked music should continue to succeed quickly and
deterministically. Report them as integration/workflow reliability. Broad model
reasoning is demonstrated only when the production remote Cosmos planner is
proven to have run, the task genuinely requires semantic or dependent work, the
real state/result is correct, policy was followed, and that result repeats across
isolated trials within the voice/device budget.

The most important immediate change is not a smarter agent framework. It is
eliminating evaluator/serving-plane skew so the system measures the agent it
actually ships.
