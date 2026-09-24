# Main Stage demo script

A 5-minute flow, with a 3-minute cut at the end. Every beat runs on the real engine in sandbox mode, offline. The optional Freshdesk beat needs the team's Freshdesk trial and a tunnel (see [prep-checklist.md](prep-checklist.md)). The flow was run end to end against the server on 2026-09-24.

**The story in one line:**
> Most incident tools tell engineering what broke. Support tools tell you who complained. CrisisCrew connects the two, and measures success by Recovery Coverage, not by whether the alert fired.

## Before going on stage (10 minutes)

1. Plug the laptop in and close everything else. The server stays near 400 MB with the embedding model loaded.
2. In `.env`, set fixed MCP tokens so the terminal commands don't change between runs:
   ```bash
   MCP_TOKEN_PATTERN=pattern-demo-token
   MCP_TOKEN_OPERATOR=operator-demo-token
   ```
   Leave `ADMIN_TOKEN` and `APPROVER_TOKEN` empty so the UI never asks for a token on stage. That's fine on a laptop that isn't exposed to the internet. If Freshdesk is switched on through a tunnel, set both.
3. Start the production build (not the dev server):
   ```bash
   pnpm start
   ```
4. Open http://localhost:8787 in the browser, full screen at 110–125% zoom, in light mode. The environment box at the bottom of the sidebar reads:
   - **1 live · 7 sandbox · 3 off** in sandbox mode;
   - one more live port for each Freshworks adapter you switched on.
5. Open a terminal beside the browser in the repo folder, with the MCP commands from beat 5 ready.
6. Warm-up run: click **Run replay** on the hero once and let it finish. Then click **Live mode** to clear it. The first typed complaint after a restart loads the model, which takes about a second.

## The 5-minute flow

### 1. The problem (0:00–0:30)

> "When a release breaks checkout, support sees a few complaints. Engineering sees an error rate. Nobody sees the customers: who was actually harmed, who stayed silent, and whether each one got the right recovery. CrisisCrew is a customer harm response layer for Freshworks."

### 2. Who was harmed, and who stayed silent (0:30–2:30)

Stay on the **Incident** page. In the top bar, choose **Checkout release v4.21.7 breaks payments**, set **2×**, and click **Run replay**.

As it happens, point at:
- **Incoming tickets** (right): complaints in different words. The fourth one opens the incident.
  > "Detection is the trigger, not the product. Four complaints in 18 seconds, and the Investigator ties it to the checkout release 14 minutes earlier: 97%, with every factor shown."
- **Customer impact** (left), the hero:
  > "8 customers complained. CrisisCrew found 15 more whose payments failed in the same window but who never contacted support. A complaint alone never counts as harm: every one of these 23 has a failed payment on record."
- Click **Ananya Iyer** in the table. The **Customers** page opens her evidence chain:
  > "Her ₹12,999 card payment failed; the affected service is checkout; the likely cause is v4.21.7; it's inside the incident window; and she never contacted support. Confirmed, and silently affected."
