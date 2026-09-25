import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { CrisisWatcher } from "./crisis";
import { createDeskTicket } from "./freshdesk";
import { freshdeskApi } from "./freshdesk";
import { json, recordLinks } from "./freshworks";
import { acknowledge, fireAlert, freshserviceApi, resolveAlert, type NewAlert } from "./freshservice";
import { Store } from "./store";
import { Phone, vobizApi, type PhoneOptions } from "./vobiz";
import { alertPresets, World } from "./world";

const SOURCES: Record<string, number> = { email: 1, portal: 2, phone: 3, chat: 7 };
const CHANNELS = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [v, k]));

/** The four complaints rehearsed for the live demo: they open the incident on the fourth. */
export const REHEARSED = [
  { email: "priya.k@example.com", name: "Priya K.", channel: "chat", body: "The payment page just spins after I click pay." },
  { email: "arjun.k@example.com", name: "Arjun K.", channel: "chat", body: "Paid with UPI, money gone from my account, but the app says order failed." },
  { email: "sneha.m@example.com", name: "Sneha M.", channel: "email", body: "My debit card keeps getting declined at checkout even though it works everywhere else." },
  { email: "varun.n@example.com", name: "Varun N.", channel: "chat", body: "Checkout crashes when I try to pay for my cart." },
];

export type MockOptions = {
  /** CrisisCrew's origin, for webhooks and its state. */
  crisiscrewUrl: string;
  /** CrisisCrew's admin token, if it has one: the reset button starts a fresh live session. */
  crisiscrewAdminToken?: string;
  /** Where the UI is served, for links from Freshworks record URLs. */
  uiOrigin: string;
  /** Webhooks, callbacks and state reads to CrisisCrew; the global fetch otherwise. */
  fetch?: typeof fetch;
  phone?: PhoneOptions;
  world?: World;
  /** Read CrisisCrew's state for the demo view (off in tests). */
  watch?: boolean;
};

const subjectOf = (body: string) => (body.length > 60 ? `${body.slice(0, 57).replace(/\s+\S*$/, "")}…` : body);

