import { recoveryCoverage, recoveryMetrics, type CrisisState, type IncidentView } from "@crisiscrew/contracts";
import { CircleCheck, Gauge, Scale } from "lucide-react";
import { inr, pct, plural } from "../../format";
import { Badge, Callout, Card, Empty } from "../ui";

/**
 * Recovery Coverage: confirmed affected customers with a completed or
 * human-decided recovery, over all confirmed affected customers. The
 * incident isn't recovered until it reaches 100%.
 */
export function Coverage({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  if (!incident?.impact) {
    return (
      <Card title="Recovery coverage" subtitle="Affected customers with a completed recovery">
        <Empty icon={<Gauge size={18} />} title="Measured once customers are found">
          Success is every affected customer covered, not just an alert that fired. The incident is recovered only at 100%.
        </Empty>
      </Card>
    );
  }
  const c = recoveryCoverage(incident);
  const m = recoveryMetrics(state, incident);
  const width = (n: number) => `${c.confirmed > 0 ? (n / c.confirmed) * 100 : 0}%`;
  const sample = [...incident.updates].reverse().find((u) => u.channel === "proactive_message" || u.channel === "ticket_reply");
  return (
    <Card
      title="Recovery coverage"
      subtitle="Affected customers with a completed or human-decided recovery"
      actions={c.complete ? <Badge tone="success">Complete</Badge> : c.needsHuman > 0 ? <Badge tone="warning">Waiting for a human</Badge> : undefined}
    >
      <div className="coverage-head">
        <div className="impact-value">
          {c.recovered}
          <span className="of">/{c.confirmed}</span>
        </div>
        <div className="coverage-pct">{c.ratio === null ? "–" : pct(c.ratio)}</div>
      </div>
      <div className="coverage-bar" role="img" aria-label={`${c.recovered} of ${c.confirmed} recovered`}>
        <span className="seg recovered" style={{ width: width(c.recovered) }} />
        <span className="seg human" style={{ width: width(c.needsHuman) }} />
        <span className="seg progress" style={{ width: width(c.inProgress) }} />
        <span className="seg attention" style={{ width: width(c.attention) }} />
      </div>
      <div className="legend">
        <span>
          <i className="recovered" />
          {c.recovered} recovered
        </span>
        {c.needsHuman > 0 && (
          <span>
            <i className="human" />
            {c.needsHuman} need a human
          </span>
        )}
        {c.inProgress > 0 && (
          <span>
            <i className="progress" />
            {c.inProgress} in progress
          </span>
        )}
        {c.attention > 0 && (
          <span>
            <i className="attention" />
            {c.attention} need attention
          </span>
        )}
      </div>
      <div className="coverage-callout">
        {c.complete ? (
          <Callout tone="success" icon={<CircleCheck size={16} aria-hidden />}>
            Every one of the {c.confirmed} affected customers has a completed recovery.
          </Callout>
        ) : c.needsHuman > 0 ? (
          <Callout tone="warning" icon={<Scale size={16} aria-hidden />}>
            {plural(c.needsHuman, "customer")} {c.needsHuman === 1 ? "needs" : "need"} a human decision. The incident isn't recovered until{" "}
            {c.needsHuman === 1 ? "it's" : "they're"} decided.
          </Callout>
        ) : null}
      </div>
      <dl className="metrics">
        <div className="metric">
          <dt>Complaint to incident</dt>
          <dd>{m.complaintToIncidentSec === null ? "–" : `${m.complaintToIncidentSec} s`}</dd>
        </div>
        <div className="metric">
          <dt>Silent customers found</dt>
          <dd>{m.silentFound}</dd>
        </div>
        <div className="metric">
          <dt>Duplicate tickets avoided</dt>
          <dd>{m.duplicateTicketsAvoided}</dd>
        </div>
        <div className="metric">
          <dt>Proactive contacts</dt>
          <dd>{m.proactiveContacts}</dd>
        </div>
        <div className="metric">
          <dt>Still unrecovered</dt>
          <dd>{m.unrecovered}</dd>
        </div>
        <div className="metric">
          <dt>Recovery spend</dt>
          <dd>
            {inr(m.spend.issuedInr + m.spend.approvedInr)}
            {m.spend.awaitingInr > 0 && <span className="metric-sub"> +{inr(m.spend.awaitingInr)} waiting</span>}
          </dd>
        </div>
      </dl>
      {sample && (
        <div className="quote">
          <div className="quote-label">
            The update each confirmed customer receives <Badge>{sample.source === "template" ? "From a template" : `Written by ${sample.source}`}</Badge>
          </div>
          {sample.text}
        </div>
      )}
    </Card>
  );
}
