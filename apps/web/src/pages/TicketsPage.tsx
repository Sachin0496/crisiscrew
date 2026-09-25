import { actionsFor, customerState, type CrisisState, type TicketView } from "@crisiscrew/contracts";
import { Inbox } from "lucide-react";
import { useState } from "react";
import { CHANNELS } from "../components/incident/Feeds";
import { TicketComposer } from "../components/TicketComposer";
import { Badge, Card, Empty, Segmented } from "../components/ui";
import { clock, CUSTOMER_STATE, plural, surface } from "../format";
import { routeHref } from "../router";

type Filter = "all" | "failures" | "questions";

/** Where the ticket's customer stands in the incident's impact graph, linked to their evidence. */
function CustomerImpactCell({ state, view }: { state: CrisisState; view: TicketView }) {
  const incident = view.incidentId ? state.incidents[view.incidentId] : undefined;
  const customer = incident?.impact?.customers.find((c) => c.ref === view.ticket.customerRef);
  if (!incident || !customer) return <span className="muted">–</span>;
  const status = CUSTOMER_STATE[customerState(customer, actionsFor(incident, customer.ref))];
  return (
    <a href={routeHref("customers", customer.ref)} className="plain-link">
      <Badge tone={status.tone}>{status.label}</Badge>
    </a>
  );
}

export function TicketsPage({ state, customerNames }: { state: CrisisState; customerNames: string[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const views = [...state.ticketOrder].reverse().map((id) => state.tickets[id]!);
  const failures = views.filter((v) => v.signal?.isFailure).length;
  const shown = views.filter((v) => filter === "all" || (filter === "failures" ? v.signal?.isFailure : v.signal && !v.signal.isFailure));
  return (
    <div className="page">
      <div className="page-header">
        <h1 className="page-title">Tickets</h1>
        <p className="page-lede">
          Every ticket the Pattern Agent has read in this session, with its product area, whether it reports a failure or asks a question, and where its customer
          stands in the incident.
        </p>
      </div>
      <section className="card" aria-label="New ticket">
        <TicketComposer customerNames={customerNames} />
      </section>
      <Card
        title="All tickets"
        subtitle={`${plural(views.length, "ticket")} · ${plural(failures, "failure report")} · ${plural(views.length - failures, "question")}`}
        actions={
          <Segmented
            label="Show"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All" },
              { value: "failures", label: "Failure reports" },
              { value: "questions", label: "Questions" },
            ]}
          />
        }
        flush
      >
        {shown.length === 0 ? (
          <Empty icon={<Inbox size={18} />} title={views.length === 0 ? "No tickets yet" : "No tickets match this filter"}>
            {views.length === 0 ? "Run a replay, or type a customer's message above." : undefined}
          </Empty>
        ) : (
          <div className="table-wrap tall">
            <table className="table">
              <thead>
                <tr>
                  <th>Received</th>
                  <th>Ticket</th>
                  <th>Customer</th>
                  <th>Channel</th>
                  <th>Message</th>
                  <th>Product area</th>
                  <th>Type</th>
                  <th>Incident</th>
                  <th>Customer impact</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((view) => {
                  const { ticket, signal, incidentId } = view;
                  return (
                  <tr key={ticket.id}>
                    <td className="nowrap num">{clock(ticket.receivedAt)}</td>
                    <td className="nowrap mono">{ticket.id}</td>
                    <td className="primary nowrap">{ticket.customerName}</td>
                    <td className="nowrap">{CHANNELS[ticket.channel]}</td>
                    <td className="wrap">
                      {ticket.body}
                      {ticket.source !== "sandbox" && (
                        <>
                          {" "}
                          <Badge tone="accent">{ticket.source === "freshdesk" ? "Freshdesk" : "Typed here"}</Badge>
                        </>
                      )}
                    </td>
                    <td className="nowrap">{signal ? surface(signal.surface) : "–"}</td>
                    <td className="nowrap">
                      {signal ? (
                        <Badge tone={signal.isFailure ? "danger" : "neutral"} title={`Failure score ${signal.failureScore.toFixed(2)}`}>
                          {signal.isFailure ? "Failure report" : "Question"}
                        </Badge>
                      ) : (
                        <span className="muted">Reading…</span>
                      )}
                    </td>
                    <td className="nowrap">{incidentId ? <Badge mono>{incidentId}</Badge> : <span className="muted">–</span>}</td>
                    <td className="nowrap">
                      <CustomerImpactCell state={state} view={view} />
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
