# Stock-feel architecture migration and release guide

This is the execution contract for finishing the repository cleanup without
changing the product's observed behavior. It covers source organization,
wearer-facing language, visual consistency, verification, the VPS release, and
installation on one operator-owned Ai Pin.

The work is complete only when the source, composed stack, immutable release,
deployed VPS, exact installed Pin, and physical experience are reported as
separate results. A passing source gate does not imply a successful deployment,
and a connected device does not imply physical acceptance.

## Execution rules

1. Stay on the currently selected Fable 5 model. Do not switch models. If that
   model cannot continue, stop and report the blocker.
2. Work as one agent. Do not create subagents, teams, reviewers, or delegated
   tasks. Do not invoke a skill, plugin, or workflow that chooses another model.
3. Report commands, changed files, test results, and observed behavior. Do not
   provide private internal analysis.
4. Preserve all unrelated work, especially the existing untracked `diagrams/`
   directory. Never stage, delete, move, or edit it.
5. Use the checked-in source, tests, contracts, and documentation as authority.
   Do not scan private research folders, decoded packages, firmware dumps,
   release archives, device dumps, `target/`, `build/`, or `node_modules/`.
6. Keep each change behavior-preserving unless this guide names the intended
   product change. Make small moves behind stable exports, run the nearest tests,
   and only then remove the old location.
7. Do not reset, flash, wipe, factory-reset, or improvise device recovery. Do not
   use the bootstrap-recovery install option. A normal install is authorized only
   for the exact connected owned Pin after a read-only plan succeeds.

## Definition of done

- `center/`, `cosmos/`, `pin/`, `platform/`, and `contracts/` remain the only
  product and contract boundaries at the repository root.
- Both protobuf trees remain independent. Their exact package, service, method,
  message, enum, field-number, authority, ALPN, package, certificate, setting,
  storage, and feature identifiers remain unchanged unless a checked-in fixture
  proves the coordinated migration.
- Exact stock vocabulary exists only at compatibility edges. Do not create clone
  modules named `tao`, `switchboard`, `narrator`, `central`, `intent`, or
  `experiences`; those names would falsely claim ownership of installed-device
  components.
- Large composition files become thin entry points with cohesive modules and
  tests. Public CLI commands, routes, RPC shapes, action names, feature flags,
  environment variables, release manifests, and persisted data keep working.
- Wearers no longer see or hear implementation terms, canned chatbot filler, or
  invented success. Operator diagnostics keep their exact technical detail.
- A newcomer can find architecture, setup, test, release, and recovery paths from
  the README and can run the fast source checks in CI.
- The complete validation and deployment ladder below passes, or the final report
  names the exact blocked gate without claiming later gates.

## 1. Establish the live baseline

Before editing:

```sh
git status --short --branch
./revival --help
./revival pin --help
./revival pin install --help
```

Read `README.md`, `docs/architecture.md`, `docs/operations.md`,
`docs/recovery.md`, `contracts/compatibility.json`, `contracts/features.json`,
`contracts/wire-divergence.json`, the component READMEs, and the relevant test
entry points. Record the current branch, commit, dirty paths, release pointer,
VPS target, and connected device list. Do not edit any pre-existing dirty path
until ownership is clear.

Run the narrowest existing checks for the areas about to move. Save their exact
counts and failures as the before state. A pre-existing failure stays distinct
from a regression.

## 2. Preserve the architecture and isolate compatibility

Keep this dependency direction:

```text
wearer -> Center -> Cosmos <- Pin
             |               |
             +-- owned Pin --+

platform composes, releases, deploys, and verifies
contracts records cross-component wire compatibility
```

Product code must not depend on deployment internals. Center and Pin consume
Cosmos through versioned contracts or public service interfaces. Keep stock
identifiers in small boundary modules and translate them immediately into clear
internal types. Do not rename exact compatibility identifiers for aesthetic
consistency.

Do not point `pin/runtime/core/build.rs` at `contracts/wire`. The two protobuf
trees are intentional, and `contracts/wire-divergence.json` plus the equivalence
gate defines their allowed differences.

## 3. Center

Make Next.js route files thin. Move data shaping, validation, and Cosmos access
into domain-owned modules for memories, captures, notes, contacts, services,
settings, and Pin management. Keep route URLs and response shapes stable.

Separate wearer and operator work visibly and in code:

- Wearer pages stay under ordinary routes such as `/settings` and
  `/settings/pin`.
- Operator-only device access stays under `/admin`, including the terminal.
- Keep the current route guards and negative tests for retired wearer-accessible
  terminal paths.
- Do not expose raw provider, model, RPC, package, trace, or tool details on
  wearer pages. Put those details in operator views, logs, and support bundles.

