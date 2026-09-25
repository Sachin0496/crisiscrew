import { MOCK } from "@crisiscrew/contracts";
import { Hono } from "hono";
import { createHmac, randomUUID } from "node:crypto";
import { json, logCalls } from "./freshworks";
import { iso, type Call, type Store } from "./store";
import type { World } from "./world";

const XML_UNESCAPES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
const unxml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => XML_UNESCAPES[m]!);

/** The parts of Vobiz answer XML the mock plays: what's spoken, and a key-press prompt with where to send the key. */
export function parseAnswerXml(xml: string): { said: string[]; gather: { action: string; prompt: string } | null } {
  const gatherMatch = /<Gather\b([^>]*)>([\s\S]*?)<\/Gather>/i.exec(xml);
  const outside = gatherMatch ? xml.replace(gatherMatch[0], "") : xml;
  const said = [...outside.matchAll(/<Speak[^>]*>([\s\S]*?)<\/Speak>/gi)].map((m) => unxml(m[1]!.trim()));
  if (!gatherMatch) return { said, gather: null };
  const action = /action="([^"]*)"/i.exec(gatherMatch[1]!)?.[1];
  const prompt = /<Speak[^>]*>([\s\S]*?)<\/Speak>/i.exec(gatherMatch[2]!)?.[1];
  return { said, gather: action ? { action: unxml(action), prompt: unxml(prompt?.trim() ?? "") } : null };
}

export type PhoneOptions = {
  /** Multiplies every delay: 1 in the demo, near 0 in tests. */
  pace?: number;
  /** Where callbacks go; the global fetch otherwise. */
  fetch?: typeof fetch;
};

/**
 * The phone network behind the mock Vobiz API. A placed call rings, then is
 * answered, missed or busy, either on autopilot (the scenario's behaviour
 * for that number) or by someone clicking in the UI. Every step is reported
 * to the call's callback URLs, signed the way Vobiz signs them (V3).
 */
export class Phone {
  private readonly pace: number;
  private readonly doFetch: typeof fetch;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>[]>();

  constructor(
    private readonly store: Store,
    private readonly world: World,
    options: PhoneOptions = {},
  ) {
    this.pace = options.pace ?? 1;
    this.doFetch = options.fetch ?? fetch;
  }

  place(input: { from: string; to: string; answerUrl: string; ringUrl: string | null; hangupUrl: string | null; ringTimeoutSec: number }): Call {
    const call: Call = {
      uuid: randomUUID(),
      requestUuid: randomUUID(),
      ...input,
      state: "queued",
      said: [],
      gather: null,
      digits: null,
      cause: null,
      created_at: iso(),
      answer_time: null,
      end_time: null,
      driver: this.store.autopilot ? "autopilot" : "manual",
    };
    this.store.calls.push(call);
    this.store.touch();
    this.later(call, 800, () => this.ring(call));
    return call;
  }

  get(uuid: string): Call | undefined {
    return this.store.calls.find((c) => c.uuid === uuid);
  }

  private async ring(call: Call): Promise<void> {
    if (call.state !== "queued") return;
    call.state = "ringing";
    this.store.touch();
    await this.callback(call, call.ringUrl, { CallStatus: "ringing" });
    // Nobody picks up before the ring timeout: the call ends unanswered.
    this.later(call, call.ringTimeoutSec * 1000, () => this.miss(call, "no_answer"));
    if (call.driver === "autopilot") {
      const behaviour = this.world.behaviour(call.to);
      this.later(call, 2_500, () => (behaviour.answers === "answers" ? this.answer(call.uuid) : this.miss(call, behaviour.answers)));
    }
  }

  /** Picks up: fetches what to say from the answer URL and plays it. */
  async answer(uuid: string): Promise<boolean> {
    const call = this.get(uuid);
    if (!call || call.state !== "ringing") return false;
    this.clear(call);
    call.state = "answered";
    call.answer_time = iso();
    this.store.touch();
    const xml = await this.callback(call, call.answerUrl, { CallStatus: "in-progress" });
    if (xml === null) return this.end(call, "completed", "NORMAL_CLEARING"), true;
    const { said, gather } = parseAnswerXml(xml);
    call.said.push(...said);
    if (gather) {
      call.gather = gather;
      if (gather.prompt) call.said.push(gather.prompt);
    }
    this.store.touch();
    // About two and a half words a second, as a voice reads it.
    const speaking = Math.max(2_000, (said.join(" ").split(/\s+/).length / 2.5) * 1000);
    if (!gather) {
      this.later(call, speaking, () => this.end(call, "completed", "NORMAL_CLEARING"));
    } else if (call.driver === "autopilot") {
      const press = this.world.behaviour(call.to).press;
      this.later(call, Math.min(speaking, 4_000), () => (press ? this.press(uuid, press) : this.end(call, "completed", "NORMAL_CLEARING")));
    } else {
      // A person who never presses a key: the gather times out and the call ends.
      this.later(call, 30_000, () => this.end(call, "completed", "NORMAL_CLEARING"));
    }
    return true;
  }

  async press(uuid: string, digit: string): Promise<boolean> {
    const call = this.get(uuid);
    if (!call || call.state !== "answered" || !call.gather || call.digits !== null) return false;
    this.clear(call);
    call.digits = digit;
    this.store.touch();
    const xml = await this.callback(call, call.gather.action, { Digits: digit, CallStatus: "in-progress" });
    if (xml) call.said.push(...parseAnswerXml(xml).said);
    this.store.touch();
    this.later(call, 2_500, () => this.end(call, "completed", "NORMAL_CLEARING"));
    return true;
  }

