# CrisisCrew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **How this plan was run:** the team asked for linear execution in one session on a MacBook Air, so the plan's author executed it inline, one task at a time, test first, with a commit per task. Tasks specify files, interfaces, tests and acceptance checks. The code lives in the repo, not in this document.

**Goal:** Build the complete CrisisCrew system from [design.md](design.md) in sandbox mode, runnable offline, with every external API listed in `.env.example` but not wired.

**Architecture:**
- A pnpm TypeScript monorepo.
- `packages/contracts` holds the shared zod schemas and the state reducer.
- `packages/core` holds the pure engine: correlation, agents, root-cause scoring, the policy gate and the audit log.
- `packages/adapters` holds the sandbox ports and the embedders.
- `apps/server` is the only process. It hosts the Hono API, SSE, MCP at `/mcp`, replay, eval and the CLI.
- `apps/web` is the React UI in the Stage 1 look.

**Tech stack:**
- Runtime and language: Node 24 LTS (runs on 25 with an engine warning), pnpm 10, TypeScript 5.9 (strict)
- Libraries: Vitest 5, zod 4, Hono 4.13 with @hono/node-server 2, @modelcontextprotocol/sdk 1.30, @huggingface/transformers 4.3
- Web: React 19, Vite 8

**Spec:** [docs/design.md](design.md)

## Global Constraints

- Every number the UI shows is computed from data at run time. No literal scores, counts or percentages appear in UI or engine code.
- External APIs (Freshdesk, GitHub, Razorpay status, ElevenLabs, Anthropic, Sarvam, Dodo, Vobiz, AWS) are **not wired**:
  - Selecting a live adapter makes the server refuse to start with `adapter "<name>" is not wired yet`.
  - `GET /api/wiring` reports `planned` for live options.
- Sandbox mode is the default and works fully offline once the embedding model is downloaded.
- Tests never load the embedding model. They use `HashEmbedder` or the committed embedding cache (`scenarios/.embeddings/`).
- `core` imports no SDK and does no network or file I/O. It uses `node:crypto` for hashing only.
- Resource budget (MacBook Air):
  - one server process
  - no watchers left running
  - ONNX threads capped at 2
  - no parallel heavy jobs
- Policy data (levels, allow-lists, limits, thresholds, priors, likelihood ratios) lives in `config/policy.json` and is validated by zod at startup.
- Commit after each task and push at the end of each milestone. Commit messages end with the `Co-Authored-By` trailer.

## File map

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.config.ts, .github/workflows/ci.yml
config/policy.json
packages/contracts/src/  index.ts · domain.ts (ticket, signal, cluster, incident, approval, audit)
                         scenario.ts · policy.ts · events.ts · state.ts (initialState, reduce) · wiring.ts
packages/core/src/       index.ts · ports.ts · clock.ts · bus.ts
                         math/vector.ts · math/poisson.ts · math/rng.ts
                         correlation/prototypes.ts · correlation/enrich.ts · correlation/cluster.ts
                         correlation/gates.ts · correlation/pattern.ts
                         policy/audit.ts · policy/gate.ts · tools/definitions.ts
                         rca/score.ts · recovery/templates.ts
                         agents/investigator.ts · agents/recovery.ts · agents/handoff.ts · agents/commander.ts
                         engine.ts
packages/adapters/src/   index.ts · sandbox/world.ts · sandbox/ports.ts
                         embeddings/hash.ts · embeddings/local.ts · embeddings/cached.ts
apps/server/src/         main.ts · config.ts · runtime.ts · scenarios.ts
                         http/app.ts · http/sse.ts · mcp/endpoint.ts
                         cli/replay.ts · cli/warm-embeddings.ts · eval/generate.ts · eval/run.ts
