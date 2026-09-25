# Agent workflows and traces

CrisisCrew's agents run as **LangGraph** graphs, and every run of a graph is a **trace**: its nodes, and every policy-gate tool call, guard check and classifier call inside them. The **Traces** page shows each trace step by step. The same traces go to **LangSmith** when a key is set. Either way, a refused call, a flagged input or a failure is marked, and the trace opens at it.

## The workflows

Five graphs, compiled once per session from `packages/core/src/workflows/graphs.ts`. `GET /api/workflows` returns their structure, read from the compiled graphs, and the Traces page draws it.

```mermaid
flowchart LR
  subgraph T[Ticket intake: every ticket]
    t1[Screen for injection] --> t2[Classify] --> t3[Correlate]
    t3 -.-> t4[Alert the Commander]
    t3 -.-> t5[Join open incident]
    t3 -.-> t6[No incident]
  end
  subgraph I[Incident response: once per incident]
    i1[Open incident] -.-> i2[Investigate] & i3[Find who was harmed] & i4[File for engineering]
    i2 & i3 & i4 --> i5[Brief engineering] --> i6[Recovery pass]
  end
  subgraph R[Recovery pass: a subgraph]
    r1[Reassess impact] --> r2[Plan recovery] -.-> r3[Act within authority] --> r4[Write back] --> r5[Ask a human] --> r6[Settle]
    r2 -.-> r5
  end
  t4 --> I
  t5 --> L[Late complaint: link, then a recovery pass or a reassessment]
  i6 --> R
  H[Human decision: carry out, write back, settle]
```

| Workflow | Runs | Nodes (agent) |
|---|---|---|
| Ticket intake | for every ticket | screen (engine), classify, correlate, then open, join or no incident (Pattern Agent) |
| Incident response | once per incident | open (Commander); investigate (Investigator), find who was harmed (Recovery) and file for engineering (Commander) **in parallel**; brief engineering; recovery pass |
| Recovery pass | after the root cause, each late complaint and each human decision | reassess, plan, act within authority, write back (Recovery); ask a human (Handoff); settle (Commander) |
| Late complaint | for a complaint that joins an open incident | link; then a recovery pass once recovery is under way, or just a reassessment |
| Human decision | when an approver decides one customer's credit | carry out, write back (Handoff); settle (Commander) |

**The graphs decide the order; the agents' steps do the work.** The steps are the same functions as before: `src/agents` split into node-sized pieces, with identical behaviour. The 256 tests from before the refactor pass unchanged, and `pnpm eval` gives the same numbers. Every action still goes through the policy gate.

**One pass at a time per incident:** the recovery pass runs inside the incident's serial chain, so two passes never plan or pay the same thing.

## What a trace records

| Span kind | What it is | Recorded |
|---|---|---|
| workflow | one graph run, or a nested one (the recovery pass inside an incident) | its input, and the outcome in one line |
| node | one LangGraph node | the state it read, and what it returned |
| tool | one policy-gate call | the arguments; the result or the refusal; the audit entry, authority level and adapter |
| guard | one prompt-guard check | the text screened, the verdict, the reasons |
| classifier | one Laya call | the text, the labels and probabilities, the checkpoint, the latency |

**Nesting follows async context** (`AsyncLocalStorage`), so a gate call made deep inside an agent lands under the node that made it, with no tracing code in the agents.

**Status of a span:**
- *ok*;
- *refused*: the policy gate denied the call;
- *flagged*: the prompt guard found instruction-like text;
- *fell back*: a classifier or guard didn't answer, and the built-in one did;
- *error*.

**Status of a trace:**
- **ok**;
- **needs attention**: something was refused, flagged or fell back;
- **error**.

The **first problem** is the most serious one, and the earliest among equals. It's what the trace opens at.

**Links between traces:** a trace started from inside another is linked to it, not nested in it. For example, the incident trace records the ticket trace that opened it (`parentTraceId`).

**Redaction:** inputs and outputs are redacted before any sink sees them:
- secrets: bearer tokens, keys, long hex strings, fields named like a key or token;
- emails and UPI IDs;
- card numbers, phone numbers, PAN and Aadhaar-like numbers.

Names and customer refs stay, so a trace is still readable. Payloads are clipped: long strings, long arrays, deep nesting.

## The Traces page

**The agents:** a strip showing what each agent is doing now.

