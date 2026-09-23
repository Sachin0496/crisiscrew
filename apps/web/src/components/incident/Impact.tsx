import type { CustomerUpdate, IncidentView } from "@crisiscrew/contracts";
import { Users } from "lucide-react";
import { useState } from "react";
import { CHANNEL_LABELS, type Tone } from "../../format";
import { Badge, Card, Empty } from "../ui";

const PREVIEW = 6;

function updateStatus(u: CustomerUpdate): { label: string; tone: Tone } {
  if (u.status === "prepared") return { label: "Prepared", tone: "neutral" };
  if (u.status === "refused") return { label: "Refused", tone: "danger" };
  return { label: u.adapter === "sandbox" ? "Sent in sandbox" : "Sent", tone: "success" };
}

/** The Recovery Agent's work: who was affected, and the one update everyone received. */
export function Impact({ incident }: { incident?: IncidentView }) {
  const [showAll, setShowAll] = useState(false);
  const affected = incident?.affected;
  const updates = [...(incident?.updates ?? [])].reverse();
  const count = (channel: CustomerUpdate["channel"]) => updates.filter((u) => u.channel === channel && u.status !== "refused").length;
  const sample = updates.find((u) => u.channel !== "voice");
  const voice = updates.find((u) => u.channel === "voice");
  const contactedShare = affected && affected.total > 0 ? affected.ticketed.length / affected.total : 0;
  return (
    <Card
      title="Customer impact"
      subtitle="Recovery Agent · contacts customers only through channels they agreed to"
      flush={affected !== undefined}
      footer={
        updates.length > PREVIEW ? (
          <button className="link-btn" type="button" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer updates" : `Show all ${updates.length} updates`}
          </button>
        ) : undefined
      }
    >
      {!affected ? (
        <Empty icon={<Users size={18} />} title="Found once an incident opens">
          The Recovery Agent links every related ticket and checks payment attempts to find customers who were hit but never wrote in.
        </Empty>
      ) : (
        <>
          <div className="card-body">
            <div className="similarity-caption">Customers affected since the failure started</div>
            <div className="impact-value">{affected.total}</div>
            <div className="split" role="img" aria-label={`${affected.ticketed.length} contacted us, ${affected.silent.length} silent`}>
              <span className="contacted" style={{ width: `${contactedShare * 100}%` }} />
              <span className="silent" style={{ width: `${(1 - contactedShare) * 100}%` }} />
            </div>
            <div className="legend">
              <span>
                <i style={{ background: "var(--accent)" }} />
                {affected.ticketed.length} contacted us
              </span>
              <span>
                <i style={{ background: "var(--text-4)" }} />
                {affected.silent.length} silent, found from failed payments
              </span>
            </div>
            <div className="mini-stats">
              <div className="mini">
                <div className="mini-value">{count("ticket_reply")}</div>
                <div className="mini-label">Ticket replies</div>
              </div>
              <div className="mini">
                <div className="mini-value">{count("proactive_message")}</div>
                <div className="mini-label">Proactive messages</div>
              </div>
              <div className="mini">
                <div className="mini-value">{count("voice")}</div>
                <div className="mini-label">Voice scripts</div>
              </div>
            </div>
            {sample && (
              <div className="quote">
                <div className="quote-label">
                  Update every affected customer receives <Badge>{sample.source === "template" ? "From a template" : `Written by ${sample.source}`}</Badge>
                </div>
                {sample.text}
              </div>
            )}
            {voice && (
              <div className="quote">
                <div className="quote-label">
                  Voice script for priority customers <Badge>{voice.status === "prepared" ? "Prepared: voice isn't wired" : "Sent"}</Badge>
                </div>
                {voice.text}
              </div>
            )}
          </div>
          {updates.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Channel</th>
                    <th>Status</th>
                    <th className="right">Update</th>
                  </tr>
                </thead>
                <tbody>
                  {(showAll ? updates : updates.slice(0, PREVIEW)).map((u) => {
                    const status = updateStatus(u);
                    return (
                      <tr key={u.id}>
                        <td className="primary nowrap">{u.customerName}</td>
                        <td className="nowrap">{CHANNEL_LABELS[u.channel]}</td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </td>
                        <td className="right mono nowrap">{u.id}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
