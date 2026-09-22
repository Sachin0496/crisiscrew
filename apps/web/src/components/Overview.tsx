import type { CrisisState, IncidentView } from "@crisiscrew/contracts";
import type { ScenarioSummary } from "../api";
import { inr, STATUS_LABELS, surface } from "../format";

export function currentIncident(state: CrisisState): IncidentView | undefined {
  const id = state.incidentOrder.at(-1);
  return id ? state.incidents[id] : undefined;
}

function expectedText(s: ScenarioSummary): string {
  const e = s.expected;
  if (!e.incident) return `Expected: no incident${e.refusedBy ? `, refused on ${e.refusedBy.replace("_", " ")}` : ""}.`;
  const parts = [`root cause ${e.rootCause?.split(":")[1] ?? "?"}`];
  if (e.affected) parts.push(`${e.affected} affected (${e.silent} silent)`);
  if (e.creditInr) parts.push(`${inr(e.creditInr)} credit for a human to decide`);
  return `Expected: an incident; ${parts.join("; ")}.`;
}

export function Brief({ state, scenario }: { state: CrisisState; scenario: ScenarioSummary | undefined }) {
  const incident = currentIncident(state);
  const complaints = incident ? incident.linkedTicketIds.length : state.ticketOrder.filter((id) => state.tickets[id]?.signal?.isFailure).length;
  const pendingDecisions = Object.values(state.approvals).filter((a) => a.status === "pending").length;
  const decided = Object.values(state.approvals).filter((a) => a.status !== "pending").length;
  const replay = state.session.mode === "replay";
  return (
    <section className="brief" id="overview">
      <div className="card brief-main">
        <div className="eyebrow">{replay ? "Scenario replay" : "Live session"}</div>
        <h1>
          <span className="gradient-text">{replay && scenario ? scenario.title : "Your customers file your incidents for you."}</span>
        </h1>
        <p>
          {replay && scenario
            ? scenario.purpose
            : "CrisisCrew reads every support ticket, notices when differently worded complaints describe the same failure, and runs the response: investigate, recover customers, and hand risky decisions to a human. Run a replay, or type complaints below and watch it decide."}
        </p>
        <div className="chips">
          {replay && scenario && <span className="pill">{expectedText(scenario)}</span>}
          <span className="pill">Every number below is computed by the engine</span>
        </div>
      </div>
      <div className="card story" aria-label="The story so far">
        <Step n={complaints} text="complaints linked to one failure" dim={complaints === 0} />
        <Step n={state.incidentOrder.length} text={state.incidentOrder.length === 1 ? "incident" : "incidents"} dim={!incident} />
        <Step n={incident?.affected?.total ?? 0} text="customers affected and covered" dim={!incident?.affected} />
        <Step n={pendingDecisions + decided} text={pendingDecisions ? "human decision waiting" : "human decisions"} dim={pendingDecisions + decided === 0} />
      </div>
    </section>
  );
}

function Step({ n, text, dim }: { n: number; text: string; dim: boolean }) {
  return (
    <div className={`story-step ${dim ? "dim" : ""}`}>
      <span className="n">{n}</span>
      <span className="t">{text}</span>
    </div>
  );
}

export function Metrics({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  const tickets = state.ticketOrder.map((id) => state.tickets[id]!);
  const failures = tickets.filter((t) => t.signal?.isFailure).length;
  const credit = incident?.credit;
  const creditLabel: Record<string, string> = {
    proposed: "proposed",
    awaiting_approval: "waiting for a human",
    issued: "issued",
    withheld: "withheld by the approver",
  };
  return (
    <section className="metric-row" aria-label="Key numbers">
      <div className="card metric">
        <div className="k">Tickets read</div>
        <div className="v">{tickets.length}</div>
        <div className="s">
          {failures} report failures · {tickets.length - failures} questions
        </div>
      </div>
      <div className="card metric">
        <div className="k">Incident</div>
        <div className="v">{incident ? incident.id.replace("INC-", "") : "None"}</div>
        <div className="s">{incident ? `${STATUS_LABELS[incident.status]} · ${surface(incident.surface)}` : "Nothing meets every gate"}</div>
      </div>
      <div className="card metric">
        <div className="k">Customers affected</div>
        <div className="v">{incident?.affected?.total ?? "–"}</div>
        <div className="s">{incident?.affected ? `${incident.affected.ticketed.length} contacted us · ${incident.affected.silent.length} silent` : "Found from payment attempts"}</div>
      </div>
      <div className="card metric">
        <div className="k">Recovery credit</div>
        <div className="v">{credit ? inr(credit.amountInr) : "–"}</div>
        <div className="s">{credit ? `${inr(credit.perCustomerInr)} × ${credit.customers} · ${creditLabel[credit.status]}` : "Proposed after recovery"}</div>
      </div>
    </section>
  );
}

const STEPS = [
  { n: "01", title: "Detect", text: "The Pattern Agent links complaints by meaning and product area, and opens an incident only when all four gates pass." },
  { n: "02", title: "Investigate", text: "The Investigator checks the gateway, recent releases and error rates, then ranks causes by evidence." },
  { n: "03", title: "Recover", text: "The Recovery Agent links tickets, finds silent customers, and sends one consistent update through allowed channels." },
  { n: "04", title: "Hand off", text: "Above the authority limit, the Handoff Agent builds the case and a human decides." },
];

export function Flow({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  const s = incident?.status;
  const reached = !incident
    ? 0
    : s === "detected"
      ? 1
      : s === "investigating" || s === "root_cause_identified"
        ? 2
        : s === "recovering"
          ? 3
          : 4;
  const humanWaiting = s === "awaiting_approval";
  return (
    <section className="card pad" aria-label="Incident flow" style={{ marginBottom: 18 }}>
      <div className="flowline">
        {STEPS.map((step, i) => {
          const index = i + 1;
          const cls = index < reached || (index === reached && s === "mitigated") ? "done" : index === reached ? (humanWaiting && index === 4 ? "human" : "current") : "";
          return (
            <div className={`step ${cls}`} key={step.n}>
              <div className="num">{step.n}</div>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
