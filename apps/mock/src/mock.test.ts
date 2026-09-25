import {
  FreshdeskClient,
  FreshserviceAlertsClient,
  FreshworksError,
  freshserviceAlertToInput,
  freshserviceIncidents,
  freshserviceOnCall,
  vobizTelephony,
  type VobizCallback,
} from "@crisiscrew/adapters";
import { MOCK, mockPorts } from "@crisiscrew/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createMock } from "./app";
import { parseAnswerXml } from "./vobiz";

const ports = mockPorts();
const CRISISCREW = "http://crisis.test";

/**
 * One fetch for everything: requests to the mock's ports go to its apps,
 * requests to CrisisCrew go to `crisiscrew`. So the real adapters talk to
 * the mock exactly as they would over the network.
 */
function network(crisiscrew: (req: Request) => Promise<Response> | Response) {
  let mock: ReturnType<typeof createMock>;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === CRISISCREW) return crisiscrew(req);
    const app = { [ports.freshdesk]: mock.apps.freshdesk, [ports.freshservice]: mock.apps.freshservice, [ports.vobiz]: mock.apps.vobiz }[Number(url.port)];
    if (!app) throw new Error(`nothing listens at ${url.origin}`);
    return app.fetch(req);
  }) as typeof fetch;
  mock = createMock({ crisiscrewUrl: CRISISCREW, uiOrigin: `http://localhost:${ports.freshdesk}`, fetch: fetchImpl, phone: { pace: 0.001 } });
  return { mock, fetch: fetchImpl };
}

const until = async (check: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
};

let stop: (() => void) | null = null;
afterEach(() => stop?.());

describe("mock Freshdesk", () => {
  it("files a ticket, tells CrisisCrew by webhook, and takes CrisisCrew's notes and replies", async () => {
    const hooks: { path: string; secret: string | null; body: unknown }[] = [];
    const { mock, fetch } = network(async (req) => {
      hooks.push({ path: new URL(req.url).pathname, secret: req.headers.get("x-crisiscrew-secret"), body: await req.json() });
      return new Response(null, { status: 202 });
    });
    stop = mock.stop;
    const client = new FreshdeskClient({ domain: `localhost:${ports.freshdesk}`, apiKey: MOCK.freshdeskApiKey, fetch });

    const created = await client.createTicket({ email: "priya.k@example.com", name: "Priya K.", subject: "Checkout spins", description: "The payment page just spins." });
    await until(() => hooks.length === 1);
    expect(hooks[0]).toEqual({ path: "/api/webhooks/freshdesk", secret: MOCK.webhookSecret, body: { ticket_id: created.id } });

    const read = await client.ticket(created.id);
    expect(read.requester?.email).toBe("priya.k@example.com");
    expect(read.description_text).toBe("The payment page just spins.");
    expect((await client.ticketsUpdatedSince(new Date(Date.now() - 60_000))).map((t) => t.id)).toEqual([created.id]);

    await client.addNote(created.id, "Linked to INC-1");
    await client.reply(created.id, "We're on it.\nNo need to pay again.");
    const ticket = mock.store.deskTickets[0]!;
    expect(ticket.conversations.map((c) => [c.kind, c.body_text])).toEqual([
      ["note", "Linked to INC-1"],
      ["reply", "We're on it.\nNo need to pay again."],
    ]);
    expect(client.ticketUrl(created.id)).toBe(`http://localhost:${ports.freshdesk}/a/tickets/${created.id}`);
  });

  it("refuses a wrong API key the way Freshdesk does", async () => {
    const { mock, fetch } = network(() => new Response(null, { status: 202 }));
    stop = mock.stop;
    const client = new FreshdeskClient({ domain: `localhost:${ports.freshdesk}`, apiKey: "wrong", fetch });
    await expect(client.ticket(1)).rejects.toBeInstanceOf(FreshworksError);
    await expect(client.ticket(1)).rejects.toMatchObject({ status: 401 });
  });
});

