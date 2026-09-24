# Customer Harm Response: design for the pivot

Written on 2026-09-24 for [issue #1](https://github.com/Sachin0496/crisiscrew/issues/1). It covers how CrisisCrew moves from "detect outages from similar support tickets" to **Customer Harm Response for Freshworks**, and what that changes in the engine, the integrations and the UI. The [Stage 2 design](design.md) still describes detection, root cause and the policy gate, which don't change.

## 1. The thesis

> Don't just detect an incident. Prove who was harmed, find the customers who stayed silent, and make sure every affected customer gets the right recovery.

- **Freshdesk** is the customer signal layer: the complaints.
- **Freshservice and engineering systems** are the operational evidence layer: releases, gateway status, error rates, orders.
- **CrisisCrew** joins the two into a **Customer Impact Graph** and runs governed recovery until **Recovery Coverage** reaches 100%.

**The primary output** changes from "an incident exists" to:

> 23 customers were affected. 8 complained. 15 stayed silent. Here is the evidence for each customer, the recommended recovery, who may carry it out, and who still needs attention.

**Detection stays, but it's the trigger, not the product.** The Pattern Agent, its four gates and the root-cause ranking are unchanged. The UI moves them below the customer impact.

## 2. Customer Impact Graph

### 2.1 Nodes and edges

| Node | Where it comes from |
|---|---|
| Incident | the engine |
| Cause: a release, or a payment provider | the Investigator's ranking |
| Service | the service catalog for the incident's product area |
| Customer | the orders port: name, tier, consent, email |
| Payment attempt | the orders port: time, method, amount, outcome |
| Ticket | the tickets port (Freshdesk, replay or typed) |
| Recovery action | the Recovery Agent's plan |

Each affected customer carries **evidence edges**. An edge has a kind, a sentence a human can read, a time, the node it points to, and the adapter that supplied it:

| Edge | Example |
|---|---|
| `payment_failed` / `payment_pending` | "Card payment of ₹12,999 failed at 14:07:12" → `attempt:s03:…` |
| `payment_succeeded` | "Paid ₹1,099 by card at 14:10:00, on a retry" |
| `service` | "Affected service: checkout-service" → `service:checkout-service` |
| `cause` | "Likely cause: checkout-service v4.21.7 (97%)" → `cause:deploy:checkout-service@4.21.7` |
| `window` | "Inside the incident window: since 13:58 (the v4.21.7 release)" |
| `reported` / `no_ticket` | "Opened T-1004 at 14:12:45" or "Never contacted support" |
| `no_payment` | "No failed or pending payment on record since 13:58" |

`GET /api/incidents/:id/graph` returns the graph as nodes and edges. The MCP tool `get_customer_impact` returns the same thing per customer.

### 2.2 Who counts as affected

Customer impact is **independent of ticket membership**:

- **Confirmed:** the customer has a failed or pending payment inside the incident window. Whether they wrote in only decides the channel we use.
- **Not verified:** the customer filed a failure report in the incident, but no failed or pending payment is on record. They get an acknowledgement on their own ticket, asking for a payment reference. They are **never credited or contacted proactively**, and they stay out of the coverage denominator.
- **Not affected:** a question in the burst, or a ticket with no failed payment and no failure report.

The window starts at the root cause's start (for example, the release time), or 30 minutes before the first complaint when the cause has no start time. It runs to now.

### 2.3 Severity

Severity comes from evidence only:

| Severity | Rule |
|---|---|
| Low | the customer's payment went through on a later retry |
| High | a priority customer, or a failed payment of ₹10,000 or more |
| Medium | every other confirmed customer |

The thresholds live in `config/policy.json` (`recovery.highValueInr`).

## 3. Recovery policy, per customer

`plan_recovery` turns each customer's evidence into actions, each with a reason:

| Action | When | Authority |
|---|---|---|
| Ticket reply | they wrote in: the update goes on their ticket. Unverified customers get an acknowledgement instead | L2 |
| Proactive message | they didn't write in, and they agreed to proactive messages | L2 |
| Account note | they didn't write in and opted out of proactive messages: no message, but support sees what happened if they get in touch | L1 |
| Voice update | priority customers who agreed to calls (prepared while voice is off) | L2 |
| Goodwill credit | ₹200 for medium severity, ₹1,000 for high | L2 up to ₹500 per customer and ₹5,000 per incident; L3 above either |
| No credit | low severity (they paid on retry), or not verified | none: a recorded decision |

**Money stays governed.** `issue_recovery_credit` now takes one customer. It is:
- **L2** when the amount is within the per-customer limit (₹500) **and** the agents' running total for the incident stays within ₹5,000;
- **L3** otherwise, which needs an approved approval for exactly that customer and amount.

The gate also refuses a credit for a customer who isn't a confirmed affected customer, a second credit for the same customer, and any amount other than the one the plan (or the approver) set. The planner walks customers in a fixed order and escalates a credit once the incident budget would be exceeded, so the agents can't spread payments to get past the limit.

**The human decides per customer.** Each L3 credit becomes its own approval with that customer's evidence. The approver can approve, change the amount, or reject. Only the approved amount can be paid, and only to that customer.

**In the hero scenario**, 20 customers get ₹200 automatically (₹4,000). Ananya and Farhan are priority customers, so each ₹1,000 credit goes to a human. Nisha paid on a retry, so she gets the update but no credit. Pooja, Manoj and Lakshmi opted out of proactive messages, so they get an account note and a credit, and nobody messages them.

## 4. Recovery Coverage

A customer's recovery state comes from their actions:

| State | Meaning |
|---|---|
| Recovered | every action is done (a prepared voice script counts), or a human decided it |
| Needs a human | an approval is pending |
| In progress | actions are still planned or running |
| Needs attention | an action failed or was refused |
| Not verified | complained, but no failed payment on record |

```
Recovery coverage = confirmed customers who are recovered / confirmed customers
```

- The incident moves to **Awaiting approval** while any approval is pending.
- It reaches **Recovered** only when coverage is 100%. It can't be shown as recovered while any confirmed customer is unhandled.
- The UI shows coverage climbing as actions complete: 0 → 21/23 (91%), with 2 needing a human → 23/23 after the decisions.

It also tracks:
- the time from the first complaint to the incident;
- silent customers found;
- duplicate tickets avoided, meaning linked tickets handled as one incident;
- proactive contacts delivered;
- customers still unrecovered;
- recovery spend: issued within authority, approved by a human, and awaiting approval.

## 5. The engine

The Recovery Agent runs one idempotent **reconcile** step:
1. identify the affected customers;
2. plan the actions that are missing;
3. carry out every planned action within authority;
4. hand L3 credits to the Handoff Agent, which asks for approval.

The reconcile step runs:
- **after the root cause:** the first full pass;
- **for each later complaint:** a silent customer who writes in gets a ticket reply added to their plan, and a new customer is assessed and planned;
- **after each human decision:** the Handoff Agent carries out exactly the decision, and the incident status is recomputed.

After each step, the Incident Commander sets the incident's status from coverage: Recovering, Awaiting approval or Recovered.

There are no new named agents. The five agents keep their identities and levels. The blanket `propose_recovery_credit` is replaced by these tools:
- `plan_recovery` (L1)
- `add_account_note` (L1)
- `add_ticket_note` (L1): the outcome note on a Freshdesk ticket
- `get_customer_impact` and `get_recovery_coverage` (L0), which MCP clients can also call

## 6. Freshworks as the native workflow

Everything below runs in sandbox mode by default, and each live adapter is switched on by one variable. Each adapter was tested against a fake Freshworks API, because the team has no account yet. Nothing claims to be live until it has run against a real account.

**Freshdesk ingest** (`TICKETS=freshdesk`)
- **Webhook:** a Freshdesk automation rule on ticket creation POSTs `{"ticket_id": {{ticket.id}}}` to `/api/webhooks/freshdesk`, with the header `X-CrisisCrew-Secret`. CrisisCrew answers 202, then fetches `GET /api/v2/tickets/:id?include=requester`.
- **Poll fallback:** with `FRESHDESK_INGEST=poll`, it calls `GET /api/v2/tickets?updated_since=…&include=description` every 15 seconds.
- **Duplicates:** ingest is idempotent by Freshdesk ticket id.
- **Matching:** the requester's email is matched to a customer in the orders data. A requester who can't be matched is a real complaint with no payment evidence, so they're **Not verified**.

**Freshdesk write-back** (the same switch)
- A private note links each Freshdesk ticket to the incident.
- The customer's update is posted as a reply.
- Once their recovery completes, a private outcome note lists the evidence and what was done.
- Tickets from replays or the UI still go to the sandbox, so a mixed session works.

**Freshdesk MCP** (`FRESHDESK_ACTIONS=mcp`): the same notes and replies go through Freshdesk's official MCP server (`https://<domain>/mcp`) instead of REST. Because Freshdesk doesn't publish the tools' argument names, the adapter reads each tool's input schema at connection time.

**Freshdesk sidebar**
- `integrations/freshdesk-sidebar/` is a Freshworks app (platform 3.0, `ticket_sidebar`). For the open ticket, it shows the customer's impact status, evidence, recovery actions and the incident's coverage.
- It reads `GET /api/freshdesk/tickets/:id`, which needs CrisisCrew on a public HTTPS host (a Cloudflare tunnel works).

**Freshservice incident** (`INCIDENTS=freshservice`)
- The Incident Commander opens a Freshservice incident when the incident opens (`POST /api/v2/tickets`).
- It adds private notes with the root cause and with customer impact and coverage.
- In sandbox mode, the record is kept in memory and labeled as sandbox.

**Agent Studio and MCP**
- The read-only operator identity can call `get_customer_impact` and `get_recovery_coverage`.
- Any MCP client, including Freshservice's Agent Studio MCP Gateway once access is granted, sees the same live incident, customer by customer.

## 7. The UI

- **Sidebar:** Incident, **Customers**, Tickets, Agents and Governance. The product name reads "Customer harm response".
- **Incident page:**
  - **Key numbers:** customers harmed (complained vs silent), recovery coverage, root cause, recovery spend.
  - **Main column:** the Customer impact card leads, with the silent-customer callout and the per-customer table. Recovery coverage follows, then root cause, then detection.
  - **Side column:** the per-customer decisions queue, then tickets, timeline and agent activity.
- **Customers page:**
  - every affected customer, filterable by complained, silent, needs a human and not verified;
  - a detail panel with the customer's evidence chain, their recovery plan with a reason for each action, and the decision controls when a human is needed.
- **Ticket box:** the name field suggests the store's customers, so a typed complaint can come from a known customer, with payment evidence. Any other name is a walk-in and is Not verified.

## 8. Testing

- **Impact assessment:** confirmed, not verified, paid on retry, severity, and each evidence edge.
- **The planner:** every rule and its reason, and budget escalation.
- **Coverage states.**
- **The gate:** per-customer credit authority, the budget, exact amounts and per-customer approvals.
- **Lifecycle:**
  - The hero reaches 21/23 with two approvals, then 23/23 once both are decided.
  - A modified amount pays exactly that amount.
  - A rejection is recorded and still counts as handled.
  - A silent customer who later writes in gets a reply.
- **Freshdesk:** client auth and errors, webhook secret and idempotency, requester matching, the poller, write-back routing, and the MCP adapter against a fake MCP server.
- **Freshservice:** creating the incident and adding notes.
- **HTTP and MCP:** the new routes and tools.

## 9. What this doesn't do

- **No live account yet.** It isn't verified against a real Freshdesk or Freshservice account. The team switches the adapters on with keys at the event, and the wiring box says which ports are live.
- **Orders stay sandbox.** Payment attempts, customers and consent come from the scenario world. In a real deployment, the orders port would read the commerce platform.
- **No compensation without limits.** Credits above ₹500 per customer, or beyond ₹5,000 per incident, always stop for a human.
- **No new agents** and no extra sponsor APIs.
