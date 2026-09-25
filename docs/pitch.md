# CrisisCrew: the business case

For investors, judges and design partners. Every figure has a source, listed at the end. Anything that's our estimate is marked as an assumption. Figures were checked on 2026-09-25.

## In one line

**CrisisCrew is customer harm response.** When something breaks, it proves who was harmed, including the customers who never complained, and makes each of them whole within a policy the company sets. It stops for a human on money, and keeps an audit trail.

**The 20-second opening:**

> "When checkout breaks, engineering sees an error rate and support sees a handful of complaints. Neither sees the customers. Fewer than a third of unhappy customers ever tell you; the rest quietly spend less. CrisisCrew joins the incident to the payment data. It finds every customer who was actually harmed, the silent ones too, and recovers each one inside a policy you set, stopping for a human on money. We measure success by Recovery Coverage: the share of harmed customers made whole."

## 1. The problem, in numbers

**Outages are expensive, and getting more so.**
- High-impact outages cost a median of **$2M per hour**, and **$76M a year** per company. That's New Relic's 2025 Observability Forecast, from 1,700 IT leaders in 23 countries. [1]
- The CrowdStrike update of 19 July 2024 caused an estimated **$5.4B** of direct losses to the US Fortune 500. [2] Delta alone put its cost at about **$500M**. [2]

**Most of the harm is silent.** Qualtrics XM Institute surveyed about 24,000 consumers in 23 countries in 2024: [3][4]
- **fewer than a third** of consumers give feedback directly to a company;
- consumers are **8 points less likely to say anything** after a bad experience than in 2021;
- **53%** of bad experiences lead customers to cut their spending;
- bad experiences put **$3.8T** of global sales at risk.

**Broadcasting doesn't settle it.** Gartner found that **66% of B2C and 82% of B2B customers** contact customer service after proactive outreach, because the message didn't tell them enough. [5] A status-page "we had an issue" creates contacts. A specific "your ₹12,999 payment failed at 07:56, here's what we did" closes them.

**Regulators judge recovery, not detection.**
- After the CrowdStrike meltdown, the US Department of Transportation investigated whether Delta's **1.3 million** affected passengers got the refunds and reimbursements they were owed.
- It closed the probe in June 2026, once it found they had. [6]

**India, the beachhead:**
- UPI processed **18.3 billion** transactions in March 2025. [7]
- NPCI outages on 26 March and 12 April 2025 (the second lasted several hours) left users with failed payments, and some with debit alerts for payments that never went through. [7][8]
- Under RBI's turnaround-time framework, a failed transaction must be reversed on time (T+1 for UPI), or the bank pays the customer **₹100 a day**, automatically. [9]

## 2. Why now

1. **Customers are going quiet.** Complaint queues undercount harm more every year. [4]
2. **Regulation now asks firms to find and fix harm, customer by customer:**
   - **EU DORA** has applied since January 2025. Under Article 19(3), when a major ICT incident affects clients' financial interests, a financial entity must inform them "without undue delay", with the measures it took. [10]
   - **UK FCA Consumer Duty:** its March 2026 guidance on identifying and rectifying harm asks firms to quantify how many customers were affected, and put it right. [11]
   - **India, RBI:** automatic compensation for failed transactions. [9]
   - **US DOT:** enforces refunds after airline disruptions. [6]
3. **Agents can finally act, but companies won't let them touch money without governance.** Freshworks' own AI (Freddy) passed **$25M ARR** in Q4 2025. [12] Agent platforms and MCP put real tools in agents' hands. What's missing is the guard rail: allow-lists, authority limits, human approval above them, and an audit trail. That's what CrisisCrew is built around.
4. **The engineering side of incidents is crowded; the customer side is unowned.**
   - PagerDuty's fiscal 2026 revenue was **$492.5M**, with ARR up just **1%**: alerting is mature. [13]
   - New entrants compete on engineering response: incident.io raised a **$62M** Series B in April 2025, at a reported valuation of about **$400M**. [14]
   - Nobody owns what happened to the customers.

## 3. The gap: who knows what during an incident

