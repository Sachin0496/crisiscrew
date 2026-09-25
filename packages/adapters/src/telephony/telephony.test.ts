import type { CallView } from "@crisiscrew/contracts";
import { ManualClock } from "@crisiscrew/core";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { e164, maskNumber } from "./calls";
import { sandboxTelephony, type SandboxCall } from "./sandbox";
import { answerXml, endState, vobizTelephony } from "./vobiz";

const BASE = "https://crisis.example.com";
const TOKEN = "vobiz-auth-token";

type Sent = { url: string; method: string; headers: Record<string, string>; body: unknown };

function fakeVobiz(respond: (req: Sent) => { status: number; body: unknown } = () => ({ status: 201, body: { request_uuid: "req-1", message: "Call fired" } })) {
  const sent: Sent[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const req: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(req);
    const { status, body } = respond(req);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

function adapter(fake = fakeVobiz()) {
  let now = 1_000;
  const vobiz = vobizTelephony({ authId: "MA123", authToken: TOKEN, from: "+918065551234", publicBaseUrl: `${BASE}/`, fetch: fake.fetch, now: () => now++ });
  const updates: CallView[] = [];
  vobiz.onUpdate((call) => updates.push(call));
  return { vobiz, updates, sent: fake.sent };
}

const signed = (url: string, nonce: string, version: "v2" | "v3") =>
  createHmac("sha256", TOKEN)
    .update(version === "v3" ? `${url}.${nonce}` : `${url}${nonce}`)
    .digest("base64");

describe("phone numbers", () => {
  it("normalises to E.164 and masks all but the last four digits", () => {
    expect(e164("+91 98765 43210")).toBe("+919876543210");
    expect(e164("0091-98765-43210")).toBe("+919876543210");
    expect(e164("919876543210")).toBe("+919876543210");
    expect(maskNumber("+919876543210")).toBe("••••3210");
    expect(() => e164("call me maybe")).toThrow(/E\.164/);
    expect(() => e164("+0123")).toThrow(/E\.164/);
  });
});

describe("Vobiz calls", () => {
  it("places a call with its own answer, ring and hangup URLs and the account's auth headers", async () => {
    const { vobiz, updates, sent } = adapter();
    const { callId } = await vobiz.call({ to: "+91 98765 43210", script: "Hello", purpose: "oncall", metadata: { incidentId: "INC-2026-001" } });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://api.vobiz.ai/api/v1/Account/MA123/Call/",
      method: "POST",
      headers: { "x-auth-id": "MA123", "x-auth-token": TOKEN, "content-type": "application/json" },
      body: {
        from: "918065551234",
        to: "+919876543210",
        answer_url: `${BASE}/api/webhooks/vobiz/${callId}/answer`,
        ring_url: `${BASE}/api/webhooks/vobiz/${callId}/ring`,
        hangup_url: `${BASE}/api/webhooks/vobiz/${callId}/hangup`,
        hangup_on_ring: 30,
        time_limit: 300,
      },
    });
    expect(updates).toEqual([
      expect.objectContaining({ id: callId, state: "queued", purpose: "oncall", to: "••••3210", adapter: "vobiz", metadata: { incidentId: "INC-2026-001" } }),
    ]);
  });

  it("follows a call through ring, answer, a key press and hangup, and answers with the script as XML", async () => {
    const { vobiz, updates } = adapter();
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Checkout is failing <now> & rising", purpose: "oncall", gather: { prompt: "Press 1 to acknowledge." } });

    expect(vobiz.handleCallback(callId, "ring", { RequestUUID: "req-1", CallUUID: "call-uuid-1", CallStatus: "ringing" })).toBeNull();
    const xml = vobiz.handleCallback(callId, "answer", { RequestUUID: "req-1", CallUUID: "call-uuid-1", CallStatus: "in-progress" });
    expect(xml).toContain("<Speak>Checkout is failing &lt;now&gt; &amp; rising</Speak>");
    expect(xml).toContain(`<Gather action="${BASE}/api/webhooks/vobiz/${callId}/digits" method="POST" inputType="dtmf" numDigits="1"`);
    expect(vobiz.handleCallback(callId, "digits", { Digits: "1" })).toContain("<Hangup/>");
    vobiz.handleCallback(callId, "hangup", { RequestUUID: "req-1", CallStatus: "completed", HangupCause: "NORMAL_CLEARING", Duration: "23", BillDuration: "24" });

    expect(updates.map((u) => u.state)).toEqual(["queued", "ringing", "answered", "answered", "completed"]);
    expect(await vobiz.status(callId)).toMatchObject({ state: "completed", digits: "1", durationSec: 24 });
  });

  it("answers each key with the call's own reply", async () => {
    const { vobiz } = adapter();
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "customer", gather: { prompt: "Press 1 or 2", replies: { "1": "Your refund is on its way & safe." } } });
    vobiz.handleCallback(callId, "answer", {});
    expect(vobiz.handleCallback(callId, "digits", { Digits: "1" })).toContain("<Speak>Your refund is on its way &amp; safe.</Speak><Hangup/>");
    expect(vobiz.handleCallback(callId, "digits", { Digits: "9" })).toContain("<Speak>Thank you. Goodbye.</Speak>");
  });

  it("reports calls nobody answered, busy lines and failures with the provider's reason", async () => {
    const { vobiz } = adapter();
    const end = async (params: Record<string, string>) => {
      const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "customer" });
      vobiz.handleCallback(callId, "hangup", params);
      return vobiz.status(callId);
    };
    expect(await end({ HangupCause: "NO_ANSWER", Duration: "0" })).toMatchObject({ state: "no_answer", reason: "NO_ANSWER" });
    expect(await end({ HangupCauseName: "USER_BUSY" })).toMatchObject({ state: "busy", reason: "USER_BUSY" });
    expect(await end({ HangupCause: "UNALLOCATED_NUMBER" })).toMatchObject({ state: "failed", reason: "UNALLOCATED_NUMBER" });
  });

  it("never reopens a finished call, and ignores callbacks for another request or an unknown call", async () => {
    const { vobiz } = adapter();
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "customer" });
    expect(vobiz.handleCallback(callId, "answer", { RequestUUID: "someone-else" })).toBeNull();
    vobiz.handleCallback(callId, "hangup", { HangupCause: "NO_ANSWER" });
    vobiz.handleCallback(callId, "answer", {});
    vobiz.handleCallback(callId, "hangup", { AnswerTime: "2026-09-25 10:00:00", Duration: "40" });
    expect(await vobiz.status(callId)).toMatchObject({ state: "no_answer" });
    expect(vobiz.handleCallback("CALL-unknown", "answer", {})).toBeNull();
  });

  it("marks a call failed and says why when Vobiz refuses it, without leaking the token", async () => {
    const { vobiz, updates } = adapter(fakeVobiz(() => ({ status: 401, body: { error: "authentication failed" } })));
    await expect(vobiz.call({ to: "+919876543210", script: "Hi", purpose: "oncall" })).rejects.toThrow("Vobiz POST /Call/ failed with 401: authentication failed");
    expect(updates.at(-1)).toMatchObject({ state: "failed" });
    expect(JSON.stringify(updates)).not.toContain(TOKEN);
  });

  it("refuses a number that isn't E.164 before calling Vobiz", async () => {
    const { vobiz, sent } = adapter();
    await expect(vobiz.call({ to: "12", script: "Hi", purpose: "oncall" })).rejects.toThrow(/E\.164/);
    expect(sent).toHaveLength(0);
  });

  it("reads the call record when the hangup callback never came", async () => {
    const fake = fakeVobiz((req) =>
      req.method === "POST"
        ? { status: 201, body: { request_uuid: "req-1" } }
        : { status: 200, body: { call_uuid: "call-uuid-1", answer_time: "2026-09-25 10:00:00", end_time: "2026-09-25 10:00:31", call_duration: 31, hangup_cause_name: "NORMAL_CLEARING" } },
    );
    const { vobiz, sent } = adapter(fake);
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "oncall" });
    vobiz.handleCallback(callId, "answer", { CallUUID: "call-uuid-1" });
    expect(await vobiz.status(callId)).toMatchObject({ state: "completed", durationSec: 31 });
    expect(sent[1]).toMatchObject({ method: "GET", url: "https://api.vobiz.ai/api/v1/Account/MA123/Call/call-uuid-1/" });
  });

  it("accepts only callbacks signed with the auth token (V3, or V2), over the URL without its query", () => {
    const { vobiz } = adapter();
    const url = `${BASE}/api/webhooks/vobiz/CALL-1/hangup`;
    const headers = (h: Record<string, string>) => (name: string) => h[name];
    expect(vobiz.verifySignature(`${url}?x=1`, headers({ "x-vobiz-signature-v3": signed(url, "n1", "v3"), "x-vobiz-signature-v3-nonce": "n1" }))).toBe(true);
    expect(vobiz.verifySignature(url, headers({ "x-vobiz-signature-v2": signed(url, "n2", "v2"), "x-vobiz-signature-v2-nonce": "n2" }))).toBe(true);
    expect(vobiz.verifySignature(url, headers({ "x-vobiz-signature-v3": signed(url, "n1", "v3"), "x-vobiz-signature-v3-nonce": "n2" }))).toBe(false);
    expect(vobiz.verifySignature(`${BASE}/api/webhooks/vobiz/CALL-2/hangup`, headers({ "x-vobiz-signature-v3": signed(url, "n1", "v3"), "x-vobiz-signature-v3-nonce": "n1" }))).toBe(false);
    expect(vobiz.verifySignature(url, headers({}))).toBe(false);
  });
});

