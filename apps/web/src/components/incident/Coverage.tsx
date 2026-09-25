import { recoveryCoverage, recoveryMetrics, type CrisisState, type IncidentView } from "@crisiscrew/contracts";
import { Gauge } from "lucide-react";
import { Badge, Card, Empty } from "../ui";

/**
 * Recovery at a glance: Recovery Coverage (confirmed customers with a
 * completed or human-decided recovery, over all confirmed customers) as one
 * bar, the three numbers the KPI row doesn't show, and the message every
 * affected customer received. The incident isn't recovered until 100%.
 */
export function Recovery({ state, incident }: { state: CrisisState; incident?: IncidentView }) {
  if (!incident?.impact) {
    return (
      <Card title="Recovery" subtitle="Every affected customer, recovered">
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
      title="Recovery"
      subtitle={c.complete ? `All ${c.confirmed} affected customers recovered` : `${c.recovered} of ${c.confirmed} affected customers recovered`}
      actions={c.complete ? <Badge tone="success">Complete</Badge> : c.needsHuman > 0 ? <Badge tone="warning">Waiting for a human</Badge> : undefined}
    >
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
      <dl className="metrics compact">
        <div className="metric">
          <dt>Complaint to incident</dt>
          <dd>{m.complaintToIncidentSec === null ? "–" : `${m.complaintToIncidentSec} s`}</dd>
        </div>
        <div className="metric">
          <dt>Duplicates avoided</dt>
          <dd>{m.duplicateTicketsAvoided}</dd>
        </div>
        <div className="metric">
          <dt>Proactive contacts</dt>
          <dd>{m.proactiveContacts}</dd>
        </div>
      </dl>
      {sample && (
        <details className="disclosure">
          <summary>The message affected customers received</summary>
          <div className="quote">{sample.text}</div>
        </details>
      )}
    </Card>
  );
}
