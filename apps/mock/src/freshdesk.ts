import { MOCK } from "@crisiscrew/contracts";
import { Hono } from "hono";
import { apiKeyAuth, invalid, json, logCalls, notFound } from "./freshworks";
import { htmlToText, iso, textToHtml, type DeskTicket, type Store } from "./store";

export type NewDeskTicket = { email: string; name?: string; subject: string; description: string; source?: number; priority?: number; status?: number };

/**
 * Files a ticket the way Freshdesk does: the contact is made on first sight
 * of the email, then the automation rule tells CrisisCrew by webhook.
 */
export function createDeskTicket(store: Store, input: NewDeskTicket): DeskTicket {
  const contact = store.contactFor(input.email, input.name);
  const now = iso();
  const description = input.description.includes("<") ? input.description : textToHtml(input.description);
  const ticket: DeskTicket = {
    id: store.next("desk"),
    subject: input.subject,
    description,
    description_text: htmlToText(description),
    source: input.source ?? 2,
    status: input.status ?? 2,
    priority: input.priority ?? 1,
    requester_id: contact.id,
    created_at: now,
    updated_at: now,
    conversations: [],
  };
  store.deskTickets.push(ticket);
  store.touch();
  void store.webhook("freshdesk", "/api/webhooks/freshdesk", { ticket_id: ticket.id });
  return ticket;
}

/** A ticket as Freshdesk's API v2 returns it, with the requester and description when asked. */
function view(store: Store, t: DeskTicket, include: string[]) {
  const { conversations: _c, ...rest } = t;
  const requester = store.contacts.find((c) => c.id === t.requester_id);
  return {
    ...rest,
    ...(include.includes("requester") && requester ? { requester: { id: requester.id, name: requester.name, email: requester.email, phone: requester.phone, mobile: requester.mobile } } : {}),
  };
}

/** The Freshdesk REST API v2, as much of it as CrisisCrew and the seed script use. */
export function freshdeskApi(store: Store): Hono {
  const app = new Hono();
  app.use("/api/*", logCalls(store, "freshdesk"), apiKeyAuth(MOCK.freshdeskApiKey));

  app.post("/api/v2/tickets", async (c) => {
    const body = await json(c);
    if (!body) return c.json({ description: "body must be JSON" }, 400);
    const errors = [];
    if (typeof body.email !== "string" || !body.email.includes("@")) errors.push({ field: "email", message: "It should be a valid email address" });
    if (typeof body.subject !== "string" || !body.subject.trim()) errors.push({ field: "subject", message: "It should be a non-empty string" });
    if (typeof body.description !== "string" || !body.description.trim()) errors.push({ field: "description", message: "It should be a non-empty string" });
    if (errors.length) return invalid(c, errors);
    const ticket = createDeskTicket(store, {
      email: body.email as string,
      subject: body.subject as string,
      description: body.description as string,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.source === "number" ? { source: body.source } : {}),
      ...(typeof body.priority === "number" ? { priority: body.priority } : {}),
      ...(typeof body.status === "number" ? { status: body.status } : {}),
    });
    return c.json(view(store, ticket, []), 201);
  });

  app.get("/api/v2/tickets", (c) => {
    const since = Date.parse(c.req.query("updated_since") ?? "");
    const include = (c.req.query("include") ?? "").split(",");
    const perPage = Math.min(100, Number(c.req.query("per_page") ?? 30) || 30);
    const desc = c.req.query("order_type") !== "asc";
    const tickets = store.deskTickets
      .filter((t) => Number.isNaN(since) || Date.parse(t.updated_at) >= since)
      .sort((a, b) => (desc ? b.id - a.id : a.id - b.id))
      .slice(0, perPage)
      .map((t) => {
        const v = view(store, t, include);
        // Freshdesk lists leave the description out unless asked.
        if (!include.includes("description")) {
          const { description: _d, description_text: _dt, ...short } = v;
          return short;
        }
        return v;
      });
    return c.json(tickets);
  });

  app.get("/api/v2/tickets/:id", (c) => {
    const ticket = store.deskTickets.find((t) => t.id === Number(c.req.param("id")));
    return ticket ? c.json(view(store, ticket, (c.req.query("include") ?? "").split(","))) : notFound(c);
  });

  app.get("/api/v2/tickets/:id/conversations", (c) => {
    const ticket = store.deskTickets.find((t) => t.id === Number(c.req.param("id")));
    return ticket ? c.json(ticket.conversations) : notFound(c);
  });

  for (const kind of ["notes", "reply"] as const) {
    app.post(`/api/v2/tickets/:id/${kind}`, async (c) => {
      const ticket = store.deskTickets.find((t) => t.id === Number(c.req.param("id")));
      if (!ticket) return notFound(c);
      const body = await json(c);
      if (typeof body?.body !== "string" || !body.body.trim()) return invalid(c, [{ field: "body", message: "It should be a non-empty string" }]);
      const conversation = store.conversation(body.body, kind === "notes" && body.private !== false ? "note" : "reply");
      ticket.conversations.push(conversation);
      ticket.updated_at = iso();
      // A reply sent to the customer moves the ticket to pending, as in Freshdesk.
      if (kind === "reply") ticket.status = 3;
      store.touch();
      return c.json({ ...conversation, ticket_id: ticket.id }, 201);
    });
  }

  app.get("/api/v2/contacts", (c) => c.json(store.contacts));

  return app;
}
