# Devpost update (draft to paste)

This is the updated project description Stage 2 asks for: what was built, the tech stack, and how the project evolved. Paste the sections below into the Devpost project page, then fix "Built With" as listed at the end. Every number here comes from `pnpm replay checkout-v4.21.7` and `pnpm eval`, run on 2026-09-24.

---

## Inspiration

When a release breaks checkout, support sees a handful of complaints in different words, and engineering sees an error rate. Nobody sees the customers:
- who was actually harmed;
- who stayed silent;
- whether each one got the right recovery.

Most of the people hit by an outage never write in. They just leave.

## What it does

CrisisCrew is a **customer harm response** layer for Freshworks. Incident tools tell engineering what broke; support tools tell you who complained. CrisisCrew connects the two:

1. **Detects** a customer-impact event from a burst of complaints. Similarity is by meaning and product area, behind four gates, and each refusal comes with a plain reason. Detection is the trigger, not the product.
2. **Verifies** it against operational evidence. The Investigator ranks causes (a release, the payment provider, or unknown) by prior × likelihood ratios, with every factor shown.
3. **Proves who was harmed.** The **Customer Impact Graph** joins tickets, customers, failed payments, the affected service and the cause:
   - A customer counts as affected only with a failed or pending payment inside the incident window.
   - A complaint without one stays *not verified*: acknowledged, never credited.
4. **Finds the customers who stayed silent.** In the hero scenario, 8 customers complain and CrisisCrew finds 15 more whose payments failed but who never contacted support.
5. **Plans each customer's recovery** from their own harm, with a reason for every action:
   - the channel they agreed to, or an account note if they opted out of messages;
   - a voice update for priority customers;
   - a credit sized by the harm: none if they paid on a retry, ₹200 for a failed payment, ₹1,000 for priority customers or payments of ₹10,000 or more.
6. **Acts within authority, and stops for a human above it.** The agents may credit ₹500 per customer and ₹5,000 per incident. Anything more is an approval for one customer, with their evidence, and only the approved amount can be paid, only to that customer.
7. **Writes back into Freshworks.** On each Freshdesk ticket it leaves a private link note, the update as a reply and an outcome note. It files a Freshservice incident for engineering. A Freshdesk sidebar app shows each customer's impact on their ticket.
8. **Measures Recovery Coverage:** recovered confirmed customers over confirmed customers. The incident reaches *Recovered* only at 100%.

**In the hero scenario,** a checkout release breaks payments:
- The incident opens on the 4th complaint, 18 seconds after the first. The Investigator names `checkout-service v4.21.7` with 97% confidence.
- 23 customers were harmed: 8 complained and 15 stayed silent, each with their evidence.
- 21 are recovered within policy. That's ₹4,000 in credits, updates through each customer's own channel, and account notes for the three who opted out of messages.
- Two priority customers' ₹1,000 credits wait for a human. After one approval and one change to ₹500, coverage reaches **23/23**.
- All 86 tool calls land in a hash-chained audit log.

## How we built it

- **All TypeScript:** a pnpm monorepo with shared zod contracts, a pure engine, adapters, a Hono server and a React UI.
- **Detection:** sentence embeddings from `all-MiniLM-L6-v2`, running locally through transformers.js with no external API. Similarity is half meaning and half product area, with no keyword lists, and questions are recognised by their form.
- **Customer Impact Graph and recovery:** pure functions over the orders data and the incident's tickets. They produce evidence edges, per-customer plans with reasons and authority levels, and Recovery Coverage. Recovery runs as one idempotent pass, repeated for each later complaint and each human decision.
- **Agents:** five agents with separate identities. Every tool call goes through a policy gate, which checks:
  - the allow-list;
  - the authority level, which can depend on the arguments and on what's already been spent;
  - consent, evidence of harm, and exact approved amounts.

  Each call writes one audit entry.
- **Freshworks:**
  - Freshdesk webhook or poll ingest, matching requesters to customers by email;
  - private notes and replies through the REST API or Freshdesk's official MCP server;
  - Freshservice incidents;
  - a Freshdesk ticket-sidebar app (platform 3.0).
- **MCP:** CrisisCrew's own MCP server at `/mcp`. Each bearer token is one identity and sees only its own tools. A read-only operator can call `get_customer_impact` and `get_recovery_coverage`, so an Agent Studio agent sees the same incident customer by customer.
- **Agent workflows (LangGraph):**
  - The lifecycle runs as five compiled LangGraph graphs: ticket intake; incident response, with the investigation, the impact assessment and the engineering filing in parallel; the recovery pass; a late complaint; a human decision.
  - The graphs decide the order. The agents' steps do the work, and every action still goes through the gate.
- **Traces (LangSmith):**
  - Every workflow run is recorded span by span: graph → node → gate call, guard check or classifier call. Inputs and outputs are redacted.
  - The Traces page draws each workflow, marks the path a run took, and opens at the first refused, flagged or failed step.
  - With a key, the same run trees go to LangSmith, one thread per incident.