| | Incident tools | Support suites and AI agents | Experience analytics | **CrisisCrew** |
|---|---|---|---|---|
| Examples | PagerDuty, incident.io, Rootly, FireHydrant, ServiceNow ITSM, Freshservice | Freshdesk, Zendesk, Salesforce Service Cloud, Intercom; Sierra, Decagon | Quantum Metric, FullStory, Contentsquare | |
| What broke | Yes | No | Partly (sessions with errors) | Yes, verified against releases, provider status and error rates |
| Who complained | Through integrations | Yes | No | Yes |
| **Who was harmed, proved from transactions** | No | No | Sessions, not payments | **Yes, with evidence per customer** |
| **The customers who stayed silent** | No | No | Only if they're in a session recording | **Yes** |
| A remedy per customer | No | One ticket at a time | No | **Yes, by the customer's own harm** |
| Pays within authority, stops for a human | No | No | No | **Yes, with a policy gate and per-customer approvals** |
| How success is measured | Time to resolve | Ticket SLAs | Conversion | **Recovery Coverage** |
| Audit trail for a regulator | The incident timeline | The ticket history | No | **Hash-chained, per action** |

**What the closest products do:**
- **PagerDuty Customer Service Operations** gives support agents visibility into incidents inside Zendesk or Salesforce, so they can update customers proactively. [15] It offers visibility and broadcast, not per-customer proof or remedy.
- **Status pages** (Atlassian Statuspage, incident.io) broadcast to everyone, including people who weren't affected, and do nothing specific for the people who were.
- **Helpdesk AI** (Freddy, Zendesk AI, Sierra, Decagon, Intercom Fin) answers the customers who write in: the minority.
- **Experience analytics** tools quantify friction and revenue at risk per session, for analysts. They don't run a governed remedy.

**The status quo:**
1. After a major incident, an analyst writes SQL to find the affected customers.
2. Finance approves a blanket coupon, and marketing emails everyone.
3. It takes days. It over-pays some customers, misses others, and leaves no record of who got what.

## 4. What we built

**Five agents, run as LangGraph workflows,** each with its own identity and authority:
1. **Detect:** a burst of complaints about one failure, behind four statistical gates.
2. **Verify:** against releases, payment-provider status and error rates. Every cause is ranked by prior × likelihood ratios.
3. **Prove harm:** the **Customer Impact Graph**. A customer is harmed when they have a failed or pending payment inside the incident window, whether or not they wrote in.
4. **Recover each customer:**
   - an update through the channel they agreed to;
   - an account note if they opted out;
   - a credit sized by their harm, automatic up to ₹500 each.

   Anything above that is an approval for one customer, with their evidence.
5. **Measure:** Recovery Coverage. The incident is recovered only at 100%.

**Freshworks-native:**
- Freshdesk tickets, with notes and replies written back;
- a Freshdesk sidebar app;
- Freshservice incidents for engineering;
- an MCP server that Agent Studio agents can call.

**Built to be trusted with money:**
- one policy gate on every action, and a hash-chained audit log;
- a prompt-injection guard on tickets and tool outputs, and an output guard on every customer message;
- a decision-model classifier (Laya), limited to bounded labels;
- a trace of every agent step, on the Traces page and in LangSmith.

## 5. Proof so far

**The hero scenario:**
- 23 customers harmed: 8 complained, 15 stayed silent.
- 21 recovered within policy, and 2 priority credits went to a human. After those decisions, 23 of 23 were recovered.
- 86 tool calls, all audited.

**Evaluations** (synthetic data, on held-out splits):

| Area | Result |
|---|---|
| Detection | 100% precision and recall (15 of 15 incidents) |
| Customer impact, over 30 generated worlds with distractors | 100% precision and recall; **100% silent-customer recall**; every harmed customer got exactly the policy's credit |
| Safety: 44 injected attacks and 51 direct attacks on the gate | **0** unauthorized actions, **0** wrong-customer credits, **0** policy bypasses |

**Recognition:** a Stage 2 finalist in Freshworks' Great Agent Hackathon.

**Not yet:**
- live customer data;
- design partners;
- revenue.

The next section is about getting there.

## 6. Who buys, and why

