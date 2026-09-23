import { Send } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { api } from "../api";

/** Adds a ticket to the running session, as a customer would through a support channel. */
export function TicketComposer() {
  const [body, setBody] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const id = useId();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!body.trim()) {
      setError("Type the customer's message first.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      await api.addTicket({ customerName: name.trim() || "Walk-in customer", channel: "chat", body: body.trim() });
      setBody("");
    } catch (err) {
      setError(`Couldn't send the ticket: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="composer" onSubmit={submit} aria-label="New ticket">
      <div className="composer-row">
        <label className="sr-only" htmlFor={`${id}-body`}>
          Customer message
        </label>
        <input
          id={`${id}-body`}
          className="input message"
          placeholder="The payment page just spins after I click pay"
          value={body}
          maxLength={500}
          onChange={(e) => {
            setBody(e.target.value);
            setError(null);
          }}
        />
        <label className="sr-only" htmlFor={`${id}-name`}>
          Customer name
        </label>
        <input id={`${id}-name`} className="input name" placeholder="Customer name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        <button className="btn" type="submit" disabled={sending}>
          <Send size={14} aria-hidden />
          Send
        </button>
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </form>
  );
}
