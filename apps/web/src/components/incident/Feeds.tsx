import type { CrisisState, IncidentView, TicketView } from "@crisiscrew/contracts";
import { Bot, Inbox } from "lucide-react";
import { clock, plural, since, STATUS_LABELS, sentence, surface, TOOL_OWNER } from "../../format";
import { routeHref } from "../../router";
import { TicketComposer } from "../TicketComposer";
import { Badge, Card, Empty } from "../ui";

export const CHANNELS = { chat: "Chat", email: "Email", phone: "Phone", portal: "Portal" } as const;

/** Product area, failure or question, incident and origin: the tags every ticket carries. */
export function TicketTags({ view }: { view: TicketView }) {
  const { ticket, signal, incidentId } = view;
  return (
    <div className="tags">
      {signal ? (
        <>
          <Badge tone={signal.isFailure ? "danger" : "neutral"} title={`Failure score ${signal.failureScore.toFixed(2)}`}>
            {signal.isFailure ? "Failure report" : "Question"}
          </Badge>
          <Badge>{surface(signal.surface)}</Badge>
        </>
      ) : (
        <Badge>Reading…</Badge>
      )}
      {incidentId && <Badge mono>{incidentId}</Badge>}
      {ticket.source === "manual" && <Badge tone="accent">Typed here</Badge>}
      {ticket.source === "freshdesk" && <Badge tone="accent">Freshdesk</Badge>}
    </div>
  );
}

export function RecentTickets({ state, customerNames }: { state: CrisisState; customerNames: string[] }) {
  const views = [...state.ticketOrder].reverse().slice(0, 6).map((id) => state.tickets[id]!);
  return (
    <Card
      title="Incoming tickets"
      subtitle={`${state.ticketOrder.length} read · newest first`}
      actions={
        <a className="link-btn" href={routeHref("tickets")}>
          View all
        </a>
      }
      flush
    >
      {views.length === 0 ? (
        <Empty icon={<Inbox size={18} />} title="No tickets yet">
          Run a replay, or type a customer's message below.
        </Empty>
      ) : (
        views.map((view) => (
          <article className="list-row row-new" key={view.ticket.id}>
            <div className="ticket-head">
              <span className="ticket-name">{view.ticket.customerName}</span>
              <span>{CHANNELS[view.ticket.channel]}</span>
              <span className="when">{clock(view.ticket.receivedAt)}</span>
            </div>
            <p className="ticket-body">{view.ticket.body}</p>
            <TicketTags view={view} />
          </article>
        ))
      )}
      <TicketComposer customerNames={customerNames} />
    </Card>
  );
}

export function IncidentTimeline({ incident, start }: { incident: IncidentView; start: number }) {
  return (
    <Card title="Timeline" subtitle={`${incident.id} · time since the session started`} flush>
      <ol className="timeline">
        {incident.timeline.map((t, i) => (
          <li key={`${t.at}-${i}`} className={i === incident.timeline.length - 1 ? "latest" : undefined}>
            <div className="tl-head">
              <span className="tl-title">{STATUS_LABELS[t.status]}</span>
              <span className="tl-time">{since(t.at, start)}</span>
            </div>
            {t.note && <div className="tl-note">{sentence(t.note)}</div>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function Activity({ state }: { state: CrisisState }) {
  const calls = [...state.toolCalls].reverse().slice(0, 8);
  return (
    <Card
      title="Agent activity"
      subtitle={`${plural(state.toolCalls.length, "tool call")}, each through the policy gate`}
      actions={
        <a className="link-btn" href={routeHref("agents")}>
          View all
        </a>
      }
      flush
    >
      {calls.length === 0 ? (
        <Empty icon={<Bot size={18} />} title="No agent has acted yet">
          Agents start work once an incident opens.
        </Empty>
      ) : (
        calls.map((c) => (
          <div className={c.decision === "denied" ? "activity-row refused row-new" : "activity-row row-new"} key={c.hash}>
            <div>
              <span className="who">{TOOL_OWNER[c.identity] ?? c.identity}</span> <span className="tool">{c.tool}</span>{" "}
              {c.decision === "denied" ? <Badge tone="danger">Refused</Badge> : c.level !== null && <Badge>L{c.level}</Badge>}
            </div>
            <span className="when">{since(c.at, state.session.startedAt)}</span>
            <div className="result">{c.decision === "denied" || c.outcome === "error" ? sentence(c.reason ?? "") : sentence(c.resultSummary ?? "")}</div>
          </div>
        ))
      )}
    </Card>
  );
}