- **Guardrails:**
  - A prompt-injection guard screens tickets and the text in tool outputs; Lakera Guard can be layered over it.
  - An output guard checks every customer message: no unapproved amount, no link, nobody else's details.
  - Tool calls with unknown fields are refused, and request bodies are strict.
  - An exposed server won't start without tokens.
  - There are rate limits, and an egress allow-list for model and tracing calls.
- **Classifier (Laya):** a non-generative decision model labels each ticket (failure, question or request, and its product area) with probabilities. It's used above the policy's thresholds, with the built-in classifier as the fallback. It was run against a real local `laya-serve`.
- **UI:** a production-style console driven by a live event stream. It has five pages (incident, customers, tickets, agents, governance), with evidence chains and per-customer decisions, in light and dark themes.
- **Evaluation:** 60 seeded runs over six kinds, with the paraphrase pools split so that no tuning sentence appears in the test. On the held-out split: incident precision and recall 100% (15 of 15), linking 100% and 99%, median detection at the 4th complaint, and the root cause correct every time. A stress test of mixed delivery complaints opens an incident in 10 of 20 runs, and we report that as a limit.
- **Safety and impact evals:**
  - 44 prompt-injection attacks went through the hero incident, and 51 direct attacks hit the gate. The result: 0 unauthorized actions, 0 wrong-customer credits, 0 policy bypasses, 0 successful injections and 0 duplicate payments.
  - The guard's recall is 98%, with no false alarms on 221 genuine tickets.
  - Across 30 generated worlds with distractors, affected-customer precision and recall and silent-customer recall are all 100%.
- **Testing:** 310 tests and CI on every push. The Freshdesk, Freshservice, Freshdesk-MCP, Laya and Lakera adapters are tested against fakes of their APIs, and the LangSmith exporter against a fake client.

## How it evolved

- **Stage 1 was a scripted prototype.** A single HTML page played a 12-second animation, and its numbers were typed into the page.
- **Stage 2 made it real.** Correlation, confidence and credits were computed from data, and the agents made real tool calls through a real permission gate.
- **Then we pivoted.** "Detect outages from similar tickets" is useful but not new. What matters is what happens after harm begins:
  - proving who was harmed;
  - finding the silent;
  - recovering each customer by their own harm;
  - measuring coverage;
  - doing it inside Freshworks.

  The blanket credit (₹500 × everyone) became a per-customer recovery policy, and "an incident exists" became "23 harmed, 15 silent, 21 recovered, 2 waiting for you".

## What's real and what isn't

- **Real:** the engine, the Customer Impact Graph, the recovery policy, the agents, the gate, the audit log, MCP and the UI.
- **Sandbox:** the world they act on: customers, consent, payment attempts, releases, gateway status and error rates.
- **Wired, not yet run against a live account:** Freshdesk, Freshservice and the sidebar app. We switch them on with a trial account at the event.
- **Wired and run against the real thing:** Laya (a local `laya-serve`).
- **Wired, tested with the SDK against a local recorder, not yet a real project:** LangSmith. It needs a key.
- **Designed, not wired:** GitHub deployments, Razorpay status, ElevenLabs voice, Claude, and the sponsor APIs.

The environment box in the UI's sidebar says exactly which parts are live.

## Challenges we ran into

- **Harm, not membership.** A complaint isn't proof of harm, and silence isn't proof of none. Tying impact to failed payments inside the incident window, and keeping unverified complaints apart, was the core design decision.
- **Governed money at scale.** Per-customer credits mustn't add up to an unsupervised payout. The gate checks each credit against a per-customer limit *and* the running incident budget, and the planner escalates in a fixed order, so agents can't split a payout to get past it.
- **Different words, same failure.** Plain sentence embeddings scored short complaints about the same failure at only about 0.44. Adding the product-area half raised the separation of labeled pairs (AUC) from 0.94 to 1.00.

## Accomplishments that we're proud of

- The silent customers: every one has an evidence chain a judge can click through.
- Recovery Coverage as the success metric, and an incident that can't show as recovered while anyone is unhandled.
- A walk-in complaint with no payment on record gets an acknowledgement and no money.
- Per-customer approvals where only the exact approved amount can be paid.

## What we learned

A good incident response isn't measured when the alert fires. It's measured when the last affected customer has been made whole.

## What's next

- Run the Freshdesk, Freshservice and sidebar integrations against live accounts, and register the MCP server in Agent Studio.
- Replace the sandbox orders data with a real commerce or payment-gateway source.
- Reach silent customers through Freshdesk outbound email, and resolve incidents when a fix is confirmed.
- Learn the recovery policy and the detection thresholds from confirmed incidents.

## Built With

`typescript` · `node.js` · `react` · `vite` · `hono` · `zod` · `langgraph` · `langsmith` · `laya` · `model-context-protocol` · `transformers.js` · `vitest` · `multi-agent-systems` · `agentic-ai`

- Remove `fastapi`, `python` and `tailwindcss`: none of them is used anywhere in the project.
- Add `freshdesk` and `freshservice` **only if** they were switched on and shown working at the event.
