# Hackathon compliance

CrisisCrew is a Track 1 finalist in The Great Agent Hackathon (Freshworks). This page checks the project against the hackathon's published rules and the organizers' later instructions. It lists what's met and what the team still has to do before submitting.

- **Checked on:** 2026-09-23, and updated on 2026-09-24 for the Customer Harm Response pivot ([issue #1](https://github.com/Sachin0496/crisiscrew/issues/1))
- **Sources:** the [rules](https://the-great-agent-hackathon.devpost.com/rules) and [overview](https://the-great-agent-hackathon.devpost.com/) pages on Devpost (read on 2026-09-22, and the rules re-checked on 2026-09-23), plus the organizers' email to finalists described in section 1.
- **Caveat:** rules can change. Re-read both pages, and any new organizer email, on the morning of the event.

## Summary

| Requirement | Status | Evidence or action |
|---|---|---|
| Built from scratch and unique to this hackathon | **Met** | Every line of code was written for this hackathon. The repo's first commit is on 2026-09-22, and the Stage 1 page is archived unchanged in `prototype/` |
| When the build happens | **Met under the organizers' email** | The written rules put the build inside the on-site sprint. The organizers then told finalists they may work beforehand and that Stage 2 is mostly presentation. See section 1 |
| A working prototype, ready to demo live | **Met** | `pnpm start` runs the whole system offline, with six replayable scenarios, live typed complaints and per-customer recovery. See the [demo script](demo-script.md). The rules also say "built during the 24-hour window"; the organizers' email covers that (section 1) |
| An updated project description (what was built, the stack, how it evolved) | **To do: team** | A ready-to-paste draft is in [submission.md](submission.md) |
| A public code repository with a clear README | **To do: team** | The README is written, but the repo is still **private**. Make it public before submitting (section 2) |
| A live demo on the Main Stage | **Ready** | [demo-script.md](demo-script.md) |
| Physically present in Bangalore for the whole event | **Team** | Remote participation isn't allowed at Stage 2 |
| Track 1: Agent Studio, MCP and multi-agent orchestration | **MCP and multi-agent: met. Freshdesk and Freshservice: wired, not yet run on a live account. Agent Studio: MCP-ready, registration needs access** | See section 3 |
| Sponsor prizes (ElevenLabs, Sarvam, Dodo, Vobiz, AWS, Anthropic) | **Not claimable yet** | Each API is designed and listed in `.env.example` but not wired. Don't claim a sponsor's technology unless it's wired at the event |
| No misleading claims | **Met in the repo. Devpost needs fixing** | Section 5 |

## 1. When and how the project was built

**The written rule.** Past ideas may be referenced, but the Stage 1 material and the Stage 2 project must be original work for this hackathon. The rules page adds: "The build needs to be from scratch during the hackathon." It describes Stage 2 as a 24-hour build on site.

**What the organizers said later.** Before the event, the organizers emailed finalists. They said teams may work on their projects beforehand, and that Stage 2 won't be a 24-hour build: it's mostly presentation. The team built the system before the event on that basis.

**What that means for CrisisCrew:**
- **From scratch:** met. Nothing was copied from an earlier project. The code, scenarios, calibration and eval were all written for this hackathon, starting on 2026-09-22.
- **Timing:** acceptable only because of the email. The git history is the evidence and shows exactly when each part was built. The README says so openly rather than hiding it.
- **Action:** keep the organizers' email where you can show it, in case a judge asks when the code was written. If the organizers say anything that narrows the permission, follow the newer instruction.

## 2. Submission requirements

1. **A working prototype, ready to demo live.** Met. The server, API, MCP endpoint and UI run from one command, with no keys and no network once the embedding model is on disk. The rule's words are "built during the 24-hour window"; as with the from-scratch timing, the organizers' email covers building it beforehand.
2. **An updated project description.** The team pastes the draft from [submission.md](submission.md) into Devpost. It covers what was built, the stack, how the project evolved from Stage 1, and what isn't wired yet.
3. **A public repository with a clear README.** The README covers what CrisisCrew does, how to run it, how it works, what's real and what's sandbox, the results, and the limits. The repo is private today. To make it public (the team does this, not an agent):
   ```bash
   gh repo edit Sachin0496/crisiscrew --visibility public --accept-visibility-change-consequences
   ```
4. **A live Main Stage demo.** A timed stage flow with fallbacks is in [demo-script.md](demo-script.md).

## 3. Track 1 fit

Track 1 asks for agents built on Freshworks Agent Studio, MCP and multi-agent orchestration.

| Element | Status | Where |
|---|---|---|
| Multi-agent orchestration | **Built.** Five agents with separate identities and permissions. The Investigator and Recovery Agent run in parallel, and the Handoff Agent stops for a human above the authority limit | `packages/core/src/agents/`, design section 6 |
| MCP | **Built.** An MCP server at `/mcp`. Each bearer token maps to one identity, which sees only its allowed tools, and every call goes through the same policy gate and audit log as the internal agents | `apps/server/src/mcp/endpoint.ts`, README "MCP" |
| Freshworks: Freshdesk | **Wired, not yet run on a live account.** Webhook or poll ingest (requesters matched to customers by email); private link notes, replies and outcome notes through REST or Freshdesk's official MCP server; a ticket-sidebar app. Each is tested against a fake Freshdesk API or MCP server | `packages/adapters/src/freshworks/`, `integrations/freshdesk-sidebar/`, [customer-harm-response.md](customer-harm-response.md) section 6 |
| Freshworks: Freshservice | **Wired, not yet run on a live account.** An engineering incident per CrisisCrew incident, with private notes for the investigation and the customer impact | `packages/adapters/src/freshworks/freshservice.ts` |
| Freshworks: Agent Studio | **MCP-ready.** The read-only operator identity exposes `get_customer_impact` and `get_recovery_coverage` alongside the other read tools. Registering `/mcp` in Freshservice's Agent Studio MCP Gateway is a configuration step once the organizers provide access | README "MCP server" |

**On stage, say it plainly:**
- The Freshdesk and Freshservice adapters are wired and switch on with keys, and the demo world is a sandbox.
- If they ran against the team's trial account at the event, say so. If they didn't, say they're tested against fakes of the APIs.

The environment box in the UI's sidebar shows exactly this.

## 4. Judging criteria: where each one is shown

| Criterion | What demonstrates it |
|---|---|
| Innovation and originality | Customer harm response instead of ticket clustering. It proves who was harmed from operational evidence, finds the customers who never complained, plans each customer's recovery by their own harm, and measures Recovery Coverage. A complaint alone never counts as harm |
| Technical execution | Typed contracts shared by server and UI, an event-sourced UI, an idempotent recovery pass, 256 tests, CI, a hash-chained audit log, an evaluation on a held-out split, and Freshworks adapters tested against fakes of their APIs |
| Use of AI and agentic design | Sentence embeddings running locally. Five agents with calibrated authority: credits are L2 within ₹500 per customer and ₹5,000 per incident, and L3 above, one approval per customer. The same gate governs internal agents and MCP clients, and the Recovery Agent writes to Freshdesk through its MCP server when switched on |
| Relevance to the problem | The hero scenario: a checkout release breaks payments. 23 customers were harmed: 8 complained and 15 stayed silent. 21 recover within policy, and 2 priority customers' credits go to a human; coverage reaches 23/23 after the decisions. The outcome is written back to each Freshdesk ticket |
| Presentation and demo quality | A production-style console driven by live events. It has a Customers page with a clickable evidence chain for every customer, per-customer decisions, coverage climbing to 100%, the restraint scenario, an unverified walk-in complaint, and the Freshdesk sidebar |
| Potential impact | Nobody left behind: silent customers found and recovered, money spent by the harm rather than by the ticket, human approval where it matters, and a coverage number a support leader can run the business on |

## 5. Honest claims: Stage 1 and the Devpost page

**Stage 1 was a scripted prototype.** Its numbers were typed into the page, and it made no network calls. [prototype/README.md](../prototype/README.md) lists exactly what was scripted. The updated description should say this in one sentence; the draft in [submission.md](submission.md) does.

**"Built With" on Devpost.** As read on 2026-09-22, the tags were: `fastapi`, `python`, `react`, `typescript`, `vite`, `tailwindcss`, `agentic-ai`, `multi-agent-systems`, `model-context-protocol`.
- `react`, `typescript`, `vite`, `model-context-protocol`, `agentic-ai` and `multi-agent-systems` are now true.
- **Remove `fastapi`, `python` and `tailwindcss`.** None of them is used anywhere in the project.
- Don't add `elevenlabs`, `anthropic`, `sarvam` or `dodo`: they aren't wired. Add `freshdesk` and `freshservice` only if they ran against a real account at the event.
- **Add:** `node.js`, `hono`, `zod`, `transformers.js`, `vitest`.

**Inside the product:**
- No number on screen is typed in. Each one is computed from ticket text and the scenario's data.
- `GET /api/wiring` and the environment box in the UI report every port as live, sandbox or off, with the live adapters that are available and the ones only planned.
- Selecting an unwired adapter, or a wired one without its keys, stops the server at startup with a clear message. A live adapter never falls back to fake data.
- The eval report states that its data is synthetic and hand-written.

## 6. Third-party material and licenses

- **Code:** original, under the [MIT license](../LICENSE).
- **Dependencies:** open-source npm packages under permissive licenses: Hono, @hono/node-server, zod, @modelcontextprotocol/sdk, React, Vite, Vitest, tsx and onnxruntime-node (all MIT); TypeScript and @huggingface/transformers (Apache-2.0); lucide-react icons (ISC).
- **Embedding model:** `all-MiniLM-L6-v2` from sentence-transformers (Apache-2.0), in its ONNX conversion `Xenova/all-MiniLM-L6-v2`. It's downloaded at run time into `.models/`, which git ignores, and isn't committed.
- **UI:** designed for Stage 2. The Stage 1 page is kept only as a record, in `prototype/`.
- **Scenario and eval data:** hand-written for this project. Customer names, orders and releases are invented.

## 7. Secrets and personal data

- Secrets live only in `.env`, which git ignores. `.env.example` lists every variable with an empty value.
- A scan of every tracked file for API keys and tokens (Anthropic, GitHub, AWS, Freshworks-style keys and private keys) found none on 2026-09-24.
- **Freshworks keys:** only `apps/server/src/main.ts` reads the Freshdesk and Freshservice keys, and it hands them to the adapters. They never reach the UI, the audit log or the event stream.
- **The sidebar app:** its install parameters hold only the CrisisCrew host, not the API keys.
- Runtime data (audit logs, the runtime embedding cache) goes to `data/`, which git ignores.
- The audit log stores ticket and customer references and short summaries, not full ticket text.

## 8. Before submitting

- [ ] Make the repository public (section 2).
- [ ] Update Devpost: paste the description from [submission.md](submission.md), fix "Built With" (section 5), and add the repo link.
- [ ] Keep the organizers' email ready to show.
- [ ] Re-read the rules page for changes.
- [ ] If Freshdesk or Freshservice ran against a real account at the event:
  - change "wired, not yet run against a real account" to "run against a live trial account" in the README's status note and table;
  - add the `freshdesk` and `freshservice` tags on Devpost.
- [ ] If any other API gets wired at the event, update the README's status table, `.env.example` and the Devpost tags to match. Claim only what's wired and shown.
