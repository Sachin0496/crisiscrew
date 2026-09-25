import type { Ticket } from "@crisiscrew/contracts";
import type { TicketActionsPort } from "@crisiscrew/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FreshdeskClient, freshdeskIdOf, freshdeskTicketActions, freshdeskToTicketInput, restWriter, type FreshdeskTicket } from "./freshdesk";
import { freshdeskMcpWriter, shapeTool } from "./freshdesk-mcp";
import { freshserviceIncidents, freshserviceOnCall } from "./freshservice";
import { FreshworksError, htmlToText, normalizeDomain, textToHtml } from "./http";

type Call = { method: string; url: string; auth: string | null; body: unknown };

/** A fake Freshworks API: records every request and answers from a table keyed by "METHOD path". */
function fakeApi(responses: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, url: url.toString(), auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const answer = responses[`${method} ${url.pathname}`] ?? { status: 404, body: { description: "not found" } };
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status ?? 200, headers: answer.headers });
  });
  return { calls, fetch: fetch as unknown as typeof globalThis.fetch };
}

const basic = `Basic ${Buffer.from("fd-key:X").toString("base64")}`;

describe("Freshworks HTTP helpers", () => {
  it("normalises a domain from a name, a host or a URL", () => {
    expect(normalizeDomain("acme", "freshdesk.com")).toBe("acme.freshdesk.com");
    expect(normalizeDomain(" https://Acme.freshdesk.com/a/tickets ", "freshdesk.com")).toBe("acme.freshdesk.com");
    expect(normalizeDomain("acme", "freshservice.com")).toBe("acme.freshservice.com");
  });

  it("turns text into safe HTML and back", () => {
    expect(textToHtml('Hi <b>Priya</b> & "team"\nline two')).toBe("Hi &lt;b&gt;Priya&lt;/b&gt; &amp; &quot;team&quot;<br>line two");
    expect(htmlToText("<div>Payment failed&nbsp;twice</div><p>Card &amp; UPI</p>")).toBe("Payment failed twice\nCard & UPI");
  });
});

describe("FreshdeskClient", () => {
  it("reads a ticket with its requester, using the API key as Basic auth", async () => {
    const api = fakeApi({ "GET /api/v2/tickets/42": { body: { id: 42, created_at: "2026-09-25T08:42:45Z" } } });
    const client = new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: api.fetch });
    expect(await client.ticket(42)).toMatchObject({ id: 42 });
    expect(api.calls[0]).toMatchObject({ method: "GET", url: "https://acme.freshdesk.com/api/v2/tickets/42?include=requester", auth: basic });
  });

  it("lists recent tickets oldest first with requester and description, for the poll fallback", async () => {
    const api = fakeApi({ "GET /api/v2/tickets": { body: [] } });
    await new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: api.fetch }).ticketsUpdatedSince(new Date("2026-09-25T08:40:00.123Z"));
    const url = new URL(api.calls[0]!.url);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      updated_since: "2026-09-25T08:40:00Z",
      order_by: "created_at",
      order_type: "asc",
      per_page: "100",
      include: "requester,description",
    });
  });

  it("writes a private note and a reply as HTML", async () => {
    const api = fakeApi({ "POST /api/v2/tickets/42/notes": { status: 201, body: { id: 1 } }, "POST /api/v2/tickets/42/reply": { status: 201, body: { id: 2 } } });
    const client = new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: api.fetch });
    await client.addNote(42, "Linked to INC-2026-001\nby CrisisCrew");
    await client.reply(42, "Hi Priya");
    expect(api.calls.map((c) => [c.method, new URL(c.url).pathname, c.body])).toEqual([
      ["POST", "/api/v2/tickets/42/notes", { body: "Linked to INC-2026-001<br>by CrisisCrew", private: true }],
      ["POST", "/api/v2/tickets/42/reply", { body: "Hi Priya" }],
    ]);
  });

  it("says what Freshdesk answered when a call fails, including a rate limit's wait", async () => {
    const api = fakeApi({
      "POST /api/v2/tickets/42/notes": { status: 400, body: { description: "Validation failed", errors: [{ field: "body", message: "It should not be blank" }] } },
      "GET /api/v2/tickets/7": { status: 429, body: { message: "Rate limit exceeded" }, headers: { "retry-after": "31" } },
    });
    const client = new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: api.fetch });
    await expect(client.addNote(42, "x")).rejects.toThrow("acme.freshdesk.com POST /api/v2/tickets/42/notes failed with 400: Validation failed; body: It should not be blank");
    const limited = await client.ticket(7).catch((e: unknown) => e);
    expect(limited).toBeInstanceOf(FreshworksError);
    expect(limited).toMatchObject({ status: 429, retryAfterSec: 31 });
  });
});