apps/web/                index.html · vite.config.ts · src/main.tsx · src/App.tsx · src/api.ts · src/useCrisis.ts
                         src/styles/stage1.css · src/styles/app.css · src/components/*.tsx
scenarios/               *.json (6 scenarios) · pools/*.json (eval) · .embeddings/<model>.jsonl
```

---

## Milestone M0: skeleton

### Task 1: Workspace, toolchain, CI

**Files:**
- Create: root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`
- Create: `.github/workflows/ci.yml`
- Create: a `package.json`, `tsconfig.json` and `src/index.ts` for each package
- Modify: `.gitignore` (add `.models/`)

**Interfaces:**
- Packages: `@crisiscrew/contracts`, `@crisiscrew/core`, `@crisiscrew/adapters`, `@crisiscrew/server`, `@crisiscrew/web`.
- Each package exports its TypeScript source (`"exports": {".": "./src/index.ts"}`), so there's no build step.
- Root scripts: `dev`, `start`, `test` (`vitest run`), `typecheck` (each package's `tsc --noEmit`, run one after another), `replay`, `eval`, `embeddings:warm`.

- [ ] Step 1: Write a smoke test (`packages/core/src/smoke.test.ts`) that imports from `@crisiscrew/contracts` and `@crisiscrew/core`.
- [ ] Step 2: `pnpm install`; `pnpm test`. Expected: fails until the packages resolve.
- [ ] Step 3: Add the package manifests and tsconfigs. Expected: `pnpm test` and `pnpm typecheck` pass.
- [ ] Step 4: Add CI: Node 24, pnpm 10, `install --frozen-lockfile`, `typecheck`, `test`, web build.
- [ ] Step 5: Commit `Set up the pnpm workspace, TypeScript, Vitest and CI`.

## Milestone M1: correlation engine, scenarios, CLI replay

### Task 2: Contracts (schemas and reducer)

**Files:** `packages/contracts/src/{domain,scenario,policy,events,state,wiring}.ts`, tests beside them.

**Interfaces (produced):**

Ticket
- `Channel`: `chat | email | phone | portal`
- `TicketInput`: `{customerRef, customerName, channel, subject?, body, receivedAt?, externalId?}`
- `Ticket`: `TicketInput` plus `{id, source, receivedAt}`

Signal and cluster
- `Surface`: `checkout_payments | login_account | delivery_orders | refunds_billing | app_performance | other`
- `SignalView`: `{ticketId, surface, surfaceScore, failureScore, isFailure, entities}`
- `GateResult`: `{name, value, threshold, pass, reason}`
- `ClusterView`: `{id, memberTicketIds, cohesion, failureShare, failureCount, spanSec, burstP, baselinePerHour, dominantSurface, gates, fires, firstAt, lastAt}`

Identities, audit and hypotheses
- `Level`: `0 | 1 | 2 | 3`
- `Identity`: `pattern | commander | investigator | recovery | handoff | operator`
- `AuditEntry`: see design §4
- `Hypothesis` and `EvidenceItem`: see design §7

Incident lifecycle
- `Approval` and `CustomerUpdate`: see design §8
- `IncidentView`: `{id, status, severity, openedAt, surface, clusterId, ticketIds, linkedTicketIds, hypotheses, rootCause?, affected?, updates, approvalId?, credit?, timeline}`
- `AgentView`: `{id, name, level, status, task?, lastTool?}`

Events and state
- `CrisisEvent`: a discriminated union on `type`, covering design §10.2 plus `session.started` (which resets the state)
- `CrisisState`: `{seq, session, tickets, ticketOrder, candidate, incidents, incidentOrder, agents, toolCalls, approvals, credits}`
- Functions: `initialState()` and `reduce(state, event)`

Scenario, policy and wiring
- `ScenarioSchema`: `{id, title, purpose, expected, world, tickets, background?}`, where `world` is `{services, deployments, baselineErrorRate, providers, customers, attempts, baselinePerHour}` and times are relative strings like `-14m` or `+30s`
- Function: `parseOffset("-14m") → -840000`
- `PolicySchema`: `{identities: {[id]: {maxLevel, tools[]}}, limits, correlation, rca, recovery}`
- `WiringReport`: `{ports: [{port, mode, adapter, detail}]}`

- [ ] Write the tests first:
  - `parseOffset` handles s, m and h, with both signs
  - `reduce` applies `ticket.received`, `cluster.updated`, `incident.opened` and `incident.status_changed`
  - `session.started` resets the state
  - the policy schema rejects an unknown tool name when given the known tool list
- [ ] Implement until green. Commit `Add shared contracts: domain schemas, events and the state reducer`.

### Task 3: Core math and correlation

**Files:**
- Math: `packages/core/src/math/{vector,poisson,rng}.ts`
- Correlation: `correlation/{prototypes,enrich,cluster,gates,pattern}.ts`
- Plumbing: `ports.ts`, `clock.ts`
- Tests beside each file

**Interfaces:**

Math
- `cosine(a, b)`, `meanVector(vs)`
- `poissonTail(n, mu)`: P(N ≥ n)
- `mulberry32(seed)`

Ports and clocks
- `Clock {now(), sleep(ms)}`
- Clocks: `SystemClock`, `ManualClock(start)` (with `set` and `advance`), `ScaledClock(start, speed)`
- `Embedder {id, embed(texts): Promise<Float32Array[]>}`

Enrichment and clustering
- `enrich(text, vector, prototypes) → {surface, surfaceScore, failureScore, isFailure}`
- `extractEntities(text)`
- `clusterComponents(signals, edgeThreshold)` uses union-find
- `evaluateGates(cluster, cfg, baselinePerMin)`

The pattern engine
- `PatternEngine`: constructor `(embedder, clock, cfg: CorrelationConfig)`
- Methods: `init()`, `ingest(ticket) → {signal, candidate, fires, joinIncidentId?}`, `attachIncident(id, memberIds)`

- [ ] Write the tests first:
  - cosine of identical vectors is 1 and of orthogonal vectors is 0
  - `poissonTail(5, 0.05)` ≈ 2.5e-9
  - union-find joins a chain, and cohesion exposes chaining
  - each gate passes and fails at its threshold
  - `PatternEngine` with a stub embedder of fixed vectors:
    - fires on 5 near-identical failure vectors within 30 s
    - doesn't fire on 2
    - doesn't fire on 6 questions
    - joins a later similar failure to the open incident
- [ ] Implement until green. Commit `Add the correlation engine: enrichment, clustering, gates and burst test`.

### Task 4: Embedders, scenarios and calibration

**Files:**
- Embedders: `packages/adapters/src/embeddings/{hash,local,cached}.ts`
- Warm-up CLI: `apps/server/src/cli/warm-embeddings.ts`
- Scenarios: `scenarios/*.json` (the six scenarios in design appendix)
- Cache: `scenarios/.embeddings/<model>.jsonl`

**Interfaces:**
- `HashEmbedder(dim = 384)`: deterministic
- `LocalEmbedder(modelId, {cacheDir, threads})`: transformers.js `feature-extraction`, q8, mean pooling, normalised
- `CachedEmbedder(inner | null, file)`: key = sha256(modelId + text). A miss with `inner` null throws `EmbeddingCacheMiss`.

Steps:
- [ ] Write the tests first. `CachedEmbedder` returns cached vectors, and on a miss with no inner embedder it throws.
- [ ] Write the scenario files. The hero reuses the Stage 1 wording; every other text is new.
- [ ] Run `pnpm embeddings:warm` for the candidate models.
- [ ] **Calibration check.** For each model, print mean within-incident similarity, incident-to-background similarity and look-alike similarity. Pick the model with the larger margin. Set `correlation` thresholds in `policy.json` and record the numbers in `docs/eval.md`.
- [ ] Write scenario tests with cached embeddings:
  - the hero fires and the UPI outage fires
  - `lookalike-checkout-questions` is refused by `failure_share`
  - `scattered-failures`, `two-card-complaints` and `quiet-day` don't fire
- [ ] Commit `Add scenarios, embedders and the embedding cache; calibrate thresholds`.

### Task 5: CLI replay (detection)

**Files:** `apps/server/src/scenarios.ts` (load and validate), `apps/server/src/cli/replay.ts`

- [ ] Run `pnpm replay checkout-v4.21.7`. It prints each ticket with its surface and failure score, the candidate cluster's gates, and the incident opening. Expected: the incident opens after the fifth ticket.
- [ ] Commit `Add CLI scenario replay`. Push (end of M1).

## Milestone M2: the full incident lifecycle

### Task 6: Policy gate and audit log

**Files:** `config/policy.json`, `packages/core/src/policy/{audit,gate}.ts`, `tools/definitions.ts` (names, levels, schemas; handlers are injected)

**Interfaces:**
- `AuditLog(onAppend?)`: `append`, `entries`, `verify() → {ok, brokenAt?}`
- `ToolDef`: `{name, description, input (zod), level(args, ctx), condition?(args, ctx), run(args, ctx)}`
- `PolicyGate(policy, tools, audit, clock, emit)`:
  - `call(identity, tool, args) → {ok: true, result} | {ok: false, reason}`
  - also `permitted(identity)` and `matrix()`

Steps:
- [ ] Write the tests first:
  - the full matrix from `policy.json`: pattern can't `link_ticket_to_incident`, investigator can't `send_customer_update`, operator is read-only
  - `issue_recovery_credit` is L2 at or under the limit and L3 above it
  - L3 needs an approved approval with a matching amount
  - L2 voice needs voice consent
  - every call appends exactly one audit entry
  - tampering with an entry makes `verify()` fail
- [ ] Implement until green, then commit.

### Task 7: Sandbox world and ports

**Files:** `packages/adapters/src/sandbox/{world,ports}.ts`

**Interfaces:**
- `createSandboxPorts(scenario, {t0, clock, latencyMs}) → Ports` covering deployments, payments, metrics, orders, ticketActions, notifier, voice (off) and credits (ledger).
- The simulated metrics raise the error rate after a deployment flagged `faulty`, with seeded noise.

Steps:
- [ ] Write the tests first:
  - deployments come back sorted
  - the metric ratio around the faulty deploy in the hero world is between 7 and 10
  - orders return the 23 affected customers for the hero
- [ ] Implement until green, then commit.

### Task 8: Root-cause scoring

**Files:** `packages/core/src/rca/score.ts`

**Interfaces:** `scoreHypotheses({firstAt, deployments, errorSeriesByService, providers, methodSpread, rca}) → Hypothesis[]`, sorted by confidence.

Steps:
- [ ] Write the tests first:
  - the hero evidence ranks `checkout-service@4.21.7` first at 0.95 or more
  - the UPI evidence ranks the provider first
  - a missing check is "not checked", with LR 1
  - confidences sum to 1
- [ ] Implement until green, then commit.

### Task 9: Agents, commander, engine

**Files:** `packages/core/src/{bus,engine}.ts`, `agents/*.ts`, `recovery/templates.ts`

**Interfaces:**
- `EventBus`: `emit`, `since`, `subscribe`
- `CrisisEngine(deps)`:
  - methods: `init`, `ingest(input)`, `decide(approvalId, {decision, amountInr?, note?, by})`, `whenIdle`, `state`
  - fields: `gate`, `bus`

Steps:
- [ ] Write the tests first (sandbox ports, cached embeddings, `ManualClock`):
  - **hero:** incident; root cause 4.21.7; 8 linked; affected 23 (8 ticketed, 15 silent); updates to ticketed and consenting silent customers; 2 voice scripts; a ₹11,500 approval pending
  - **decisions:** approve issues ₹11,500. Modify to ₹5,000 issues ₹5,000, and a mismatched execution is refused. Reject issues nothing.
  - **UPI outage:** provider root cause
  - **look-alikes:** no incident
- [ ] Implement until green, then commit.

### Task 10: CLI shows the full lifecycle

- [ ] Extend `replay.ts` with agent activity, tool calls, the root-cause ranking, recovery counts and the approval. Add a `--decide approve|modify:<amount>|reject` flag.
- [ ] Commit, then push (end of M2).

## Milestone M3: API and event stream

### Task 11: Server

**Files:** `apps/server/src/{config,runtime,main}.ts`, `http/{app,sse}.ts`

**Interfaces:**
- `loadConfig(env)`. Live adapters throw "not wired yet".
- `Runtime`:
  - methods: `startReplay(id, speed)`, `ingest(input)`, `decide(...)`, `reset()`, `state()`, `wiring()`
  - fields: `bus`, shared across engine swaps. `session.started` is emitted on each replay.
- `createApp(runtime, config)`: the routes in design §10.1, minus the Freshdesk webhook (not wired).

Steps:
- [ ] Write the tests first with `app.request`:
  - `/api/health`
  - `/api/wiring` shows every port as sandbox and live options as planned
  - `POST /api/replay` then `/api/state` shows the tickets
  - `POST /api/approvals/:id` approves
  - admin endpoints need `ADMIN_TOKEN` when it's set
  - `/api/audit/verify` returns ok
  - the SSE route streams `session.started`
- [ ] Implement until green. Commit, then push.

## Milestone M4: the web UI

### Task 12: Web app

**Files:** `apps/web/*`

**Interfaces:**
- `useCrisis()`: fetches `/api/state`, subscribes to `/api/stream`, and applies `reduce` from contracts.
- `api.ts`: `startReplay`, `decide`, `addTicket`, `getWiring`, `getPolicy`, `getAudit`, `getScenarios`.

**Panels (design §10.4):** header with wiring badge and scenario controls, signals, correlation, incident, agents, investigation, recovery, handoff, audit, permissions, eval summary, add-a-ticket box.

Steps:
- [ ] Port the Stage 1 CSS variables and card styles into `src/styles/stage1.css`.
- [ ] Build the panels.
- [ ] Verify in the browser: the hero replay shows every step with computed numbers; approve, modify and reject all work; the look-alike replay shows the refusal.
- [ ] Take screenshots for the README. Commit, then push.

## Milestone M5: MCP server

### Task 13: `/mcp`

**Files:** `apps/server/src/mcp/endpoint.ts`

**Interfaces:**
- Hono route `/mcp`: bearer token → identity; a new `McpServer` and stateless `WebStandardStreamableHTTPServerTransport` per request.
- Tools are registered from the identity's permitted list.
- A `tools/call` for a tool the identity may not use is refused by the gate, audited, and returned as `isError: true`.

Steps:
- [ ] Write the tests first. Use the SDK `Client` with `StreamableHTTPClientTransport` and a custom `fetch` that calls `app.fetch`:
  - the operator lists only read tools
  - `get_incident` works
  - the pattern token calling `link_ticket_to_incident` is refused and audited
- [ ] Implement until green. Commit, then push.

## Milestone M7: eval

### Task 14: Eval harness

**Files:** `scenarios/pools/*.json`, `apps/server/src/eval/{generate,run}.ts`, `docs/eval.md` (generated)

Steps:
- [ ] Write the paraphrase pools:
  - three incident kinds (checkout release bug, UPI outage, login OTP outage)
  - benign background, look-alike questions, scattered failures
- [ ] Generate 40 seeded runs (20 incident, 20 not). Tune on seeds 1–20 and report on seeds 21–40.
- [ ] Report incident precision and recall, linking precision and recall, detection latency, root-cause top-1 accuracy, and a threshold sweep.
- [ ] Commit, then push.

## Docs and finish

### Task 15: README, demo script, compliance, prep checklist

- [ ] The README states honestly what's real and what's sandbox, with a status table, how to run it, architecture, screenshots, and the policy and audit story.
- [ ] `docs/demo-script.md`: the stage flow.
- [ ] `docs/compliance.md`: the rules check, including the organizers' email.
- [ ] `docs/prep-checklist.md`: Node 24, model download, keys to collect at the event, tunnel.
- [ ] Update `design.md` where the build differs from the design.

### Task 16: Verification

- [ ] From a fresh clone: `pnpm install`, `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm start`, and the hero replay in the browser. Record the results in the final summary.

## Self-review against the spec

- **Covered:** every design section maps to a task.
  - §5 detection: Tasks 3–4
  - §6 lifecycle and agents: Task 9
  - §7 root cause: Task 8
  - §8 recovery and handoff: Task 9
  - §9 policy and audit: Task 6
  - §10.1–10.2 API and SSE: Task 11
  - §10.3 MCP: Task 13
  - §10.4 UI: Task 12
  - §11 resource budget: global constraints
  - §12 error handling: Tasks 6, 11 and 13
  - §13 testing and eval: every task, plus Task 14
- **Deliberately not built:**
  - §10.5 live adapters and the Freshdesk webhook: the team asked for APIs to be listed, not wired, so each appears in `.env.example` and as `planned` in `/api/wiring`
  - §16 stretch goals
