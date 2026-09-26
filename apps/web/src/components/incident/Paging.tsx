import type { CallView, IncidentView, PageAttemptState, PagingView } from "@crisiscrew/contracts";
import { PhoneCall } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
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
/** Phones the primary on-call engineer now; the call briefs them on the incident. */
function CallButton({ incident }: { incident: IncidentView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const calling = incident.paging?.attempts.at(-1)?.state === "calling";
  return (
    <span className="row-actions">
      {error && <span className="muted" title={error}>Not called</span>}
      <button
        className="btn btn-sm"
        type="button"
        disabled={busy || calling}
        title={error ?? "Phone the on-call engineer now; the call briefs them on this incident"}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.pageNow(incident.id);
          } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        <PhoneCall size={13} aria-hidden /> {calling ? "Calling…" : "Call on-call now"}
      </button>
    </span>
  );
}

export function Paging({ incident, calls = {} }: { incident: IncidentView; calls?: Record<string, CallView> }) {
  const paging = incident.paging;
  if (!paging) {
    return (
      <Card title="On-call" subtitle={incident.importance?.page ? "Paging the on-call engineer" : `${incident.importance?.level ?? "This incident"} doesn't page on its own`} actions={<CallButton incident={incident} />}>
        <Empty icon={<PhoneCall size={18} />} title={incident.importance?.page ? "Looking up who's on call" : "Call the on-call engineer yourself if it needs one"} />
      </Card>
    );
  }
  const status = STATUS[paging.status];
  const subtitle =
    paging.status === "acknowledged"
      ? `${paging.acknowledgedBy} took it at ${clock(paging.acknowledgedAt!)}${paging.via === "call" ? " by pressing 1" : ""}`
      : (paging.note ?? "Each unanswered call escalates to the next responder");
  return (
    <Card
      title="On-call"
      subtitle={subtitle}
      actions={
        <>
          <Badge tone={status.tone} dot>{status.label}</Badge>
          <CallButton incident={incident} />
        </>
      }
      flush
    >
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