/** The three mock services and the UI, over one shared store. */
export function createMock(options: MockOptions) {
  const doFetch = options.fetch ?? fetch;
  const store = new Store({ url: options.crisiscrewUrl, fetch: doFetch });
  const world = options.world ?? new World();
  const phone = new Phone(store, world, { fetch: doFetch, ...options.phone });
  const crisis = new CrisisWatcher(options.crisiscrewUrl, () => store.touch(), doFetch);
  if (options.watch) crisis.start();
  const presets = alertPresets();
  let burst = { running: false, filed: 0, total: 0, timers: [] as ReturnType<typeof setTimeout>[] };

  const freshdesk = freshdeskApi(store);
  const freshservice = freshserviceApi(store, world);
  const vobiz = vobizApi(store, phone);
  recordLinks(freshdesk, options.uiOrigin, "freshdesk");
  recordLinks(freshservice, options.uiOrigin, "freshservice");

  const file = (input: { email: string; name?: string; channel?: string; subject?: string; body: string }) =>
    createDeskTicket(store, {
      email: input.email,
      ...(input.name ? { name: input.name } : {}),
      subject: input.subject || subjectOf(input.body),
      description: input.body,
      source: SOURCES[input.channel ?? "portal"] ?? 2,
    });

  const ui = freshdesk;
  const page = () => readFileSync(new URL("./ui.html", import.meta.url), "utf8");
  ui.get("/", (c) => c.html(page()));

  ui.get("/mock/state", (c) => {
    const person = (email: string) => world.people.find((p) => p.email?.toLowerCase() === email.toLowerCase());
    return c.json({
      version: store.version,
      autopilot: store.autopilot,
      crisiscrewUrl: options.crisiscrewUrl,
      crisis: crisis.latest,
      burst: { running: burst.running, filed: burst.filed, total: burst.total },
      freshdesk: store.deskTickets.map((t) => {
        const requester = store.contacts.find((x) => x.id === t.requester_id)!;
        return { ...t, channel: CHANNELS[t.source] ?? "portal", requester: { name: requester.name, email: requester.email, known: Boolean(person(requester.email)) } };
      }),
      freshservice: { tickets: store.serviceTickets, records: store.records, alerts: store.alerts, oncall: world.shiftEvents() },
      calls: store.calls.map((call) => {
        const who = world.byPhone(call.to);
        return { ...call, who: who ? { name: who.name, kind: who.kind, role: who.role ?? null } : null };
      }),
      log: store.log.slice(-120),
      people: world.people.filter((p) => p.email && p.kind === "customer").map((p) => ({ name: p.name, email: p.email })),
      rehearsed: REHEARSED,
      alertPresets: presets,
    });
  });

  ui.post("/mock/freshdesk/tickets", async (c) => {
    const body = await json(c);
    if (typeof body?.email !== "string" || !body.email.includes("@") || typeof body.body !== "string" || !body.body.trim()) {
      return c.json({ error: "email and body are required" }, 400);
    }
    const ticket = file({
      email: body.email.trim(),
      body: body.body.trim(),
      ...(typeof body.name === "string" && body.name.trim() ? { name: body.name.trim() } : {}),
      ...(typeof body.channel === "string" ? { channel: body.channel } : {}),
      ...(typeof body.subject === "string" ? { subject: body.subject.trim() } : {}),
    });
    return c.json(ticket, 201);
  });

  // Files a set of complaints a few seconds apart, as a real burst arrives.
  ui.post("/mock/freshdesk/burst", async (c) => {
    const body = (await json(c)) ?? {};
    if (burst.running) return c.json({ error: "a burst is already being filed" }, 409);
    const set = body.set === "scenario" ? world.complaints() : REHEARSED.map((r, i) => ({ ...r, atMs: i * 4_000 }));
    const gapScale = typeof body.speed === "number" && body.speed > 0 ? 1 / body.speed : 1;
    const t0 = set[0]?.atMs ?? 0;
    burst = { running: true, filed: 0, total: set.length, timers: [] };
    const current = burst;
    for (const item of set) {
      const timer = setTimeout(() => {
        file(item);
        current.filed += 1;
        if (current.filed === current.total) current.running = false;
        store.touch();
      }, (item.atMs - t0) * gapScale * (options.phone?.pace ?? 1));
      current.timers.push(timer);
    }
    store.touch();
    return c.json({ total: set.length }, 202);
  });

  ui.post("/mock/freshservice/alerts", async (c) => {
    const body = await json(c);
    const preset = typeof body?.preset === "number" ? presets[body.preset] : undefined;
    const input = (preset ?? body) as NewAlert | null;
    if (!input?.service || !input.metric || !input.label || !["critical", "warning"].includes(input.severity)) {
      return c.json({ error: "service, metric, label and severity (critical or warning) are required" }, 400);
    }
    return c.json(fireAlert(store, input), 201);
  });

  ui.post("/mock/freshservice/alerts/:id/resolve", (c) => {
    const alert = resolveAlert(store, Number(c.req.param("id")));
    return alert ? c.json(alert) : c.json({ error: "no such alert" }, 404);
  });

  ui.post("/mock/freshservice/tickets/:id/acknowledge", async (c) => {
    const body = (await json(c)) ?? {};
    const by = typeof body.by === "string" && body.by.trim() ? body.by.trim().slice(0, 60) : "On-call engineer";
    return (await acknowledge(store, Number(c.req.param("id")), by)) ? c.json({ ok: true }) : c.json({ error: "CrisisCrew didn't accept the acknowledgement; see the activity feed" }, 409);
  });

  ui.post("/mock/phone/autopilot", async (c) => {
    store.autopilot = (await json(c))?.on !== false;
    store.touch();
    return c.json({ autopilot: store.autopilot });
  });

  ui.post("/mock/phone/:uuid/:action", async (c) => {
    const uuid = c.req.param("uuid");
    const action = c.req.param("action");
    const body = (await json(c)) ?? {};
    const done =
      action === "answer" ? await phone.answer(uuid)
      : action === "press" ? await phone.press(uuid, String(body.digit ?? "1").slice(0, 1))
      : action === "miss" ? await phone.hangup(uuid, "no_answer")
      : action === "busy" ? await phone.hangup(uuid, "busy")
      : action === "hangup" ? await phone.hangup(uuid, "completed")
      : action === "takeover" ? phone.takeOver(uuid)
      : null;
    if (done === null) return c.json({ error: `unknown action "${action}"` }, 404);
    return done ? c.json({ ok: true }) : c.json({ error: "the call isn't in a state for that" }, 409);
  });

  // Clears the mock and starts CrisisCrew on a fresh live session, so a demo can be run again from the top.
  ui.post("/mock/reset", async (c) => {
    burst.timers.forEach(clearTimeout);
    burst = { running: false, filed: 0, total: 0, timers: [] };
    phone.stopAll();
    store.reset();
    let crisiscrew = "not reached";
    try {
      const res = await doFetch(`${options.crisiscrewUrl}/api/live`, {
        method: "POST",
        headers: options.crisiscrewAdminToken ? { authorization: `Bearer ${options.crisiscrewAdminToken}` } : {},
        signal: AbortSignal.timeout(4_000),
      });
      crisiscrew = res.ok ? "fresh live session" : `answered ${res.status}`;
    } catch {
      // CrisisCrew isn't running; the mock is still reset
    }
    store.record("mock", "out", `reset; CrisisCrew: ${crisiscrew}`, crisiscrew === "fresh live session");
    void crisis.poll();
    return c.json({ ok: true, crisiscrew });
  });

  return {
    store,
    phone,
    crisis,
    apps: { freshdesk, freshservice, vobiz },
    stop() {
      burst.timers.forEach(clearTimeout);
      phone.stopAll();
      crisis.stop();
    },
  };
}