describe("Freshdesk tickets as CrisisCrew tickets", () => {
  const base: FreshdeskTicket = {
    id: 42,
    subject: "Payment failed",
    description_text: "My checkout keeps loading forever.",
    source: 7,
    created_at: "2026-09-25T08:42:45Z",
    requester: { id: 9001, name: "Priya K.", email: "priya.k@example.com" },
  };

  it("keeps the Freshdesk id, the channel and a matched customer's reference", () => {
    expect(freshdeskToTicketInput(base, { ref: "c-priya", name: "Priya K." })).toEqual({
      customerRef: "c-priya",
      customerName: "Priya K.",
      channel: "chat",
      subject: "Payment failed",
      body: "My checkout keeps loading forever.",
      externalId: "freshdesk:42",
    });
  });

  it("keeps an unmatched requester as a Freshdesk requester, and falls back to the HTML description", () => {
    const input = freshdeskToTicketInput({ ...base, description_text: null, description: "<div>Card rejected at checkout</div>", source: 1 }, null);
    expect(input).toMatchObject({ customerRef: "freshdesk:requester:9001", customerName: "Priya K.", channel: "email", body: "Card rejected at checkout" });
    expect(freshdeskToTicketInput({ ...base, subject: "", description_text: "" }, null)).toBeNull();
  });

  it("recognises only Freshdesk tickets as Freshdesk's", () => {
    const t = (source: Ticket["source"], externalId?: string) => ({ source, ...(externalId ? { externalId } : {}) }) as Ticket;
    expect(freshdeskIdOf(t("freshdesk", "freshdesk:42"))).toBe(42);
    expect(freshdeskIdOf(t("sandbox", "freshdesk:42"))).toBeNull();
    expect(freshdeskIdOf(t("freshdesk", "freshdesk:abc"))).toBeNull();
  });

  it("sends notes and replies for Freshdesk tickets to Freshdesk, and everything else to the sandbox", async () => {
    const api = fakeApi({ "POST /api/v2/tickets/42/notes": { status: 201, body: {} } });
    const sandbox: TicketActionsPort = { mode: "sandbox", adapter: "sandbox", addNote: vi.fn(async () => undefined), reply: vi.fn(async () => undefined) };
    const actions = freshdeskTicketActions(restWriter(new FreshdeskClient({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: api.fetch })), sandbox);
    const fromFreshdesk = { id: "T-1004", source: "freshdesk", externalId: "freshdesk:42" } as Ticket;
    const fromReplay = { id: "T-1005", source: "sandbox" } as Ticket;
    await actions.addNote(fromFreshdesk, "note");
    await actions.addNote(fromReplay, "note");
    expect(api.calls).toHaveLength(1);
    expect(sandbox.addNote).toHaveBeenCalledWith(fromReplay, "note");
    expect([actions.adapterFor?.(fromFreshdesk), actions.adapterFor?.(fromReplay)]).toEqual(["freshdesk", "sandbox"]);
  });
});

/** A stand-in for Freshdesk's MCP server, built with the MCP SDK, answering one stateless request at a time. */
function fakeFreshdeskMcp(schema: "snake" | "camel" = "snake") {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const auth: (string | null)[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    auth.push(new Headers(init?.headers).get("authorization"));
    const server = new McpServer({ name: "fake-freshdesk", version: "1.0.0" });
    const idKey = schema === "snake" ? "ticket_id" : "ticketId";
    for (const tool of ["createTicketNote", "replyTicket"]) {
      server.registerTool(
        tool,
        { description: tool, inputSchema: { [idKey]: z.number(), body: z.string(), ...(tool === "createTicketNote" ? { private: z.boolean().optional() } : {}) } },
        async (args) => {
          calls.push({ tool, args: args as Record<string, unknown> });
          return { content: [{ type: "text" as const, text: "done" }] };
        },
      );
    }
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(new Request(input, init));
  }) as typeof globalThis.fetch;
  return { calls, auth, fetch };
}

