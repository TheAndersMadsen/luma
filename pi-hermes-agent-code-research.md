# Pi and Hermes Agent: lessons for Cosmos music discovery

Research snapshot: 2026-08-28. This report uses the following upstream revisions:

- Pi (`badlogic/pi-mono`): [`4e494929998d6bc4fccf75e0a233f727db4b70ee`](https://github.com/badlogic/pi-mono/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee)
- Hermes Agent (`NousResearch/hermes-agent`): [`48d25280669f645550c86b7540c01996f611be63`](https://github.com/NousResearch/hermes-agent/tree/48d25280669f645550c86b7540c01996f611be63)

The conclusion is not to transplant either agent. Cosmos should remain a small, stock-compatible voice runtime with a bounded specialist loop. The current direction—model interprets the request, `music_discover` researches it, Center verifies an exact item against the active provider, Cosmos emits deterministic `PlayMusic`—is sound. It needs a stronger *bounded discovery-and-verification loop inside the music tool*, not a general-purpose open-ended agent loop.

## Executive verdict

A single model-selected `music_discover` tool call is agentic enough. “Agentic” does not mean “must call several tools”; it means the model converts an open-ended goal into a typed action, observes grounded results, and acts subject to constraints. Pi’s core loop is exactly model response → validated tool execution → observation → another model turn only when needed ([agent-loop.ts L155-L275](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L155-L275)). Pi also explicitly supports terminating a tool batch without the automatic follow-up model call when all results declare termination ([agent-loop.ts L408-L425](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L408-L425), [agent-loop.ts L582-L584](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L582-L584)). Cosmos’s direct `music_discover` → `PlayMusic` termination applies the same useful principle to a 22-second voice turn.

At the start of this work, discovery was not a sufficient research loop for claims such as “most controversial.” It asked Perplexity for up to three candidates, discarded source evidence and confidence, then checked only the first candidate against the active provider. If evidence was divided, the code could not know; if candidate one was absent or spelled differently at the provider, it never tried candidates two and three. Provider search remains explicitly `not_ranked`, so it can prove availability but cannot prove cultural rank ([routeSupport.ts L139-L173](./center/src/app/api/internal/music/query/routeSupport.ts#L139-L173)). The implementation accompanying this report closes those gaps with bounded evidence, conditional corroboration, and ordered exact-provider fallback.

The implemented direction is therefore:

1. Keep one outer GPT-5.6 Sol Fast/low turn for semantic intent and tool selection.
2. Turn `music_discover` into a capped evidence loop with at most one initial research request and one conditional corroboration request.
3. Try up to three research candidates against the active provider, under one shared deadline.
4. On a confident exact match, dispatch `PlayMusic` deterministically with no second GPT call.
5. On disagreement, timeout, or no exact provider match, return a precise spoken failure; never guess and never play the provider’s merely first search result.

## What Pi actually does

### Loop and tool execution

Pi’s core is deliberately small. Each iteration streams one assistant response, validates and executes any tool calls, appends ordered tool results, then repeats only if tool calls or queued steering remain ([agent-loop.ts L155-L275](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L155-L275)). The LLM-facing context is rebuilt at the call boundary from the system prompt, converted messages, and current tools ([agent-loop.ts L281-L312](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L281-L312)).

Tool arguments are schema-validated before execution. A `beforeToolCall` hook may block a call, and abort is checked before execution ([agent-loop.ts L600-L659](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L600-L659)). Multiple independent calls can execute in parallel, but results are added in model-source order; a tool can force sequential execution ([agent-loop.ts L411-L425](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L411-L425), [agent-loop.ts L489-L553](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L489-L553)). This is a good model for independent provider-candidate checks, but music stages themselves are dependent and must remain ordered: discover first, provider-match second, play third.

Pi refuses to execute tool arguments from a response cut off by the output limit, returning an error observation so the model may safely reissue the call ([agent-loop.ts L374-L405](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts#L374-L405)). Cosmos should adopt the principle: malformed or incomplete discovery output is `invalid_result`, never a partially trusted title.

### Compaction, memory, skills, subagents, background work

Pi coding-agent compacts older messages while preserving the full session tree/JSONL; it explicitly calls compaction lossy ([coding-agent README L273-L281](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/README.md#L273-L281)). The generic agent exposes `transformContext` rather than imposing a memory design ([types.ts L149-L200](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts#L149-L200)). Skills are recursively discovered `SKILL.md` packages and loaded as instructions on demand ([skills.ts L37-L75](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/harness/skills.ts#L37-L75)).

Pi intentionally has no built-in subagents, permission popups, or background shell; these are left to extensions or external process tools ([coding-agent README L495-L511](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/README.md#L495-L511)). This restraint fits the Pin. Foreground music lookup does not need skills, long-term memory, a subagent, or background work.

Pi AI does expose provider-deferred request handles that an application must explicitly fetch or cancel, but that is a transport primitive rather than automatic background-agent orchestration ([types.ts L313-L321](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts#L313-L321), [models.ts L706-L732](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/models.ts#L706-L732)). It could support an explicitly deferred, non-playback research request later; it must not hide foreground playback work after the Pin turn has ended.

### Security, telemetry, evals, and failures

Pi’s generic hook surface is useful but is not a complete security boundary. The coding agent itself states that it runs with broad permissions and recommends isolation or custom confirmation flows ([coding-agent README L495-L509](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/README.md#L495-L509)). It separately asks whether project-local executable resources are trusted ([coding-agent README L296-L308](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/README.md#L296-L308)). Cosmos should copy typed allowlists and pre-execution gates, not Pi’s default authority.

The Pi harness schema defines structured spans for turns, retries, tools, compaction, hooks, and event delivery without requiring transcript text ([telemetry-schema.md L183-L265](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/docs/telemetry-schema.md#L183-L265)). The ambitious durable `AgentHarness` itself is still scaffolded at this revision—major run/restore methods return `HarnessNotImplemented`—so its design document must not be presented as shipped crash recovery ([agent-harness.ts L347-L451](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/harness/agent-harness.ts#L347-L451)). The separate eval package does run model-backed comparisons across prompts, tools, skills, and models, reporting correctness separately from latency, tokens, and cost ([evals README L1-L5](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/evals/README.md#L1-L5), [evals README L104-L150](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/evals/README.md#L104-L150)). That separation should be copied into Cosmos acceptance tests.

Pi’s provider retry helper retries only transport failures, 408/409/429, and 5xx responses; waits are abortable and server-requested delays are capped ([provider-retry.ts L22-L67](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/provider-retry.ts#L22-L67), [provider-retry.ts L97-L124](https://github.com/badlogic/pi-mono/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/provider-retry.ts#L97-L124)). Cosmos needs a much smaller cap because a server-suggested retry delay can consume the entire voice turn.

## What Hermes Agent actually does

### Loop and tool execution

Hermes is a broad synchronous orchestration engine: prompt construction, provider selection, retries/fallbacks, tool dispatch, compression, persistence, memory, and platform callbacks all meet in `AIAgent` ([architecture.md L190-L224](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/developer-guide/architecture.md#L190-L224)). Its source loop is bounded by both `max_iterations` and a shared `IterationBudget`, checks interrupts between iterations, and can inject a wrap-up nudge when 80% of a wall-clock run budget is spent ([conversation_loop.py L2018-L2068](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/conversation_loop.py#L2018-L2068), [conversation_loop.py L2155-L2162](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/conversation_loop.py#L2155-L2162)). But `AIAgent` itself defaults `max_iterations` to effectively unlimited, and the wall-clock budget shown here is a soft wrap-up instruction rather than Cosmos’s required hard ingress deadline ([run_agent.py L444-L516](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/run_agent.py#L444-L516)). Copy the budget awareness, then strengthen it for Cosmos: one enforced absolute deadline shared by every stage, plus a reserved settlement margin.

Hermes validates tool names and JSON arguments, repairs narrow model mistakes, returns tool errors for recoverable faults, and refuses truncated arguments ([conversation_loop.py L7041-L7250](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/conversation_loop.py#L7041-L7250)). It persists the assistant tool-call row before running tool side effects and fails closed if persistence fails ([conversation_loop.py L7405-L7439](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/conversation_loop.py#L7405-L7439)). Cosmos should use the same ordering for a playback action: reserve/stamp the action id before dispatch and deduplicate retries.

Hermes supports segmented execution: parallel-safe calls may run concurrently, but interactive/stateful calls remain sequential ([run_agent.py L8417-L8459](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/run_agent.py#L8417-L8459), [tool_executor.py L2864-L2906](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/tool_executor.py#L2864-L2906)). For music, candidate provider lookups may be parallel only if the provider adapter can preserve priority and cancel losers safely; playback itself must be a single sequential terminal effect.

### Compaction, memory, skills, subagents, background work

Hermes compacts in-loop at a configurable threshold, preserves recent messages and tool-call/result pairs, and keeps archived content searchable ([agent-loop.md L199-L219](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/developer-guide/agent-loop.md#L199-L219)). Its current default in-place mode soft-archives pre-compaction turns under the same session id rather than deleting them ([context-compression-and-caching.md L126-L135](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/developer-guide/context-compression-and-caching.md#L126-L135)). It has an actual compaction recall eval that asks questions about the removed region and reports recall versus retained tokens ([evals/compaction README L1-L15](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/evals/compaction/README.md#L1-L15)).

Hermes’s curated persistent memory is bounded and frozen into the system prompt at session start; session search remains on-demand over SQLite/FTS5 ([memory.md L7-L33](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/user-guide/features/memory.md#L7-L33), [memory.md L185-L211](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/user-guide/features/memory.md#L185-L211)). Memory sync/prefetch is queued onto a serialized background worker and preserves the caller’s profile context ([memory_manager.py L772-L846](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/memory_manager.py#L772-L846)). None of this belongs in a 22-second lookup; musical preferences can be a separate explicit personalization feature later.

Hermes progressively discloses skill bodies and excludes support folders from top-level skill discovery ([skill_utils.py L47-L51](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/skill_utils.py#L47-L51), [skill_utils.py L103-L149](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/skill_utils.py#L103-L149)). Its `delegate_task` launches isolated subagents and may fan them out concurrently, but the child hard timeout is off by default ([delegate_tool.py L931-L959](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/tools/delegate_tool.py#L931-L959), [delegate_tool.py L3963-L4040](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/tools/delegate_tool.py#L3963-L4040)). That is appropriate for workstation research, not foreground Pin audio.

### Confirmations, telemetry, evals, and failures

Hermes has defense-in-depth authorization, dangerous-command approval, file guards, isolation, credential filtering, cross-session separation, and input validation ([security.md L11-L40](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/user-guide/security.md#L11-L40)). Its own security policy is clear that approval heuristics are not a containment boundary; hostile workloads require OS-level isolation ([SECURITY.md L58-L153](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/SECURITY.md#L58-L153)). It also serializes approval gates and bounds approval waits to stop a dead human-interaction channel from parking the rest of a tool batch ([tool_executor.py L448-L522](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/tool_executor.py#L448-L522)). Playback lookup is a reversible, low-risk read plus media action and should not prompt; Cosmos should instead keep a closed music-only toolset, owner/principal binding, internal authentication, strict response schemas, size caps, and a provider allowlist.

Hermes exposes per-step/tool/status callbacks for platform progress ([agent-loop.md L163-L177](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/website/docs/developer-guide/agent-loop.md#L163-L177)). Its monitoring event path is explicitly content-free and failure-isolated ([events.py L1-L79](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/monitoring/events.py#L1-L79), [emitter.py L1-L20](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/monitoring/emitter.py#L1-L20)), a particularly good match for Cosmos privacy metrics. Hermes also frames web/tool output as untrusted data rather than instructions ([tool_dispatch_helpers.py L771-L821](https://github.com/NousResearch/hermes-agent/blob/48d25280669f645550c86b7540c01996f611be63/agent/tool_dispatch_helpers.py#L771-L821)); keep that boundary around research snippets and source metadata. Its recovery code is comprehensive—invalid tool names/JSON, partial streams, credential refresh, model failover, context compression—but much of it exists because it supports many providers and arbitrary tools. Copy the typed error taxonomy and bounded recovery, not the breadth or retry count.

## Proposed Cosmos music lookup loop

### Foreground sequence

For “Play the most controversial Drake song from 2013”:

1. **Local/cheap route gate.** The request is recognized as music selection, not a transport command. Exact transport commands—pause, resume, stop, next, previous, restart—stay device-local and deterministic. They must not wait for Cosmos or an LLM.
2. **One GPT-5.6 Sol Fast/low intent turn.** The model chooses `music_discover` with `{artist: "Drake", criterion: "most controversial", year: 2013, timeframe: "all_time", context: ...}`. This is semantic interpretation, not the cultural answer.
3. **Initial grounded research.** The discovery backend returns up to three *evidence-bearing* candidates, not bare title/artist pairs. Each candidate should include canonical title, primary artist, release year/date, short rationale, at least one source URL, source date, and a bounded support score. Reject results whose release year does not match the requested year.
4. **Conditional corroboration.** If the top candidate has weak support, the top two are close, sources conflict, or the criterion is inherently superlative (“most”), spend at most one additional narrow research call comparing only those candidates. If there is no time, return `evidence_ambiguous`; do not invent confidence.
5. **Active-provider grounding.** Only now query the wearer’s selected Spotify, YouTube Music, or TIDAL catalog. Try the candidates in research order, up to three, under one provider-stage deadline. Exact/canonical title and artist must match; album/version metadata may disambiguate clean/radio/remix/live variants. Provider order is not evidence for “most controversial.”
6. **Deterministic terminal action.** When an exact provider item is found, reserve an action id and emit one stock-compatible `PlayMusic` action. Do not ask GPT to bless the already-grounded result and do not use a second model turn merely to format the action. Cosmos already takes this direct terminal path ([engine.rs L998-L1029](./cosmos/crates/cosmos/src/assistant/engine.rs#L998-L1029)).
7. **Honest deterministic failure.** Speak a stage-specific result: “I couldn’t verify a clear answer,” “I found a likely answer, but not on YouTube Music,” or “Music lookup took too long.” Known `music_discover` failure observations should also terminate without another GPT call; otherwise the error-reporting turn can consume the remaining deadline and collapse back into “Something went wrong.”

The provider is intentionally contacted *after* cultural discovery. That ordering prevents provider search rank from masquerading as cultural evidence and matches the desired experience: first decide what the request means and what evidence supports; then find that exact recording in the wearer’s provider; then play it.

### Hard bounds for the 22-second Pin budget

Use one absolute monotonic deadline rather than independent timeouts that can sum beyond 22 seconds. Reserve the final 1.5–2 seconds for action serialization and stock-protocol delivery. A practical target is:

| Stage | Target ceiling | Rule |
|---|---:|---|
| Intent/tool selection | 3–4 s | GPT-5.6 Sol Fast/low, music-only toolset |
| Initial research | 7–8 s | one structured request |
| Conditional corroboration | 3–4 s | only if needed and at least ~7 s remain |
| Provider grounding | 4–5 s | up to three bounded candidates |
| Action settlement | 1.5–2 s reserved | never consumed by retries |

These are sub-deadlines, not guaranteed sequential allocations. Every outbound call receives the remaining absolute deadline. Permit at most one retry, and only for a transient transport/429/5xx failure when the remaining budget can still cover provider grounding and settlement. A discovery call that consumes its stage cannot trigger another full-duration call.

### Result contract

Replace bare candidates with a bounded internal contract resembling:

```json
{
  "status": "resolved | ambiguous | no_evidence",
  "criterion": "controversial",
  "candidates": [
    {
      "title": "...",
      "artist": "Drake",
      "release_year": 2013,
      "rationale": "...",
      "support": "strong | moderate | weak",
      "sources": [{"url": "https://...", "published_at": "..."}]
    }
  ]
}
```

Keep this contract Cosmos-internal. Preserve the stock `humane.*` protobuf and `PlayMusic` wire shape unchanged. Strip evidence before the device action; the Pin needs the exact provider-grounded title/artist/item identity, not research text.

## What to adopt and what to reject

Adopt:

- Pi’s minimal model → validated tool → typed observation loop.
- Pi’s early termination after an authoritative tool result.
- Hermes’s shared iteration/wall-clock budget and settlement reserve.
- Fail-closed handling of malformed/truncated tool output.
- Persist/reserve the playback action identity before the side effect; deduplicate retries.
- Parallelism only within genuinely independent candidate lookups.
- Structured stage telemetry and repeated behavioral evals.

Do not adopt:

- Hermes’s general-purpose 70+ tool surface, provider-fallback maze, autonomous skills, memory writes, background review, cron, or subagents in a foreground voice turn.
- Pi’s broad host permissions or “build your own” security posture.
- A free-running ReAct loop that can spend the whole 22 seconds searching.
- A second GPT call after an exact provider match.
- Provider search order as “viral,” “top,” or “controversial” evidence.
- Storing raw wearer utterances, discovered titles, source URLs, or personal provider identifiers in metrics.

## Telemetry and evaluation

Record only bounded labels and timings:

- route: `exact`, `subjective`, `transport`
- criterion class: `viral`, `controversial`, `historical`, `mood`, `other`
- stage outcome and latency: intent, discovery, corroboration, provider, action
- candidate count, exact-match index, disagreement flag, retry count
- provider class and final outcome
- total deadline margin at settlement

Do not record utterance text, principal, titles/artists, source URLs, tokens, or provider account identifiers. The implemented bounded music metrics and whole-run assistant metrics localize the stage, route, terminal state, model provenance, and timing without private payloads. Candidate contents and source URLs remain deliberately absent from telemetry.

Build two eval layers:

1. **Deterministic replay acceptance:** frozen research responses plus provider fixtures. Assert year/artist constraints, evidence schema, ordered candidate fallback, exact-match requirements, no autoplay for question-only prompts, one `PlayMusic`, no second model call, and every failure message.
2. **Repeated live semantic eval:** a versioned prompt set covering current superlatives, historical subjective claims, ambiguity, misspellings, unavailable tracks, remixes, multilingual phrasing, and injected text in criteria. Judge research support separately from provider grounding and latency. Run multiple repetitions because model/retrieval output varies; report pass rate and p50/p95 latency rather than a single green trace.

Required acceptance prompts should include:

- “Look up the most viral song by Drake and play it.”
- “Play the most controversial Drake song from 2013.”
- “What was Drake’s most controversial song in 2013?” (answer only; no playback)
- “Play Drake’s newest single.”
- “Play a Drake song like Passionfruit but calmer.”
- an answer supported by research but absent from each active provider
- candidate one absent but candidate two exactly present
- conflicting evidence that must use the single corroboration pass or return ambiguity

## Final recommendation

Keep Cosmos purpose-built. The implemented music path is a **bounded specialist agent**, not a miniature Pi or Hermes installation:

```text
local transport fast path
        OR
GPT intent (one turn)
  → evidence-bearing discovery (one call)
  → optional corroboration (at most one call)
  → exact active-provider match (up to three ordered candidates)
  → deterministic stock PlayMusic (one terminal action)
```

This is genuinely agentic where judgment is required and deliberately non-agentic where reliability matters. It will make the example behave as the user expects: Cosmos researches the subjective claim first, verifies an exact recording in the wearer’s selected provider only after it has a supported candidate, and starts playback only after both gates succeed. Pause/resume/stop/next/previous/restart remain local and continue to work even if Cosmos or the model provider is unavailable.