**Beachhead: high-volume digital businesses on Freshworks that take payments.** That means Indian e-commerce, quick commerce, fintech, travel and food delivery.
- **Their pain:** every payment incident brings a ticket surge, blanket refunds, silent churn and regulatory attention.
- **Why India first:** Freshworks' home market, UPI's scale and outages, and RBI's compensation rules.

**Buyers:**
- **Budget:** the head of CX or support.
- **Co-signers:** the head of engineering or SRE, and finance, which owns compensation.

**Expansion:**
- EU fintechs, under DORA's client-notification duty;
- UK financial services, under Consumer Duty remediation;
- airlines and travel, under refund rules.

## 7. Business model (hypotheses to test with design partners)

- **Land** as a Freshworks Marketplace app for Freshdesk and Freshservice, priced per helpdesk agent like other add-ons. Procurement stays easy, and it fits Freshworks' co-sell motion.
- **Expand** to platform pricing by customers protected (monthly paying customers covered). Value scales with the customer base at risk, not with support seats.
- **Compliance module** for regulated firms: audit exports, and incident-impact reports shaped for DORA, the FCA and RBI.

**The value, per incident. All inputs are assumptions except the Qualtrics ratio.**

| Input | Value |
|---|---|
| Customers hit by one checkout incident | 10,000 |
| Complain | 30%, so 3,000 (Qualtrics: fewer than a third give feedback [3]) |
| Stay silent | 7,000 |
| Lifetime value of a customer | ₹8,000 |
| Recovery credit, on average | ₹200 |

**Recovery pays for itself if it keeps about 2 in 100 harmed customers who would otherwise have left:**
- Crediting all 10,000 costs ₹20L. A typical blanket coupon to complainers only would cost ₹6L, so the extra spend is ₹14L.
- Each point of churn avoided across 10,000 customers keeps 100 customers, worth ₹8L.
- So the extra spend breaks even at about **1.75 points of churn avoided**.

That's before counting fewer repeat contacts, analyst time saved on the post-incident spreadsheet, and regulatory exposure avoided. Qualtrics finds 53% of bad experiences already lead customers to cut spending. [3]

## 8. Market size

**Bottom-up, with stated assumptions:**
- **Inside Freshworks:**
  - 24,762 customers pay Freshworks more than $5,000 a year. [12]
  - If one in five runs a transactional consumer business (an assumption), that's about 5,000 accounts.
  - At an annual contract of $6,000–$24,000 (an assumption), that's **$30M–$120M** of serviceable ARR in Freshworks' base alone.
- **Beyond Freshworks:**
  - Every mid-market and enterprise consumer business with a helpdesk and an incident process: Zendesk, Salesforce and ServiceNow shops.
  - Tens of thousands of companies at $25,000–$150,000 a year puts the total market in the **low billions of dollars**. That's an order-of-magnitude estimate, to be validated.
- **Budgets it draws on:**
  - remediation projects (analysts and consultants);
  - blanket compensation spend;
  - inbound ticket volume after incidents.

## 9. The moat: a critique and a sharper version

**The statement on the table:**

> "Our moat is the incident-to-customer recovery graph. Every incident teaches CrisisCrew which technical signals predicted failure, who was actually harmed, and which recovery action worked, making future detection earlier and recovery more precise."

**What's good:** it names a data asset nobody else has, and a learning loop tied to outcomes. Keep that core.

**What an investor will push on:**
1. **Three claims in one breath, and the first is the weakest.** "Which technical signals predicted failure" is detection data. Datadog and New Relic see orders of magnitude more technical signal than CrisisCrew ever will. Don't compete there.
2. **Incidents are rare.** A company has a handful of major customer-facing incidents a quarter, so a loop that learns per incident learns slowly. Learn per harmed customer instead, because each one is a labeled example: the harm, the remedy, and whether they came back. And say how learning carries across customers: anonymised benchmarks and priors.
3. **A graph is a data structure, not a moat.** The moat is the join only CrisisCrew makes: incident, transactions, tickets, remedies and outcomes. Add the position that lets you keep making it.
4. **It leaves out switching costs.** Once support, finance and compliance run approvals and audits through CrisisCrew, it's their system of record.

