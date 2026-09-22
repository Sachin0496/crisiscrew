import type { CrisisState } from "@crisiscrew/contracts";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { clock, initials, surface } from "../format";

export function Signals({ state }: { state: CrisisState }) {
  const tickets = [...state.ticketOrder].reverse().map((id) => state.tickets[id]!);
  return (
    <section className="card pad" id="signals" aria-label="Incoming tickets">
      <div className="cardhead">
        <h2>Incoming tickets</h2>
        <span className="aside">{tickets.length} read · newest first</span>
      </div>
      {tickets.length === 0 ? (
        <div className="empty">No tickets yet. Run a replay, or type a complaint below and send a few similar ones.</div>
      ) : (
        <div className="signal-list">
          {tickets.map(({ ticket, signal, incidentId }) => (
            <article className={`signal ${incidentId ? "linked" : ""}`} key={ticket.id}>
              <div className="avatar" aria-hidden>
                {initials(ticket.customerName)}
              </div>
              <div>
                <div className="msg">“{ticket.body}”</div>
                <div className="meta">
                  <span>
                    {ticket.customerName} · {ticket.channel} · {clock(ticket.receivedAt)} · {ticket.id}
                  </span>
                  {signal && <span className="badge surface">{surface(signal.surface)}</span>}
                  {signal && (
                    <span className={`badge ${signal.isFailure ? "failure" : "question"}`} title={`failure score ${signal.failureScore.toFixed(2)}`}>
                      {signal.isFailure ? "reports a failure" : "question or request"}
                    </span>
                  )}
                  {ticket.source === "manual" && <span className="badge manual">typed here</span>}
                  {incidentId && <span className="badge incident">{incidentId}</span>}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <AddTicket />
    </section>
  );
}

function AddTicket() {
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) return;
    setSending(true);
    setError(null);
    try {
      await api.addTicket({ customerName: name.trim() || "Walk-in customer", channel: "chat", body: body.trim() });
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <div className="add-ticket">
        <label className="sr-only" htmlFor="ticket-body">
          Complaint
        </label>
        <input
          id="ticket-body"
          className="input"
          placeholder="Type a complaint, e.g. “the payment page just spins”"
          value={body}
          maxLength={500}
          onChange={(e) => setBody(e.target.value)}
        />
        <label className="sr-only" htmlFor="ticket-name">
          Customer name
        </label>
        <input id="ticket-name" className="input" placeholder="Your name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={sending || !body.trim()}>
          Send
        </button>
      </div>
      {error && (
        <div className="faint" role="alert" style={{ marginTop: 8, fontSize: 12.5 }}>
          Couldn't send: {error}
        </div>
      )}
    </form>
  );
}
