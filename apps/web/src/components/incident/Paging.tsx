import type { CallView, IncidentView, PageAttemptState, PagingView } from "@crisiscrew/contracts";
import { PhoneCall } from "lucide-react";
import { clock, type Tone } from "../../format";
import { Badge, Card, Empty } from "../ui";

const STATUS: Record<PagingView["status"], { label: string; tone: Tone }> = {
  paging: { label: "Paging", tone: "accent" },
  acknowledged: { label: "Acknowledged", tone: "success" },
  exhausted: { label: "Nobody acknowledged", tone: "danger" },
  no_responder: { label: "Nobody to call", tone: "danger" },
};

const ATTEMPT: Record<PageAttemptState, { label: string; tone: Tone }> = {
  calling: { label: "Calling", tone: "accent" },
  acknowledged: { label: "Pressed 1", tone: "success" },
  not_acknowledged: { label: "Answered, no ack", tone: "warning" },
  no_answer: { label: "No answer", tone: "warning" },
  busy: { label: "Busy", tone: "warning" },
  failed: { label: "Call failed", tone: "danger" },
};

/** Paging the on-call engineer: each call, in escalation order, and who took it. Only shown once importance calls for a page. */
export function Paging({ incident, calls = {} }: { incident: IncidentView; calls?: Record<string, CallView> }) {
  const paging = incident.paging;
  if (!paging) {
    if (!incident.importance?.page) return null;
    return (
      <Card title="On-call" subtitle="Paging the on-call engineer">
        <Empty icon={<PhoneCall size={18} />} title="Looking up who's on call" />
      </Card>
    );
  }
  const status = STATUS[paging.status];
  const subtitle =
    paging.status === "acknowledged"
      ? `${paging.acknowledgedBy} took it at ${clock(paging.acknowledgedAt!)}${paging.via === "call" ? " by pressing 1" : ""}`
      : (paging.note ?? "Each unanswered call escalates to the next responder");
  return (
    <Card title="On-call" subtitle={subtitle} actions={<Badge tone={status.tone} dot>{status.label}</Badge>} flush>
      {paging.attempts.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Responder</th>
              <th>Called</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {paging.attempts.map((a) => (
              <tr key={a.attempt}>
                <td className="mono">{a.attempt}</td>
                <td className="primary">
                  {a.responder} <span className="muted">({a.role}, {a.phone})</span>
                </td>
                <td className="mono">{clock(a.startedAt)}</td>
                <td>
                  <Badge tone={ATTEMPT[a.state].tone} title={a.reason}>
                    {ATTEMPT[a.state].label}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {paging.attempts.map((a) => {
        const lines = a.callId ? (calls[a.callId]?.transcript ?? []) : [];
        if (lines.length === 0) return null;
        const who = a.responder.split(/\s+/)[0];
        return (
          <div key={`t${a.attempt}`} className="call-transcript" aria-label={`Call ${a.attempt} transcript`}>
            {lines.map((line, i) => (
              <p key={i} className={line.speaker === "agent" ? "agent" : "callee"}>
                <span className="speaker">{line.speaker === "agent" ? "CrisisCrew" : who}</span>
                <span className="mono muted"> {clock(line.at)}</span>
                <br />
                {line.text}
              </p>
            ))}
          </div>
        );
      })}
    </Card>
  );
}
