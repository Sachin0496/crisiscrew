# Devpost update (draft to paste)

This is the updated project description Stage 2 asks for: what was built, the tech stack, and how the project evolved. Paste the sections below into the Devpost project page, then fix "Built With" as listed at the end. Every number here comes from `pnpm replay checkout-v4.21.7` and `pnpm eval`, run on 2026-09-23.

---

## Inspiration

Customers notice outages before dashboards do. During a payment incident, the first signal is often a handful of support tickets in different words within a minute: "checkout keeps loading", "UPI isn't working", "card rejected", "money deducted but no order". Support agents see them one at a time. By the time someone connects them, hundreds of customers have been affected, and most of them never write in.

## What it does

CrisisCrew treats incoming support tickets as incident telemetry.

1. **Detect.** It compares each new ticket with recent ones by meaning, not keywords. It opens an incident only when a burst of similar failure reports passes four gates: size, similarity, failure share, and a Poisson burst test against normal volume. When a burst fails a gate, the UI shows the plain reason, for example "4 of 5 are questions, not failures".
2. **Investigate.** The Investigator checks the payment gateway, recent releases and service error rates. It then ranks root-cause hypotheses by prior × likelihood ratios, with every factor shown.
3. **Recover.** The Recovery Agent links the tickets, finds affected customers who haven't complained, and sends everyone the same update through the channel they agreed to.
4. **Hand off.** A goodwill credit above the ₹5,000 authority limit stops for a human. The approver can approve, change the amount or reject, and exactly the approved amount is paid.

**In the hero scenario,** a checkout release breaks payments:
- The incident opens on the 4th complaint, 18 seconds after the first.
- The Investigator names `checkout-service v4.21.7` with 97% confidence: released 14 minutes before the first complaint, after which its error rate jumped more than 8×.
- 8 tickets are linked, and 23 customers are affected, 15 of whom never wrote in.
- A ₹11,500 credit goes to a human for approval.

Every one of the 42 tool calls is recorded in a hash-chained audit log.

## How we built it

- **All TypeScript:** a pnpm monorepo with shared zod contracts, a pure engine, sandbox adapters, a Hono server and a React UI.
- **Detection:**
  - Sentence embeddings from `all-MiniLM-L6-v2`, running locally through transformers.js with no external API.
  - Similarity is half meaning and half product area, where the product area is itself inferred from meaning, with no keyword lists.
  - Tickets phrased as questions are recognised by their form.
- **Agents:** five agents with separate identities. Every tool call goes through a policy gate, which checks the allow-list, the authority level (which can depend on the arguments) and consent, and writes one audit entry.
- **MCP:** an MCP server at `/mcp`. Each bearer token is one identity and sees only its own tools. When the Pattern Agent's token tries to write, the call is refused and audited.
- **UI:** a new incident console in React, driven by a live event stream. It has four pages (incident, tickets, agents, governance) and light and dark themes. Every number on screen is computed.
- **Evaluation:** 60 seeded runs over six kinds, with the paraphrase pools split so that no tuning sentence appears in the test.
  - Results on the held-out test split: incident precision 100% (15 of 15), recall 100% (15 of 15), linking precision 100% and recall 99%, median detection at the 4th complaint, and the root cause correct in every caught incident.
  - A stress test of mixed delivery complaints opens an incident in 10 of 20 runs, and we report that as a limit.
- **Testing:** 196 tests and CI on every push.

## How it evolved from Stage 1

**Stage 1 was a scripted prototype.** A single HTML page played a 12-second animation, and its numbers (89% correlation, 91% confidence) were typed into the page. **Stage 2 is the real system:**
- Correlation, confidence, affected counts and credits are all computed from data.
- The agents make real tool calls through a real permission gate.
- The Stage 1 page is archived unchanged in the repo, with a list of exactly what was scripted.

## What isn't wired yet

External APIs (Freshdesk, GitHub deployments, Razorpay status, ElevenLabs, Claude and the sponsor APIs) are designed behind ports and listed in `.env.example`, but not wired. The demo runs on a sandbox world: releases, gateway status, error rates and orders come from the scenario. The environment box in the UI's sidebar says exactly which parts are live.

## Challenges we ran into

- **Different words, same failure.** Plain sentence embeddings scored short complaints about the same failure at only about 0.44 similarity. Adding the product-area half raised the separation of labeled pairs (AUC) from 0.94 to 1.00.
- **Restraint.** A burst of checkout *questions* looks like a checkout outage. Recognising questions by their form, and gating on failure share, keeps it from firing.
- **Honest numbers.** Every score had to trace back to data and a formula, so there are no hardcoded percentages.

## Accomplishments that we're proud of

- The restraint scenario: CrisisCrew refuses to open an incident and says why.
- Calibrated authority: the same tool (`issue_recovery_credit`) is L2 below ₹5,000 and L3 above it.
- An MCP client with a read-only token is refused, and the refusal is in the audit log.

## What we learned

Detecting incidents from support tickets depends as much on *not* firing as on firing. Every gate needs a reason a human can read.

## What's next

- Wire Freshdesk (webhook ingest, then replies through Freshdesk's MCP server), GitHub deployments and Razorpay status first.
- Then ElevenLabs voice updates, Claude for investigation narratives, and Sarvam translation for Hindi and Hinglish tickets.
- Register the MCP server in Freshworks Agent Studio.
- Learn thresholds per product area from confirmed and rejected incidents.

## Built With

`typescript` · `node.js` · `react` · `vite` · `hono` · `zod` · `model-context-protocol` · `transformers.js` · `vitest` · `multi-agent-systems` · `agentic-ai`

Remove `fastapi`, `python` and `tailwindcss`: none of them is used anywhere in the project.
