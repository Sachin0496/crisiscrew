# Main Stage demo script

A 5-minute flow, with a 3-minute cut at the end. Every beat runs on the real engine in sandbox mode, offline. The commands and the four typed complaints below were rehearsed against the server on 2026-09-23.

## Before going on stage (10 minutes)

1. Plug the laptop in and close everything else. The server stays near 400 MB with the embedding model loaded.
2. In `.env`, set fixed MCP tokens so the terminal commands don't change between runs:
   ```bash
   MCP_TOKEN_PATTERN=pattern-demo-token
   MCP_TOKEN_OPERATOR=operator-demo-token
   ```
   Leave `ADMIN_TOKEN` and `APPROVER_TOKEN` empty so the UI never asks for a token on stage. That's fine on a laptop that isn't exposed to the internet.
3. Start the production build (not the dev server):
   ```bash
   pnpm start
   ```
4. Open http://localhost:8787 in the browser, full screen at 110–125% zoom, in light mode (the sidebar's theme switch). The **Sandbox environment** box at the bottom of the sidebar should read **1 live · 6 sandbox · 3 off**: the embedding model is live, and every other port is sandbox or off.
5. Open a terminal beside the browser in the repo folder, with the two MCP commands from beat 5 pasted in and ready.
6. Warm-up run: click **Run replay** on the hero once and let it finish. Then click **Live mode** to clear it. The first typed complaint after a restart loads the model, which takes about a second.

## The 5-minute flow

### 1. The problem (0:00–0:30)

> "Customers notice outages before dashboards do. When a release breaks checkout, the first signal is a few support tickets, in different words, within a minute. An agent sees them one at a time. CrisisCrew reads them as incident telemetry."

### 2. The hero: detect, investigate, recover (0:30–2:15)

Stay on the **Incident** page. In the top bar, choose **Checkout release v4.21.7 breaks payments**, set **2×**, and click **Run replay**.

Point at the screen as it happens:
- **Incoming tickets** (right): each ticket is tagged with its product area and marked as a failure report or a question. The first three are ordinary questions and stay out.
- **Detection** (left): the similarity bar and the four gates. "My checkout keeps loading forever", "UPI isn't working", "Payment failed but bank shows debit": no shared keywords.
  > "Similarity is half meaning, from a sentence-embedding model running on this laptop, and half product area. The fourth complaint passes all four gates: 4 failures in 18 seconds is about 1 in 4 million at normal volume."
- **The header and stepper:** the incident opens as **Checkout and payment failures**, high severity. The Investigator and the Recovery Agent start in parallel, as **Agent activity** shows.
- **Root cause:** the ranking.
  > "97% for checkout-service v4.21.7. It shipped 14 minutes before the first complaint (likelihood ratio 6), and its error rate jumped more than 8 times. The payment gateway is ruled out: it reports operational, and the complaints span UPI and cards. Every factor is shown; the model doesn't just announce a number."
- **Customer impact:** 8 linked tickets and 23 affected customers, 15 of whom never wrote in. Each customer is updated through a channel they agreed to. The two voice updates show as *prepared*, because voice isn't wired.

### 3. The human decision (2:15–2:45)

The amber **Decision required** card shows ₹11,500 (23 × ₹500) against a ₹5,000 authority limit.

> "The same tool, issue_recovery_credit, is L2 below ₹5,000 and L3 above it. Authority depends on the arguments, not just the agent."

Type `5000` in **Other amount in ₹** and click **Modify**. The Handoff Agent issues exactly ₹5,000, the stepper reaches **Mitigated**, and the gate would refuse the original ₹11,500.

### 4. Restraint (2:45–3:30)

Choose **Look-alike burst: checkout questions**, set **10×**, and click **Run replay**.

> "Five questions about paying at checkout, and one real failure. Same product area, similar words. A naive system pages someone."

The **Detection** card refuses, in plain words: **4 of 5 are questions, not failures**. (If asked why 5 and not 6: the coupon question is tagged refunds and billing, so it falls outside the group.)

> "Every team shows success. We're showing what it refuses to do, and why."

### 5. Governance: the read-only agent can't write (3:30–4:15)

Open **Governance** in the sidebar. The badge shows the audit chain verified, and the **Permissions** table below the log shows who may call which tool.

