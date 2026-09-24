import type { Channel, Customer, Ticket, TicketInput } from "@crisiscrew/contracts";
import type { TicketActionsPort } from "@crisiscrew/core";
import { freshworksRequest, htmlToText, textToHtml, type FreshworksAuth } from "./http";

/** The fields CrisisCrew reads from a Freshdesk ticket (API v2). */
export type FreshdeskTicket = {
  id: number;
  subject?: string | null;
  description?: string | null;
  description_text?: string | null;
  source?: number | null;
  created_at: string;
  updated_at?: string;
  requester_id?: number | null;
  requester?: { id: number; name?: string | null; email?: string | null; phone?: string | null; mobile?: string | null } | null;
};

/** Freshdesk REST API v2: read tickets, and write private notes and replies. */
export class FreshdeskClient {
  constructor(private readonly auth: FreshworksAuth) {}

  get domain(): string {
    return this.auth.domain;
  }

  /** A ticket with its requester, as the webhook's ticket id points to it. */
  ticket(id: number): Promise<FreshdeskTicket> {
    return freshworksRequest<FreshdeskTicket>(this.auth, "GET", `/api/v2/tickets/${id}?include=requester`);
  }

  /** Tickets updated since a time, oldest first, with requester and description: the poll fallback. */
  ticketsUpdatedSince(since: Date): Promise<FreshdeskTicket[]> {
    const query = new URLSearchParams({
      updated_since: since.toISOString().replace(/\.\d{3}Z$/, "Z"),
      order_by: "created_at",
      order_type: "asc",
      per_page: "100",
      include: "requester,description",
    });
    return freshworksRequest<FreshdeskTicket[]>(this.auth, "GET", `/api/v2/tickets?${query}`);
  }

  async addNote(ticketId: number, text: string): Promise<void> {
    await freshworksRequest(this.auth, "POST", `/api/v2/tickets/${ticketId}/notes`, { body: textToHtml(text), private: true });
  }

  async reply(ticketId: number, text: string): Promise<void> {
    await freshworksRequest(this.auth, "POST", `/api/v2/tickets/${ticketId}/reply`, { body: textToHtml(text) });
  }

  ticketUrl(ticketId: number): string {
    return `https://${this.auth.domain}/a/tickets/${ticketId}`;
  }
}

/** Freshdesk ticket sources: 1 email, 2 portal, 3 phone, 7 chat, 9 feedback widget, 10 outbound email. */
const SOURCES: Record<number, Channel> = { 1: "email", 2: "portal", 3: "phone", 7: "chat", 9: "portal", 10: "email" };

export const FRESHDESK_PREFIX = "freshdesk:";

/** The Freshdesk ticket id behind a CrisisCrew ticket, or null when it didn't come from Freshdesk. */
export function freshdeskIdOf(ticket: Pick<Ticket, "source" | "externalId">): number | null {
  if (ticket.source !== "freshdesk" || !ticket.externalId?.startsWith(FRESHDESK_PREFIX)) return null;
  const id = Number(ticket.externalId.slice(FRESHDESK_PREFIX.length));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * A Freshdesk ticket as a CrisisCrew ticket. The requester is matched to a
 * customer in the orders data (by email) when possible; otherwise they stay a
 * Freshdesk requester, and the impact graph will mark them unverified until a
 * failed payment is on record. Returns null for a ticket with no text.
 */
export function freshdeskToTicketInput(t: FreshdeskTicket, customer: Pick<Customer, "ref" | "name"> | null): TicketInput | null {
  const body = (t.description_text?.trim() || (t.description ? htmlToText(t.description) : "") || t.subject?.trim() || "").slice(0, 2000);
  if (!body) return null;
  const requesterId = t.requester?.id ?? t.requester_id;
  return {
    customerRef: customer?.ref ?? `freshdesk:requester:${requesterId ?? "unknown"}`,
    customerName: (customer?.name ?? t.requester?.name ?? t.requester?.email ?? "Freshdesk requester").slice(0, 80),
    channel: SOURCES[t.source ?? 2] ?? "portal",
    ...(t.subject?.trim() && t.subject.trim() !== body ? { subject: t.subject.trim().slice(0, 200) } : {}),
    body,
    externalId: `${FRESHDESK_PREFIX}${t.id}`,
  };
}

/** Where notes and replies for Freshdesk tickets go: the REST API or Freshdesk's MCP server. */
export type FreshdeskWriter = {
  adapter: string;
  note(ticketId: number, text: string): Promise<void>;
  reply(ticketId: number, text: string): Promise<void>;
};

export function restWriter(client: FreshdeskClient): FreshdeskWriter {
  return { adapter: "freshdesk", note: (id, text) => client.addNote(id, text), reply: (id, text) => client.reply(id, text) };
}

/**
 * Ticket actions for a session with live Freshdesk: notes and replies for
 * tickets that came from Freshdesk go to Freshdesk; tickets from a replay or
 * typed into the UI keep using the sandbox, so a mixed session still works.
 */
export function freshdeskTicketActions(writer: FreshdeskWriter, sandbox: TicketActionsPort): TicketActionsPort {
  return {
    mode: "live",
    adapter: writer.adapter,
    adapterFor: (ticket) => (freshdeskIdOf(ticket) === null ? sandbox.adapter : writer.adapter),
    async addNote(ticket, text) {
      const id = freshdeskIdOf(ticket);
      return id === null ? sandbox.addNote(ticket, text) : writer.note(id, text);
    },
    async reply(ticket, text) {
      const id = freshdeskIdOf(ticket);
      return id === null ? sandbox.reply(ticket, text) : writer.reply(id, text);
    },
  };
}