**Three sharper versions:**
- **For the moat slide (recommended):** "CrisisCrew is the system of record for customer harm: the audited ledger of who each incident hurt, what they were owed, and proof they were made whole. Every closed incident adds outcome data, which remedy brought which customer back, that no alerting tool or helpdesk can collect, because neither sees both sides."
- **The one-liner:** "Observability knows what broke. Helpdesks know who complained. Only CrisisCrew knows who was harmed, what they were owed, and what won them back."
- **The data flywheel:** "Recovery outcomes are the scarcest data in customer experience. Every harmed customer we recover is a labeled example (harm, remedy, retention), so our recovery policy is priced on evidence while everyone else guesses."

**Be honest about the stages:**
- **Today:** the moat is focus, Freshworks-native distribution, and a trust layer (the policy gate, the audit log, the guardrails) that lets a company allow agents near money.
- **Next:** the data moat compounds with design partners. Show the plan to reach the first 1,000 labeled recoveries, with a holdout that measures what recovery does to retention.

## 10. The pitch: seven slides and a demo

Five minutes, plus a two-minute demo.

1. **The story (30 s):** "12 April 2025. UPI goes down for hours. Your checkout fails for 10,000 customers. 3,000 write in. What happens to the other 7,000?"
2. **The problem (45 s):**
   - $2M an hour for high-impact outages [1];
   - fewer than a third of unhappy customers tell you [3];
   - 53% cut spending [3];
   - regulators now audit the recovery [6][10][11].
3. **The gap (30 s):** the table in section 3. Engineering knows what broke; support knows who complained; nobody knows who was harmed.
4. **The product (90 s, the demo):**
   1. Replay the hero scenario: 23 harmed, 8 complained, 15 silent.
   2. Click a silent customer to show her evidence chain.
   3. Approve one credit and change another: 23 of 23 recovered.
   4. Open Traces: every agent step, and the one refused call pinpointed.
5. **Trust (30 s):** agents act within authority and stop for a human on money. The policy gate refused all 51 attacks, with zero unauthorized actions. Every step is traced and audited.
6. **The business (45 s):**
   - the Freshworks Marketplace wedge in India;
   - the per-incident economics (the break-even is 2 in 100 customers kept);
   - bottom-up sizing.
7. **The moat and the ask (30 s):** the system of record for customer harm, and the plan to reach 1,000 labeled recoveries with three design partners.

## 11. Hard questions