- Her **Recovery** plan: a proactive message (done), a voice update (prepared, because voice isn't wired), and a ₹1,000 credit **waiting for approval**.
  > "Every action has a reason. She's a priority customer, so her credit is above the ₹500 the agents may give one customer alone."
- Go back to **Incident**. **Recovery coverage: 21/23 (91%)**, with 2 needing a human.
  > "Twenty-one customers are already recovered within policy: ₹200 credits, updates through the channel each one agreed to, account notes for the three who opted out of messages. Nisha paid on a retry, so she gets the update and no credit."

### 3. The human decision (2:30–3:15)

In the amber **Decisions required** card:
- Click **Approve ₹1,000** for Ananya Iyer.
- For Farhan Qureshi, type `500` in **Other amount in ₹** and click **Modify**.

Coverage reaches **23/23**, and the stepper reaches **Recovered**.

> "Money stays governed. Each approval is for one customer, and only the approved amount can be paid, only to that customer. The gate would refuse Farhan's original ₹1,000. And the incident couldn't be marked recovered while anyone was still waiting."

### 4. Restraint (3:15–3:45)

Pick one:
- **No evidence, no money.** Click **Live mode**. Type the four complaints from the live typed burst below as Priya K., Arjun K., Sneha M. and Varun N. Then type one more as `A Judge`.
  > "A judge's complaint joins the incident, but no failed payment is on record for them. So they get an acknowledgement asking for a payment reference, and no credit. Not verified."
- **Similar words, not an incident.** Choose **Look-alike burst: checkout questions**, set **10×**, and click **Run replay**. The **Detection** card refuses in plain words: *4 of 5 are questions, not failures*.

### 5. Freshworks-native (3:45–4:30)

**If Freshdesk is switched on** (`TICKETS=freshdesk`):
1. In Freshdesk, create a ticket as requester `priya.k@example.com`: "My checkout keeps loading forever." Do the same as `arjun.k@example.com`, `sneha.m@example.com` and `varun.n@example.com`. The four rehearsed sentences below work.
2. The incident opens in CrisisCrew.
3. Open Priya's Freshdesk ticket:
   - the CrisisCrew private note links the incident;
   - the update is the reply;
   - the outcome note lists her evidence and credit;
   - the **CrisisCrew sidebar** shows her impact, evidence, recovery and the incident's coverage.

**Otherwise, show MCP.** An Agent Studio agent, or any MCP client, sees the same incident customer by customer. The read-only operator token lists seven read tools, including the customer impact ones:
```bash
curl -s http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer operator-demo-token' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_recovery_coverage","arguments":{}}}'
```
And the read-only Pattern Agent's token can't write:
```bash
curl -s http://localhost:8787/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer pattern-demo-token' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"link_ticket_to_incident","arguments":{"ticketId":"T-1001","incidentId":"INC-2026-001"}}}'
```
The reply is **Refused by the CrisisCrew policy gate**, and the refusal is at the top of **Governance**.

### 6. The close (4:30–5:00)

> "We measure success by Recovery Coverage: every affected customer covered, not whether the alert fired. Low-risk recovery runs automatically; money above authority stops for a human, one customer at a time. And we're honest about what's live: the engine, the agents and the gate are real. The world they act on (orders, releases, payments) is a sandbox, and the environment box says so. Freshdesk and Freshservice are wired and switch on with keys."

## The 3-minute cut

Do beat 1 in one sentence. Do beat 2 at **4× speed**, with one click into Ananya's evidence chain. Then do beat 3 (approve both), and end with beat 6. Mention restraint in one sentence.

## Live typed burst (60–90 seconds)

Click **Live mode**, then type these four complaints into the box at the bottom of **Incoming tickets**. Pick the customer from the name suggestions, and click **Send** after each one. They open an incident on the fourth, naming checkout-service v4.21.7 at 97%. The customers are confirmed from their payments, and 19 silent customers are found.

| Customer | Complaint |
|---|---|
| Priya K. | `The payment page just spins after I click pay.` |
| Arjun K. | `Paid with UPI, money gone from my account, but the app says order failed.` |
| Sneha M. | `My debit card keeps getting declined at checkout even though it works everywhere else.` |
| Varun N. | `Checkout crashes when I try to pay for my cart.` |

If a judge offers a sentence, type it under their own name: it will show as **Not verified**, which is the point. A question such as "Do you accept American Express cards?" is tagged as a question, and it never joins the incident.

## If something goes wrong

| Problem | What to do |
|---|---|
| The browser shows "reconnecting" | Wait two seconds; the stream resumes from the last event. Refresh if it doesn't |
| A replay seems stuck | Click **Live mode**, then run the replay again. Each run is a fresh session |
| The server won't start | Read the one-line message. It names the variable to fix, for example Freshdesk keys that are missing |
| Freshdesk doesn't deliver the webhook | Switch to `FRESHDESK_INGEST=poll` and restart: it reads new tickets every 15 seconds without a public URL |
| No network at the venue | Nothing changes in sandbox mode: the demo is offline once the model is in `.models/` |
| The UI is unusable | Run `pnpm replay checkout-v4.21.7` in the terminal. It prints the same story, beat by beat |

## Likely questions

- **"Isn't this ticket clustering?"** Clustering is the trigger. The product is what happens after harm begins:
  - proving who was harmed from operational evidence;
  - finding the customers who never complained;
  - recovering each one by their own harm;
  - measuring coverage.
- **"How do you know the silent customers were affected?"** Each one has a failed or pending payment inside the incident window, on the service the incident is about. The evidence chain on the Customers page shows it customer by customer. A complaint without that evidence is *not verified*, and nobody is credited on a ticket alone.
- **"Who decides the credits?"** The policy in `config/policy.json`: ₹200 for a failed payment, ₹1,000 for priority customers or payments of ₹10,000 or more, and nothing for customers who paid on a retry. The agents may give ₹500 per customer and ₹5,000 per incident; everything above waits for a human, per customer.
- **"Is this live or scripted?"** The engine, the agents, the gate and the model are live, and every number is computed. The orders, releases and gateway status are a sandbox world. Freshdesk and Freshservice adapters are wired and tested against fakes of their APIs; they go live with keys. The environment box says which is which.
- **"Where does 97% come from?"** Prior × likelihood ratios, normalised across hypotheses, with every factor on screen. The priors are stated assumptions.
- **"Where's the LLM?"** Detection uses a local sentence-embedding model. Recovery is policy, not generation. Claude is designed in for narratives and drafts, but it's not wired, and it would never compute the numbers or decide money.
- **"How would it run in production?"**
  - Freshdesk tickets arrive by webhook.
  - The orders port reads the commerce platform instead of the sandbox.
  - Notes and replies go back through Freshdesk's REST API or its MCP server.
  - Engineering gets a Freshservice incident.
  - Agent Studio agents read the same incident through MCP.
- **"Privacy?"** The audit log keeps references and summaries, not ticket text. Proactive messages need proactive consent, voice needs voice consent, and customers who opted out get an account note instead of a message.
- **"When did you build this?"** Before the event, as the organizers allowed by email. The git history shows every step.
