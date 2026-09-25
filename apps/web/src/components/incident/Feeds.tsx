import { GUARD_REASONS, type CrisisState, type TicketView } from "@crisiscrew/contracts";
import { Inbox } from "lucide-react";
import { clock, pct, surface } from "../../format";
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
            {signal.isFailure ? "Failure report" : signal.ticketType === "request" ? "Request" : "Question"}
          </Badge>
          <Badge>{surface(signal.surface)}</Badge>
          {signal.classifier?.source === "laya" && (
            <Badge title={`Laya${signal.classifier.model ? ` (${signal.classifier.model})` : ""}: ${signal.classifier.ticketType} with probability ${pct(signal.classifier.confidence ?? 0)}`}>
              Laya {pct(signal.classifier.confidence ?? 0)}
            </Badge>
          )}
          {signal.classifier?.fallback && (
            <Badge tone="warning" title={signal.classifier.fallback}>
              Classifier fell back
            </Badge>
          )}
          {signal.guard?.flagged && (
            <Badge tone="warning" title={`Instruction-like text: ${signal.guard.reasons.map((r) => GUARD_REASONS[r] ?? r).join("; ")}. Kept as data.`}>
              Flagged by guard
            </Badge>
          )}
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
