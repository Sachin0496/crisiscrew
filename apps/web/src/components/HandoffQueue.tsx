import type { CrisisState } from "@crisiscrew/contracts";
import { Inbox } from "lucide-react";
import { RECOVERY_CHIP, RECOVERY_STATUS, TRACK_LABELS } from "../format";
import { routeHref } from "../router";
import { currentIncident, handoffQueue, outreachByTrack } from "../view";
import { Badge, Card, Empty } from "./ui";

/** What the Handoff Agent still has to do for the current incident: messages to send, and credits waiting for a human. */
export function HandoffQueue({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  if (!incident?.impact) return null;
  const queue = handoffQueue(incident);
  const names = new Map(incident.impact.customers.map((c) => [c.ref, c.name]));
  const sent = outreachByTrack(incident)
    .map((t) => `${TRACK_LABELS[t.track].label.toLowerCase()} ${t.messages.sent + t.messages.prepared}/${t.messages.total}`)
    .join(" · ");
  return (
    <Card title="Handoff Agent's queue" subtitle={`${incident.id} · messages sent by track: ${sent}`} flush>
      {queue.length === 0 ? (
        <Empty icon={<Inbox size={18} />} title="Nothing waiting">
          Every message is sent and no credit is waiting for a human.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Customer</th>
                <th>Track</th>
                <th>Action</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {queue.map((a) => (
                <tr key={a.id}>
                  <td className="primary nowrap">
                    <a href={routeHref("customers", a.customerRef)}>{names.get(a.customerRef) ?? a.customerRef}</a>
                  </td>
                  <td className="nowrap">{a.track ? TRACK_LABELS[a.track].label : "–"}</td>
                  <td className="nowrap">{RECOVERY_CHIP[a.kind]}</td>
                  <td>
                    <Badge tone={RECOVERY_STATUS[a.status].tone}>{RECOVERY_STATUS[a.status].label}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