  /** Ends the call from the UI: hangs up an answered call, or lets a ringing one go unanswered or busy. */
  async hangup(uuid: string, as: "no_answer" | "busy" | "completed"): Promise<boolean> {
    const call = this.get(uuid);
    if (!call) return false;
    if (as === "completed" && call.state === "answered") return this.end(call, "completed", "NORMAL_CLEARING"), true;
    if (call.state !== "ringing" && call.state !== "queued") return false;
    await this.miss(call, as === "completed" ? "no_answer" : as);
    return true;
  }

  /** Switches one call between autopilot and someone clicking. */
  takeOver(uuid: string): boolean {
    const call = this.get(uuid);
    if (!call || ["completed", "no_answer", "busy", "failed"].includes(call.state)) return false;
    call.driver = "manual";
    this.clear(call);
    if (call.state === "ringing") this.later(call, call.ringTimeoutSec * 1000, () => this.miss(call, "no_answer"));
    this.store.touch();
    return true;
  }

  stopAll(): void {
    for (const list of this.timers.values()) list.forEach(clearTimeout);
    this.timers.clear();
  }

  private async miss(call: Call, how: "no_answer" | "busy"): Promise<void> {
    if (call.state !== "ringing" && call.state !== "queued") return;
    await this.end(call, how, how === "busy" ? "USER_BUSY" : "NO_ANSWER");
  }

  private async end(call: Call, state: Call["state"], cause: string): Promise<void> {
    if (["completed", "no_answer", "busy", "failed"].includes(call.state)) return;
    this.clear(call);
    const answered = call.answer_time !== null;
    call.state = state;
    call.cause = cause;
    call.end_time = iso();
    this.store.touch();
    const duration = answered ? Math.max(1, Math.round((Date.parse(call.end_time) - Date.parse(call.answer_time!)) / 1000)) : 0;
    await this.callback(call, call.hangupUrl, {
      CallStatus: state === "completed" ? "completed" : state === "busy" ? "busy" : "no-answer",
      HangupCauseName: cause,
      ...(answered ? { AnswerTime: call.answer_time!, BillDuration: String(duration), Duration: String(duration) } : {}),
      EndTime: call.end_time,
    });
  }

  /** Posts a form callback, signed with the auth token (X-Vobiz-Signature-V3). Returns the reply body, or null. */
  private async callback(call: Call, url: string | null, params: Record<string, string>): Promise<string | null> {
    if (!url) return null;
    const nonce = randomUUID().replace(/-/g, "");
    const base = url.replace(/[?#].*$/, "");
    const signature = createHmac("sha256", MOCK.vobizAuthToken).update(`${base}.${nonce}`).digest("base64");
    const kind = url.split("/").pop();
    try {
      const res = await this.doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "x-vobiz-signature-v3": signature, "x-vobiz-signature-v3-nonce": nonce },
        body: new URLSearchParams({ CallUUID: call.uuid, RequestUUID: call.requestUuid, From: call.from, To: call.to, Direction: "outbound", ...params }).toString(),
        signal: AbortSignal.timeout(4_000),
      });
      const text = await res.text();
      this.store.record("vobiz", "out", `callback ${kind} for ${call.to} → ${res.status}`, res.ok);
      return res.ok && text ? text : null;
    } catch (error) {
      this.store.record("vobiz", "out", `callback ${kind} failed: ${error instanceof Error ? error.message : String(error)}`, false);
      return null;
    }
  }

  private later(call: Call, ms: number, fn: () => unknown): void {
    const timer = setTimeout(() => void fn(), ms * this.pace);
    const list = this.timers.get(call.uuid) ?? [];
    list.push(timer);
    this.timers.set(call.uuid, list);
  }

  private clear(call: Call): void {
    this.timers.get(call.uuid)?.forEach(clearTimeout);
    this.timers.delete(call.uuid);
  }
}

/** The Vobiz REST API (v1) that CrisisCrew uses: place a call, and read a call record. */
export function vobizApi(store: Store, phone: Phone): Hono {
  const app = new Hono();
  app.use("/api/*", logCalls(store, "vobiz"));
  app.use("/api/v1/Account/:authId/*", async (c, next) => {
    if (c.req.param("authId") !== MOCK.vobizAuthId || c.req.header("x-auth-id") !== MOCK.vobizAuthId || c.req.header("x-auth-token") !== MOCK.vobizAuthToken) {
      return c.json({ error: "authentication failed" }, 401);
    }
    await next();
  });

  app.post("/api/v1/Account/:authId/Call/", async (c) => {
    const body = await json(c);
    if (!body || typeof body.to !== "string" || typeof body.answer_url !== "string") return c.json({ error: "to and answer_url are required" }, 400);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const call = phone.place({
      from: str(body.from) ?? MOCK.vobizFrom,
      to: body.to,
      answerUrl: body.answer_url,
      ringUrl: str(body.ring_url),
      hangupUrl: str(body.hangup_url),
      ringTimeoutSec: typeof body.hangup_on_ring === "number" ? body.hangup_on_ring : 30,
    });
    return c.json({ api_id: randomUUID(), message: "call fired", request_uuid: call.requestUuid }, 201);
  });

  app.get("/api/v1/Account/:authId/Call/:uuid/", (c) => {
    const call = phone.get(c.req.param("uuid"));
    if (!call) return c.json({ error: "call not found" }, 404);
    const duration = call.answer_time && call.end_time ? Math.round((Date.parse(call.end_time) - Date.parse(call.answer_time)) / 1000) : 0;
    return c.json({ call_uuid: call.uuid, answer_time: call.answer_time, end_time: call.end_time, call_duration: duration, hangup_cause_name: call.cause });
  });

  return app;
}
