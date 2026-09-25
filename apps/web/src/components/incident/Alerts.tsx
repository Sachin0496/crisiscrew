import type { CrisisState } from "@crisiscrew/contracts";
import { clock } from "../../format";
import { Badge, Card } from "../ui";

/** Operational alerts this session: which opened or joined an incident, and which were only recorded. Hidden when there are none. */
export function Alerts({ state }: { state: CrisisState }) {
  const alerts = [...state.alertOrder].reverse().map((id) => state.alerts[id]!);
  if (alerts.length === 0) return null;
  return (
    <Card title="Alerts" subtitle="From Freshservice Alert Management: a critical alert on a tier-1 service opens an incident by itself" flush>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Alert</th>
            </tr>
          </thead>
          <tbody>
            {alerts.map((a) => {
              const incident = a.incidentId ? state.incidents[a.incidentId] : undefined;
              const opened = incident?.trigger === "alert" && incident.alertIds?.[0] === a.id;
              return (
                <tr key={a.id}>
                  <td className="mono nowrap">{clock(a.firedAt)}</td>
                  <td className="wrap">
                    <Badge tone={a.severity === "critical" ? "danger" : "warning"}>{a.severity === "critical" ? "Critical" : "Warning"}</Badge> <strong>{a.service}</strong>{" "}
                    <span className="muted">{a.label}</span>
                    <div className="muted">
                      {incident ? `${opened ? "Opened" : "Linked to"} ${incident.id}` : "Recorded; no incident"}
                      {a.resolvedAt !== undefined && ` · resolved ${clock(a.resolvedAt)}`}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