Consolidate repeated visual pieces into a small component system: page frame,
section, list row, status, field, button, dialog, empty state, and error state.
Create one token source for color, type, spacing, radii, elevation, and motion.
Move feature code in slices, retain temporary re-export files, and delete a
re-export only after all imports and tests use the new owner.

## 4. Cosmos

Keep `assistant/engine.rs` and `assistant/bidi.rs` as separate transport state
machines. Extract only the behavior they truly share into focused assistant-turn
modules. Candidates already duplicated across both files include catalog
resolution, request context and history construction, speakable-text selection,
bounded observation text, timestamps, action/observation frame construction,
and tool deadline handling.

Move one shared concept at a time. Add equivalence fixtures before each move and
run both engine and bidirectional-session tests after it. Preserve ordering,
parent links, source fields, timestamps, action budgets, interruption behavior,
terminal `Respond`, end markers, vision replay handling, and device-vs-server
execution semantics. Do not force the two transports through one state machine.

Keep server APIs, migrations, stored data, provider adapters, search, speech,
and the 22-service gRPC surface behind their current public contracts.

## 5. Pin

Turn `pin/runtime/core/src/main.rs` into a composition root. Move upload routing,
service construction, configuration loading, shutdown, and runtime supervision
into named modules while keeping startup order, ports, defaults, and errors
stable.

Keep these ownership lines clear:

- `services/aibus/` is the stock-facing RPC boundary and request orchestration.
- `synapse/` owns assistant-turn mechanics and native action translation.
- model-client code owns provider transport, never device behavior.
- native action modules own schemas, validation, feature policy, and execution.
- Android adapters own platform calls and exact compatibility identifiers.

Split `services/aibus/understand.rs` behind its current module API. Separate
request preparation, location handling, fast local answers, assistant
orchestration, response framing, persistence, and tests. Never merge
`run_local_text_fast_path` with `run_text_cascade`; they are different paths and
their ordering, eligibility, storage, fallback, location, and terminal behavior
must remain locked by tests.

Split `synapse/chat_turn_loop.rs` into loop control, transcript shaping, output
language, tracing, and tests. Keep suspend/resume, parallel-read rules, mutation
ordering, budgets, result bounds, final-action selection, and contiguous trace
events unchanged.

Split `synapse/native_device_actions.rs` into catalog/schema, argument parsing,
feature policy, and handler groups without changing any public action name or
grammar. Stable actions stay available. Feature-gated actions stay gated, and
their physical-device paths must remain covered by explicit acceptance evidence.

## 6. Platform and repository entry points

Keep the root `./revival` command and its current subcommands as the only public
operator CLI. Move cohesive implementation groups behind it: configuration,
stack control, validation, releases, Pin releases, production operations, and
rollback. Preserve help text, exit codes, environment variables, plan/confirm
behavior, and release formats.

Keep `platform/deploy/vps/remote/common.sh` as a stable loader while extracting
cohesive POSIX shell libraries for paths, configuration, Compose, release
transactions, database checks, backup, canary, and drift. Do not rewrite the
transactional shell flow in another language as part of this migration.

Replace the exact docs filename list in
`platform/deploy/acceptance/layout.sh` with a constrained policy: require the
core pages, allow lowercase hyphenated `docs/*.md` pages, reject other file
types, nested generated output, and escaping links. Add a docs index,
`CONTRIBUTING.md`, and CI that runs formatting, focused component checks, layout,
wire equivalence, and the source gate. Update the root layout policy for those
intentional newcomer files without permitting miscellaneous root source areas.

## 7. Language and interaction quality

Create one deterministic wearer-language boundary shared by spoken responses
and mirrored in Center presentation helpers. It must:

- bound output before it reaches speech or compact device UI;
- turn technical faults into short, truthful next steps;
- never turn an unavailable or timed-out action into success;
- remove formatting that sounds unnatural when read aloud;
- keep exact diagnostics available to operators;
- reject internal terms and canned phrases in fixed wearer-facing strings.

At minimum, fixtures must catch phrases such as `as an AI`, `language model`,
`LLM`, `backend`, `provider`, `tool call`, `system prompt`, `JSON`, `I can help
with that`, `let me`, and apology loops. Do not blindly rewrite user content,
notes, contact names, search results, or quoted material. Apply the rule only to
system-authored wearer language and final error presentation.

Add tests for fixed strings, model-returned formatting, empty output, long
output, timeouts, feature-gate declines, and unavailable dependencies. Prefer a
plain answer or one clear recovery step. Do not add a persona paragraph to every
request.

## 8. Visual and motion system