describe("mock Freshservice", () => {
  it("takes an incident with its priority, notes, change and problem", async () => {
    const { mock, fetch } = network(() => new Response(null, { status: 202 }));
    stop = mock.stop;
    const incidents = freshserviceIncidents({ domain: `localhost:${ports.freshservice}`, apiKey: MOCK.freshserviceApiKey, requesterEmail: MOCK.requesterEmail, fetch });

    const record = await incidents.open({ incidentId: "INC-1", title: "Checkout payments failing", description: "23 customers", importance: "P2", service: "checkout-service", tags: ["crisiscrew"] });
    await incidents.setImportance(record.id, "P1");
    await incidents.note(record.id, "Likely cause: checkout-service v4.21.7 (97%)");
    const change = await incidents.requestChange!(record.id, { title: "Roll back v4.21.7", description: "Rollback", importance: "P1", service: "checkout-service" });
    const problem = await incidents.openProblem!(record.id, { title: "Review", description: "Post-incident review", importance: "P1", service: "checkout-service" });

    const ticket = mock.store.serviceTickets[0]!;
    expect(record.url).toBe(`http://localhost:${ports.freshservice}/a/tickets/${ticket.id}`);
    expect(ticket).toMatchObject({ priority: 4, urgency: 3, impact: 3, tags: ["crisiscrew"], change_id: Number(change.id.slice(4)), problem_id: Number(problem.id.slice(4)) });
    expect(ticket.notes.map((n) => n.body_text)).toEqual(["Likely cause: checkout-service v4.21.7 (97%)"]);
  });

  it("answers who's on call from the scenario's roster, primary first", async () => {
    const { mock, fetch } = network(() => new Response(null, { status: 202 }));
    stop = mock.stop;
    const oncall = freshserviceOnCall({ domain: `localhost:${ports.freshservice}`, apiKey: MOCK.freshserviceApiKey, defaultScheduleId: MOCK.oncallScheduleId, fetch });
    const responders = await oncall.whoIsOnCall("checkout-service");
    expect(responders.map((r) => [r.name, r.role])).toEqual([
      ["Neha Kapoor", "primary"],
      ["Rohan Mehta", "secondary"],
    ]);
  });

  it("fires an alert that CrisisCrew reads back as a critical checkout alert", async () => {
    const hooks: unknown[] = [];
    const { mock, fetch } = network(async (req) => {
      hooks.push(await req.json());
      return new Response(null, { status: 202 });
    });
    stop = mock.stop;
    const res = await mock.apps.freshdesk.fetch(
      new Request("http://localhost/mock/freshservice/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ preset: 0 }) }),
    );
    const fired = (await res.json()) as { id: number };
    await until(() => hooks.length === 1);
    expect(hooks[0]).toEqual({ alert_id: fired.id });

    const client = new FreshserviceAlertsClient({ domain: `localhost:${ports.freshservice}`, apiKey: MOCK.freshserviceApiKey, fetch });
    const input = freshserviceAlertToInput(await client.alert(fired.id), []);
    expect(input).toMatchObject({ service: "checkout-service", severity: "critical", source: "freshservice" });
    expect((await client.updatedSince(new Date(Date.now() - 60_000))).map((a) => a.id)).toEqual([fired.id]);
  });
});

describe("mock Vobiz", () => {
  function phoneLine() {
    // CrisisCrew's side: the real Vobiz adapter, answering the callbacks the mock sends it.
    let telephony: ReturnType<typeof vobizTelephony>;
    const { mock, fetch } = network(async (req) => {
      const url = new URL(req.url);
      const [, , , , callId, kind] = url.pathname.split("/");
      if (!telephony.verifySignature(telephony.callbackUrl(callId!, kind as VobizCallback), (name) => req.headers.get(name) ?? undefined)) {
        return new Response("bad signature", { status: 401 });
      }
      const params = Object.fromEntries(new URLSearchParams(await req.text()));
      const reply = telephony.handleCallback(callId!, kind as VobizCallback, params);
      return new Response(reply ?? null, { status: reply === null ? 204 : 200 });
    });
    telephony = vobizTelephony({
      authId: MOCK.vobizAuthId,
      authToken: MOCK.vobizAuthToken,
      from: MOCK.vobizFrom,
      publicBaseUrl: CRISISCREW,
      apiBase: `http://localhost:${ports.vobiz}`,
      fetch,
    });
    stop = mock.stop;
    return { mock, telephony };
  }

  it("rings the on-call engineer, plays the page, and they press 1 on autopilot", async () => {
    const { mock, telephony } = phoneLine();
    const { callId } = await telephony.call({ to: "+91 90000 10001", script: "P1 incident on checkout.", purpose: "oncall", gather: { prompt: "Press 1 to acknowledge." } });
    await until(() => mock.store.calls[0]?.state === "completed");
    const view = await telephony.status(callId);
    expect(view).toMatchObject({ state: "completed", digits: "1" });
    expect(mock.store.calls[0]!.lines.map((l) => `${l.who}: ${l.text}`)).toEqual(["agent: P1 incident on checkout.", "agent: Press 1 to acknowledge.", "callee: Pressed 1", "agent: Thank you. Goodbye."]);
  });

  it("lets a customer's call go unanswered, as the scenario says for Farhan", async () => {
    const { mock, telephony } = phoneLine();
    const { callId } = await telephony.call({ to: "+91 90000 00009", script: "About your payment.", purpose: "customer" });
    await until(() => mock.store.calls[0]?.state === "no_answer");
    expect(await telephony.status(callId)).toMatchObject({ state: "no_answer" });
  });

  it("waits for a person when autopilot is off", async () => {
    const { mock, telephony } = phoneLine();
    mock.store.autopilot = false;
    const { callId } = await telephony.call({ to: "+91 90000 00003", script: "Hello Ananya.", purpose: "customer", gather: { prompt: "Press 1 for your payment status." } });
    await until(() => mock.store.calls[0]?.state === "ringing");
    const uuid = mock.store.calls[0]!.uuid;
    expect(await mock.phone.answer(uuid)).toBe(true);
    expect(await mock.phone.press(uuid, "2")).toBe(true);
    await until(() => mock.store.calls[0]?.state === "completed");
    expect(await telephony.status(callId)).toMatchObject({ state: "completed", digits: "2" });
  });

  it("refuses a call with the wrong credentials", async () => {
    const { mock } = phoneLine();
    const res = await mock.apps.vobiz.fetch(new Request(`http://localhost/api/v1/Account/${MOCK.vobizAuthId}/Call/`, { method: "POST", headers: { "x-auth-id": MOCK.vobizAuthId, "x-auth-token": "nope" } }));
    expect(res.status).toBe(401);
  });
});

describe("parseAnswerXml", () => {
  it("reads what's said and where the key press goes", () => {
    const xml = `<?xml version="1.0"?><Response><Speak>Hi &amp; hello.</Speak><Gather action="http://x/digits" method="POST"><Speak>Press 1.</Speak></Gather><Hangup/></Response>`;
    expect(parseAnswerXml(xml)).toEqual({ said: ["Hi & hello."], gather: { action: "http://x/digits", prompt: "Press 1.", speech: false }, fallback: [] });
  });
});