**The workflow map:** one LangGraph graph, drawn from the compiled graph. Conditional edges are dashed, and parallel branches are stacked. With a run open, the map shows its path:
- nodes it didn't take are faded;
- a node with a problem under it is ringed red (refused, error) or amber (flagged, fell back);
- clicking a node opens its step.

**Runs:** every workflow run of the session, newest first. It can be filtered to the runs that need attention, or to incident work. A run that went wrong shows its first problem in place of its outcome.

**The trace:** a waterfall of every step in the order it started, with its agent, status, place on the timeline and duration.
- **Where it went wrong** names the first problem: who, which step and why. A link opens that step.
- **Problems only** keeps just the path from the workflow down to what went wrong.
- Any step expands to its input, its output, and its audit entry number, authority level, adapter or checkpoint.

The sidebar counts the runs that need attention. The Governance page counts the inputs the guard flagged.

## Finding where a run went wrong

1. The sidebar shows **Traces · 2 to check**. Open Traces: the page opens the newest run that needs attention.
2. The callout says, for example: *Where it went wrong: Pattern Agent · `issue_recovery_credit` refused: Pattern Agent is not allowed to call issue_recovery_credit.* The refused step is already expanded:
   - the exact arguments the caller sent;
   - the refusal;
   - `audit #87`, the entry in the hash-chained audit log.
3. For a flagged ticket, the map shows the ticket's path. **Screen for injection** is ringed amber, and **No incident** is the branch it took. The guard's step shows the text, the score and the reasons.
4. For an incident, **Problems only** narrows 80-odd steps to the chain that matters, for example **Incident response → Investigate → get_recent_deployments → Prompt guard (flagged)** when a release note carries instructions.

## LangSmith

```bash
# .env
TRACING=langsmith            # or LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...
LANGSMITH_PROJECT=crisiscrew # the default
```

**How runs arrive:** each workflow run arrives as a run tree. The trace is the root run, named like *Incident INC-2026-001*. LangGraph nodes are its children, with `langgraph_node` in their metadata. Gate calls, guard checks and classifier calls sit under the nodes.

**Tags and metadata:** runs are tagged `kind:*`, `agent:*` and `workflow:*`. They carry `session_id`, `incident_id`, `ticket_id` and `approval_id`.

**Threads:** every trace of one incident shares `thread_id = INC-…`. So LangSmith's thread view reads the incident as one story, from the complaint that opened it to the last approval.

**Errors:**
- A refused call is marked as an error, "Refused by the policy gate: …".
- A guard flag is marked as an error, "Flagged by the prompt guard: …".
- A fallback is tagged `warning`.

So LangSmith's error filter finds exactly the runs that went wrong.

**Exporting:** the exporter uses the LangSmith SDK's `RunTree` with batching, through the egress allow-list. Inputs and outputs are redacted again by the client's `hideInputs` and `hideOutputs`.

**One copy of each run:** CrisisCrew sends its own spans. LangChain's automatic tracer would post the same LangGraph runs a second time, so the server clears `LANGSMITH_TRACING` and `LANGCHAIN_TRACING_V2` once its config has read them.

**Status:** wired, and exercised with the real LangSmith SDK against a local recording server:
- `GET /info`, then one `POST /runs/multipart` with the whole run tree;
- the thread id and the refusal error present;
- the email redacted.

**Not yet run against a real LangSmith project:** that needs a key. Set one and run a replay.

## API

| Method and path | Purpose |
|---|---|
| `GET /api/workflows` | the five graphs: nodes (with their agent and purpose) and edges (conditional or not), read from the compiled graphs |
| `GET /api/traces` | this session's traces (`?session=all` for every session), filterable by `incident` and `status` |
| `GET /api/traces/:id` | one trace with every span, in the order they started |

The event stream carries trace summaries (`trace.updated`) as runs start, end or hit their first problem. The spans are fetched from `/api/traces/:id`. Traces are kept in memory: the last 400 traces of up to 2,000 spans each.

## Evals and traces

The evals run the same engine, so every eval run is traced the same way:
- `pnpm eval` covers detection, linking and root cause;
- `pnpm eval:safety` covers the guard, and the engine under attack;
- `pnpm eval:impact` covers affected and silent customers, and credits;
- `pnpm eval:classifier` compares the built-in classifier with Laya.

The reports are [eval.md](eval.md), [eval-safety.md](eval-safety.md), [eval-impact.md](eval-impact.md) and [eval-classifier.md](eval-classifier.md).