Preserve the visual evidence already expressed by Center and the compact Pin
surfaces. The result should feel quiet and purpose-built: plain labels, strong
hierarchy, few simultaneous actions, no chat-bubble chrome, no sparkle branding,
and no decorative status noise.

Use restrained motion tokens: about 300 ms for direct feedback and about 600 ms
for a larger state transition. Honor `prefers-reduced-motion`. Keep focus,
keyboard, loading, empty, offline, degraded, and destructive-confirmation states
visible and testable. Do not claim pixel identity with a hidden stock product;
match only evidence stored in the repository.

## 9. Validation ladder

Run these in order. Stop at the first new failure, fix it, and repeat that gate.

### Source

- Format only intentional files.
- Run the nearest Center, Cosmos, and Pin tests after every extraction.
- Run layout, wire-divergence, wire-equivalence, feature-contract, public-copy,
  route-boundary, and release-manifest checks.
- Run `./revival test --source` and `./revival release check --source`.
- Inspect `git diff --check`, `git status`, and the exact staged file list.

### Composed stack

Run `./revival doctor`, build and start the stack, wait for health, inspect
`./revival status`, and exercise Center, device-facing gRPC, wearer data,
settings, assistant, Nearby, search, and speech paths. Shut down only if the
documented local workflow requires it. Record service identity and failures, not
only HTTP status.

### Immutable release

Build the VPS profile with the supported `./revival release` command. Verify the
archive and manifest, content digest, source commit, included paths, and excluded
state. Record the release ID and rollback target.

## 10. Deploy to the VPS

Use the current help output and `docs/operations.md`; do not invent flags.

1. Verify the exact configured remote and run production doctor/preflight.
2. Take a verified backup. Fetch the off-host bundle when the documented
   prerequisites are satisfied and record its location without exposing secrets.
3. Run the deployment dry run and review the release/config plan.
4. Deploy the immutable release through the supported transactional command.
5. Run `./revival canary --remote vps --json` and require the real wearer plane,
   then run `./revival drift --remote vps --json`.
6. Verify the public Center and device edge semantically. A process restart or
   HTTP 200 alone is not acceptance.

If the transaction fails, preserve evidence and use only the documented rollback
for the exact deployment. Never treat rollback as a database restore.

## 11. Build and install the Pin release

1. Run `./revival pin doctor` and `./revival pin check`.
2. Inspect Pin release history and choose the next monotonic version and version
   code. Build the signed five-role release with `./revival pin release build`.
3. Inspect and verify its manifest, signer, artifact sizes, SHA-256 values,
   history, and release identity. Ship it to the Center-served store with the
   plan-first `pin release ship` flow if the VPS needs it.
4. Read the connected device list. Select one exact serial and record its model,
   firmware/build identity, battery/transport state, installed packages,
   versions, signers, and rollback availability.
5. Run `./revival pin install --serial <exact-serial>` without `--confirm`.
   Review the locked release and every planned package change.
6. Only if that plan is compatible, run the same command with `--confirm`.
   Do not add `--confirm-bootstrap-recovery`. If normal installation fails, stop
   and report the preserved device state.
7. Re-read installed package versions, signers, release identity, readiness, and
   server connectivity. Match them to the immutable release manifest.

## 12. Physical acceptance

Report each observation independently:

- A typed or injected transcript proves routing only, not microphone recognition.
- Received speech frames prove transport only, not human-audible playback.
- Narration text proves content only, not projector rendering.
- `adb devices` proves the debug transport only, not runtime health.

On the exact Pin, perform controlled, non-destructive prompts for a plain answer,
Nearby, one private-data read, one read-only device query, and one consented
native setting action. Confirm microphone input, one terminal response, audible
speech, expected projector state, no duplicate action loop, and accurate offline
language. Capture bounded logs and remove wearer content from the final report.

## 13. Commit and final report

Review the final diff, stage only intentional files by path, and create one or
more clear commits. Push only the current branch after all source gates pass and
the configured GitHub identity is correct.

The final report must contain:

- before and after architecture, file sizes, ownership, and wearer experience;
- changed files and any compatibility-preserving re-exports left temporarily;
- source test commands, counts, and failures;
- stack identity and semantic smoke results;
- commit SHA, release ID, archive/manifest digest, deployment ID, canary, drift,
  backup, and rollback target;
- exact Pin serial, firmware/build, installed package versions, signer and
  artifact digests;
- separately observed microphone, assistant routing, speech transport,
  audibility, projector, Nearby, and native-action behavior;
- every remaining unknown or item requiring user input.

Do not end with a progress-only handoff. End when all authorized gates pass, or
when blocked by information or physical input only the user can provide.