- **"Isn't this a feature of Freshworks, Zendesk or PagerDuty?"** Each sees one side. The product is the join (incident, transactions, customers, remedies) and the governance to pay out on it. We build on Freshworks, not against it: Marketplace distribution, and MCP for Agent Studio.
- **"Why would a company give you payment data?"** It's read-only and minimal: customer reference, timestamp, status, amount, and a window around the incident. It connects through the gateway's webhooks or exports (Razorpay, Juspay, Stripe) and can stay in the customer's region. Their analysts already query the same data by hand after every major incident.
- **"Why not just email everyone?"** Broadcasts reach people who weren't affected and create contacts: 66% of B2C customers contact support after proactive outreach. [5] They also miss the remedy, and they leave no record of who was owed what.
- **"Where's the AI? Isn't this rules?"** The consequential decisions (who's harmed, who gets money) are deterministic on purpose, and auditable. AI is used where it's bounded: understanding complaints, and classifying tickets (embeddings, and Laya, a decision model that returns labels with probabilities). A language model will draft messages, behind an output guard, but never decide money.
- **"What stops the agent paying the wrong person?"** The policy gate checks evidence of harm, the exact planned or approved amount, per-customer and per-incident limits, and duplicates, on every call. Above the limits, a human decides one customer at a time. The safety evaluation's result: 0 wrong-customer credits and 0 bypasses across 95 attacks.
- **"How do you make money if incidents are rare?"** Customers pay for protection, not per incident, the way they pay for monitoring. Smaller customer-impacting failures (a payment method, a region, an app version) are frequent, and the same engine covers them.
- **"What if Freshworks builds it?"** Partnering is the plan: we sit on their Marketplace and their MCP gateway. The defensible part is cross-system: payment data, the harm ledger, compliance reporting and outcome data.

## 12. Risks, and how we'd handle them

| Risk | Plan |
|---|---|
| Access to transaction data | Read-only connectors with minimal fields; start with payment-gateway webhooks, in the customer's region |
| Liability for automated payouts | Start with notes and messages, then credits within small limits, then humans for the rest. Every action is audited |
| Proving recovery changes retention | A holdout experiment with each design partner, planned from day one |
| Platform dependence on Freshworks | Adapters for Zendesk, Salesforce and ServiceNow follow the same ports |
| Synthetic evaluations | Replace them with design-partner incidents as soon as data is shared |

## 13. The ask

For the team to decide. One suggested framing:

> "We're raising a pre-seed to get three design partners live on Freshdesk and their payment data within six months, reach 1,000 labeled recoveries, and publish a retention read-out."

## Sources

1. New Relic, [2025 Observability Forecast press release](https://newrelic.com/press-release/20250917) (17 Sep 2025)
2. Cybersecurity Dive, [CrowdStrike disruption direct losses to reach $5.4B for Fortune 500](https://www.cybersecuritydive.com/news/crowdstrike-cost-fortune-500-losses-cyber-insurance/722396/) (Parametrix estimate; Delta's $500M)
3. CX Dive, [Bad experiences put $3.8 trillion at risk](https://www.customerexperiencedive.com/news/bad-experiences-trillions-sales-risk/729920/) (Qualtrics XM Institute, Oct 2024)
4. Qualtrics, [2025 Consumer Experience Trends](https://www.qualtrics.com/articles/news/increased-expectations-declining-loyalty-qualtrics-announces-2025-consumer-experience-trends/) (Oct 2024)
5. Gartner, [Two-thirds of customers contact customer service after receiving proactive outreach](https://www.gartner.com/en/newsroom/press-releases/gartner-survey-finds-two-thirds-of-customers-contact-customer-se)
6. The Atlanta Journal-Constitution, [DOT drops investigation of Delta for CrowdStrike outage](https://www.ajc.com/business/2026/06/dot-drops-investigation-of-delta-for-crowdstrike-outage/) (Jun 2026); [the 2024 investigation](https://www.weau.com/2024/07/23/delta-under-investigation-its-response-crowdstrike-tech-outage-difficulties-dot-announces/)
7. Observer Research Foundation, [UPI at scale: outages and the push for resilient systems](https://www.orfonline.org/expert-speak/upi-at-scale-outages-and-the-push-for-resilient-systems)
8. MediaNama, [NPCI restores UPI after nationwide payment failures](https://www.medianama.com/2025/04/223-npci-upi-outage-april-12-2025/) (12 Apr 2025)
9. Reserve Bank of India, [Harmonisation of Turn Around Time and customer compensation for failed transactions](https://www.rbi.org.in/commonman/English/scripts/Notification.aspx?Id=3074) (2019)
10. DORA, [Article 19: reporting of major ICT-related incidents](https://www.digital-operational-resilience-act.com/Article_19.html)
11. FCA, [FG26/2: good and poor practice on identifying and rectifying harm](https://www.fca.org.uk/publication/finalised-guidance/fg26-2.pdf) (Mar 2026); [Consumer Duty (PRIN 2A)](https://handbook.fca.org.uk/handbook/prin2a)
12. Freshworks, [Fourth quarter and full year 2025 results](https://www.freshworks.com/pressrelease/freshworks-reports-fourth-quarter-and-full-year-2025-results/)
13. PagerDuty, [Fourth quarter and full year fiscal 2026 results](https://www.pagerduty.com/newsroom/pagerduty-announces-fourth-quarter-full-year-fiscal-2026-financial-results/)
14. Insight Partners, [incident.io raises $62M](https://www.insightpartners.com/ideas/incident-io-raises-62m-to-build-ai-agents-that-resolve-incidents-with-you/) (Apr 2025); valuation as reported by [Clay](https://www.clay.com/dossier/incidentio-funding)
15. PagerDuty, [Customer Service Operations](https://www.pagerduty.com/platform/business-ops/customer-service-operations/)