describe("Freshdesk MCP writer", () => {
  it("writes notes and replies through createTicketNote and replyTicket, authenticated with the API key", async () => {
    const mcp = fakeFreshdeskMcp();
    const writer = freshdeskMcpWriter({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: mcp.fetch });
    await writer.note(42, "Linked to INC-2026-001");
    await writer.reply(42, "Hi Priya");
    expect(mcp.calls).toEqual([
      { tool: "createTicketNote", args: { ticket_id: 42, body: "Linked to INC-2026-001", private: true } },
      { tool: "replyTicket", args: { ticket_id: 42, body: "Hi Priya" } },
    ]);
    expect(mcp.auth.every((a) => a === "fd-key")).toBe(true);
    expect(writer.adapter).toBe("freshdesk-mcp");
  });

  it("reads the argument names from each tool's schema", async () => {
    const mcp = fakeFreshdeskMcp("camel");
    await freshdeskMcpWriter({ domain: "acme.freshdesk.com", apiKey: "fd-key", fetch: mcp.fetch }).reply(7, "Hello");
    expect(mcp.calls).toEqual([{ tool: "replyTicket", args: { ticketId: 7, body: "Hello" } }]);
    expect(() => shapeTool({ name: "replyTicket", inputSchema: { properties: { text: {} } } }, false)).toThrow(/needs a ticket id and a body/);
  });
});

describe("Freshservice incidents", () => {
  it("files an open incident at its importance's priority as the configured requester, raises it, and adds private notes", async () => {
    const api = fakeApi({
      "POST /api/v2/tickets": { status: 201, body: { ticket: { id: 314 } } },
      "PUT /api/v2/tickets/314": { status: 200, body: { ticket: { id: 314 } } },
      "POST /api/v2/tickets/314/notes": { status: 201, body: { conversation: { id: 1 } } },
    });
    const port = freshserviceIncidents({ domain: "acme.freshservice.com", apiKey: "fs-key", requesterEmail: "ops@acme.test", workspaceId: 2, fetch: api.fetch });
    const record = await port.open({ incidentId: "INC-2026-001", title: "Checkout and payment failures (INC-2026-001)", description: "8 reports\nopened", importance: "P2" });
    await port.setImportance(record.id, "P1");
    await port.note(record.id, "Root cause: checkout-service v4.21.7");
    expect(record).toEqual({ id: "#314", url: "https://acme.freshservice.com/a/tickets/314" });
    expect(api.calls.map((c) => c.body)).toEqual([
      { subject: "Checkout and payment failures (INC-2026-001)", description: "8 reports<br>opened", email: "ops@acme.test", priority: 3, urgency: 2, impact: 2, status: 2, workspace_id: 2 },
      { priority: 4, urgency: 3, impact: 3 },
      { body: "Root cause: checkout-service v4.21.7", private: true },
    ]);
    expect(api.calls[0]?.auth).toBe(`Basic ${Buffer.from("fs-key:X").toString("base64")}`);
    expect(port.mode).toBe("live");
  });
});

describe("Freshservice on-call", () => {
  const user = (id: number, name: string, phone: string | null, mobile: string | null = null) => ({ id, name, email: `${name.split(" ")[0]!.toLowerCase()}@acme.test`, phone, mobile, agent: true });
  it("asks the service's schedule who's on call now, primary first, each person once, preferring their mobile", async () => {
    const api = fakeApi({
      "GET /api/v2/oncall/shift-events/current": {
        body: {
          shift_events: [
            { user: user(16, "Staging Agent", null), roster_type: "SECONDARY" },
            { user: user(47, "John Doe", "+13232323232", "+919000011111"), roster_type: "TERTIARY" },
            { user: user(47, "John Doe", "+13232323232", "+919000011111"), roster_type: "PRIMARY" },
            { user: user(52, "Asha Rao", "+919000022222"), roster_type: "BACKUP" },
          ],
        },
      },
    });
    const port = freshserviceOnCall({ domain: "acme.freshservice.com", apiKey: "fs-key", defaultScheduleId: 8569, schedules: { "checkout-service": 8570 }, fetch: api.fetch });
    expect(await port.whoIsOnCall("checkout-service")).toEqual([
      { name: "John Doe", role: "primary", phone: "+919000011111", email: "john@acme.test" },
      { name: "Staging Agent", role: "secondary", email: "staging@acme.test" },
    ]);
    await port.whoIsOnCall("auth-service");
    expect(api.calls.map((c) => c.url)).toEqual([
      "https://acme.freshservice.com/api/v2/oncall/shift-events/current?schedule_id=8570",
      "https://acme.freshservice.com/api/v2/oncall/shift-events/current?schedule_id=8569",
    ]);
    expect(port).toMatchObject({ mode: "live", adapter: "freshservice" });
  });
});