describe("call outcomes", () => {
  it("counts any answered call as completed, and reads the rest from the cause", () => {
    expect(endState({ answered: true, cause: "USER_BUSY" })).toBe("completed");
    expect(endState({ answered: false, status: "busy" })).toBe("busy");
    expect(endState({ answered: false, status: "no-answer" })).toBe("no_answer");
    expect(endState({ answered: false, cause: "ORIGINATOR_CANCEL" })).toBe("no_answer");
    expect(endState({ answered: false, cause: "CALL_REJECTED" })).toBe("failed");
  });

  it("leaves out the Gather when the call asks for nothing", () => {
    expect(answerXml("Hello", undefined, "https://x/digits")).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Hello</Speak><Hangup/></Response>');
  });
});

describe("sandbox calls", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  async function run(seed: string) {
    const record: SandboxCall[] = [];
    const telephony = sandboxTelephony({ seed, clock: new ManualClock(0), record });
    const updates: CallView[] = [];
    telephony.onUpdate((call) => updates.push(call));
    const ids: string[] = [];
    for (let i = 0; i < 12; i += 1) ids.push((await telephony.call({ to: `+9198765432${String(i).padStart(2, "0")}`, script: "Your payment failed", purpose: "customer", gather: { prompt: "Press 1" } })).callId);
    await settle();
    return { telephony, record, updates, ids };
  }

  it("rings every call, then ends it answered, unanswered or busy, the same way on every replay", async () => {
    const a = await run("checkout-v4.21.7");
    const b = await run("checkout-v4.21.7");
    expect(a.record.map((c) => c.outcome)).toEqual(b.record.map((c) => c.outcome));
    expect(new Set(a.record.map((c) => c.outcome)).size).toBeGreaterThan(1);
    for (const id of a.ids) {
      const states = a.updates.filter((u) => u.id === id).map((u) => u.state);
      expect(states.slice(0, 2)).toEqual(["queued", "ringing"]);
      expect(["completed", "no_answer", "busy"]).toContain(states.at(-1));
    }
  });

  it("presses 1 on answered calls that ask for a key, and records the call", async () => {
    const { telephony, record, ids } = await run("checkout-v4.21.7");
    const answered = record.findIndex((c) => c.outcome === "completed");
    expect(await telephony.status(ids[answered]!)).toMatchObject({ state: "completed", digits: "1", adapter: "sandbox" });
    expect(record[answered]).toMatchObject({ to: expect.stringMatching(/^\+91/), purpose: "customer", script: "Your payment failed" });
  });
});
