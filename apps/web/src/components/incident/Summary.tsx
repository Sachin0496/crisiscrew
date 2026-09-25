import { recoveryCoverage, recoveryMetrics, type CrisisState, type IncidentView } from "@crisiscrew/contracts";
import { Check, CirclePlay, Clock, ExternalLink, GitCommitHorizontal, Inbox, Users, Wrench } from "lucide-react";
import type { ScenarioSummary } from "../../api";
import { ADAPTER_LABELS, clock, inr, pct, plural, SEVERITY, since, STATUS_LABELS, STATUS_TONE } from "../../format";
import { expectedOutcome, incidentTitle, progressSteps } from "../../view";
import { Badge, Stat } from "../ui";

/** One quiet line under the title: which replay this is and what it should do. */
function ReplayLine({ scenario, finished }: { scenario: ScenarioSummary; finished: boolean }) {
  return (
    <p className="replay-line">
      <CirclePlay size={14} aria-hidden />
      <span>
        {finished ? "Replay finished" : "Replaying"}: <strong>{scenario.title}</strong>. {expectedOutcome(scenario.expected)}.
      </span>
    </p>
  );
}

export function IncidentSummary({ incident, scenario, finished }: { incident?: IncidentView; scenario?: ScenarioSummary; finished: boolean }) {
  if (!incident) {
    return (
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">No active incident</h1>
          <Badge tone="success" dot>
            Monitoring
          </Badge>
        </div>
        {scenario ? (
          <ReplayLine scenario={scenario} finished={finished} />
        ) : (
          <p className="page-lede">
            CrisisCrew reads every new complaint. When a burst of them describes the same failure, it opens an incident, proves who was harmed from the payment
            data, finds the customers who stayed silent, and recovers each one until everyone is covered.
          </p>
        )}
      </div>
    );
  }
  const tickets = new Set([...incident.ticketIds, ...incident.linkedTicketIds]).size;
  const severity = SEVERITY[incident.severity];
  const coverage = recoveryCoverage(incident);
  const record = incident.engineering;
  return (
    <div className="page-header">
      <div className="page-title-row">
        <h1 className="page-title">{incidentTitle(incident.surface)}</h1>
        <Badge tone={STATUS_TONE[incident.status]} dot>
          {STATUS_LABELS[incident.status]}
        </Badge>
        <Badge tone={severity.tone}>{severity.label}</Badge>
      </div>
      <div className="page-meta">
        <span className="mono">{incident.id}</span>
        <span>
          <Clock size={14} aria-hidden /> Opened {clock(incident.openedAt)}
        </span>
        <span>
          <Inbox size={14} aria-hidden /> {plural(tickets, "ticket")}
        </span>
        {incident.impact && (
          <span>
            <Users size={14} aria-hidden /> {plural(coverage.confirmed, "customer")} harmed
          </span>
        )}
        {incident.rootCause && (
          <span>
            <GitCommitHorizontal size={14} aria-hidden /> Likely cause <strong>{incident.rootCause.label}</strong> ({pct(incident.rootCause.confidence)})
          </span>
        )}
        {record && (
          <span title="The incident engineering works from">
            <Wrench size={14} aria-hidden />
            {record.url ? (
              <a href={record.url} target="_blank" rel="noreferrer">
                {ADAPTER_LABELS[record.adapter] ?? record.adapter} {record.id} <ExternalLink size={12} aria-hidden />
              </a>
            ) : (
              <>
                Engineering incident <strong className="mono">{record.id}</strong> ({(ADAPTER_LABELS[record.adapter] ?? record.adapter).toLowerCase()})
              </>
            )}
          </span>
        )}
      </div>
      {scenario && <ReplayLine scenario={scenario} finished={finished} />}
    </div>
  );
}

export function Stepper({ incident, start }: { incident: IncidentView; start: number }) {
  return (
    <section className="card" aria-label="Incident progress">
      <ol className="stepper">
        {progressSteps(incident).map((step) => (
          <li
            key={step.key}
            className={`step ${step.state}${step.key === "awaiting_approval" ? " waiting" : ""}`}
            aria-current={step.state === "current" ? "step" : undefined}
          >
            <span className="step-icon" aria-hidden>
              {step.state === "done" ? <Check size={13} strokeWidth={3} /> : step.state === "current" ? <span className="pulse" /> : null}
            </span>
            <div className="step-label">{step.label}</div>
            <div className="step-time">{step.at !== undefined ? since(step.at, start) : " "}</div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function Stats({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  const coverage = incident?.impact ? recoveryCoverage(incident) : undefined;
  const metrics = incident?.impact ? recoveryMetrics(state, incident) : undefined;
  const spent = metrics ? metrics.spend.issuedInr + metrics.spend.approvedInr : 0;
  return (
    <div className="stats" aria-label="Key numbers">
      <Stat
        label="Customers harmed"
        value={coverage ? coverage.confirmed : "–"}
        sub={
          coverage
            ? `${coverage.complained} complained · ${coverage.silent} silent${coverage.unverified ? ` · ${coverage.unverified} not verified` : ""}`
            : "Proved from payment data once an incident opens"
        }
      />
      <Stat
        label="Recovery coverage"
        value={
          coverage && coverage.confirmed > 0 ? (
            <>
              {coverage.recovered}
              <span className="of">/{coverage.confirmed}</span>
            </>
          ) : (
            "–"
          )
        }
        meter={coverage?.ratio ?? undefined}
        tone={coverage?.complete ? "success" : coverage && coverage.needsHuman > 0 ? "warning" : "accent"}
        sub={
          !coverage
            ? "Every affected customer, recovered"
            : coverage.complete
              ? "Every affected customer recovered"
              : coverage.needsHuman > 0
                ? `${plural(coverage.needsHuman, "customer")} ${coverage.needsHuman === 1 ? "needs" : "need"} a human`
                : `${coverage.inProgress + coverage.attention} still in progress`
        }
      />
      <Stat
        label="Root cause"
        value={incident?.rootCause ? pct(incident.rootCause.confidence) : "–"}
        sub={incident?.rootCause ? incident.rootCause.label : "Ranked when the Investigator finishes"}
      />
      <Stat
        label="Recovery spend"
        value={metrics ? inr(spent) : "–"}
        sub={
          !metrics
            ? "Credits sized per customer, by the harm"
            : metrics.spend.awaitingInr > 0
              ? `${inr(metrics.spend.awaitingInr)} waiting for approval`
              : metrics.spend.approvedInr > 0
                ? `${inr(metrics.spend.approvedInr)} of it approved by a human`
                : "All within the agents' authority"
        }
      />
    </div>
  );
}