In the terminal, the read-only operator token lists its tools. Only the five read tools come back:
```bash
curl -s http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer operator-demo-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Now the Pattern Agent's token tries to write:
```bash
curl -s http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer pattern-demo-token' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"link_ticket_to_incident","arguments":{"ticketId":"T-1001","incidentId":"INC-2026-001"}}}'
```
The reply is **Refused by the CrisisCrew policy gate: Pattern Agent is not allowed to call link_ticket_to_incident**. The refusal appears at the top of the audit log, highlighted in red. Click **Refused** to show only refusals.

> "MCP clients go through the same gate as our own agents. What they can't do, they can't do, and it's on the record."

### 6. The numbers, and the honesty (4:15–5:00)

> "We didn't tune this to one example. On 60 generated runs with a held-out test split: 100% precision and recall on incidents, detection at the median 4th complaint, and the right root cause every time. It's synthetic data, and the report says so. Our known weak spot: several *different* delivery problems at once open an incident in half the runs."

> "Stage 1 was a scripted prototype. This is the real system. The Freshdesk, GitHub, Razorpay and ElevenLabs integrations are designed and listed. The environment box shows what's live today: the engine, the agents, the gate and the model. The world they act on is a sandbox."

## The 3-minute cut

Do beats 1 and 2 at **4× speed**, click **Approve** in beat 3, and do beat 5 with only the refusal command. Mention beat 4 and the numbers in one sentence each.

## Optional: a live typed burst (60–90 seconds)

Click **Live mode**, then type these four complaints into the box at the bottom of **Incoming tickets**, clicking **Send** after each, within about five minutes. They were rehearsed and open an incident on the fourth, naming checkout-service v4.21.7 at 97%:

1. `The payment page just spins after I click pay.`
2. `Paid with UPI, money gone from my account, but the app says order failed.`
3. `My debit card keeps getting declined at checkout even though it works everywhere else.`
4. `Checkout crashes when I try to pay for my cart.`

If a judge offers a sentence, type it first. A question such as "Do you accept American Express cards?" is tagged as a question, and it never becomes one of the incident's tickets.

## If something goes wrong

| Problem | What to do |
|---|---|
| The browser shows "reconnecting" | Wait two seconds; the stream resumes from the last event. Refresh if it doesn't |
| A replay seems stuck | Click **Live mode**, then run the replay again. Each run is a fresh session |
| The server won't start | Read the one-line message. It names the variable to fix (for example, a live adapter that isn't wired) |
| No network at the venue | Nothing changes: the demo is offline once the model is in `.models/` |
| The UI is unusable | Run `pnpm replay checkout-v4.21.7` in the terminal. It prints the same story, beat by beat |

## Likely questions

- **"Is this live or scripted?"** The engine, agents, gate and model are live. The world they read (releases, gateway status, error rates, orders) is a sandbox scenario, and the environment box in the sidebar says so; click it for each port's detail. Every number is computed; `pnpm eval` reproduces them.
- **"Why not keywords?"** "Checkout keeps loading", "UPI isn't working" and "card rejected" share no keywords. Plain embeddings alone scored them about 0.44; adding product area separates labeled pairs completely (AUC 1.00). See [calibration.md](calibration.md).
- **"How do you avoid false alarms?"** Four gates, each with a plain reason, and questions recognised by their form. In the eval, none of the 15 no-incident test runs fired.
- **"Where does 97% come from?"** Prior × likelihood ratios, normalised across hypotheses, with every factor on screen. The priors are stated assumptions, not learned, and the doc says so.
- **"Where's the LLM?"** Detection uses a local sentence-embedding model. Claude is designed in for investigation narratives and message drafts, but it's not wired in this build, and it would never compute the scores.
- **"How would it plug into Freshdesk?"** A Freshdesk automation webhook sends the ticket id; replies and private notes go through Freshdesk's MCP server or REST. It's designed in detail (design section 10.5), and the variables are in `.env.example`.
- **"Hindi or Hinglish tickets?"** Not yet: the current model is English-only. The multilingual model and Sarvam translation are the plan.
- **"Privacy?"** The audit log keeps references and summaries, not ticket text. Voice needs voice consent, and proactive messages need proactive consent.
- **"When did you build this?"** Before the event, as the organizers allowed by email. The git history shows every step.
