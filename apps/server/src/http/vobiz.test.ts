import { CachedEmbedder, vobizTelephony } from "@crisiscrew/adapters";
import type { CallView, CrisisState } from "@crisiscrew/contracts";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEFAULT_EMBEDDING_MODEL, loadConfig } from "../config";
import { EMBEDDING_CACHE_DIR } from "../paths";
import { Runtime } from "../runtime";
import { loadPolicy, loadScenarios } from "../scenarios";
import { createApp } from "./app";

const BASE = "https://crisis.example.com";
const TOKEN = "vobiz-auth-token";
const ENV = {
  SANDBOX_LATENCY_MS: "0",
  TELEPHONY: "vobiz",
  VOBIZ_AUTH_ID: "MA123",
  VOBIZ_AUTH_TOKEN: TOKEN,
  VOBIZ_FROM_NUMBER: "+918065551234",
  PUBLIC_BASE_URL: BASE,
  ADMIN_TOKEN: "admin",
};

async function setup(live = true) {
  const placed: unknown[] = [];
  const fetch = (async (_url: string | URL, init?: RequestInit) => {
    placed.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ request_uuid: "req-1", message: "Call fired" }), { status: 201 });
  }) as typeof globalThis.fetch;
  const config = loadConfig(live ? ENV : { SANDBOX_LATENCY_MS: "0" });
  const runtime = new Runtime({
    policy: loadPolicy(),
    scenarios: loadScenarios(),
    embedder: new CachedEmbedder({ modelId: DEFAULT_EMBEDDING_MODEL, dir: EMBEDDING_CACHE_DIR, inner: null }),
    latencyMs: 0,
    liveWorld: "checkout-v4.21.7",
    ...(live ? { live: { telephony: vobizTelephony({ authId: "MA123", authToken: TOKEN, from: "+918065551234", publicBaseUrl: BASE, fetch }) } } : {}),
  });
  await runtime.start();
  return { app: createApp({ runtime, config }), runtime, placed };
}

const admin = { authorization: "Bearer admin", "content-type": "application/json" };

/** A callback as Vobiz sends it: form-encoded, signed over the public URL. */
function callback(callId: string, kind: string, params: Record<string, string>, sign = true) {
  const url = `${BASE}/api/webhooks/vobiz/${callId}/${kind}`;
  const nonce = "12345678901234567890";
  const signature = createHmac("sha256", TOKEN).update(`${url}.${nonce}`).digest("base64");
  return {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(sign ? { "x-vobiz-signature-v3": signature, "x-vobiz-signature-v3-nonce": nonce } : {}),
    },
    body: new URLSearchParams(params).toString(),
  };
}

describe("Vobiz phone calls", () => {
  it("places an admin's test call, plays its script, and puts every state change into the session's state", async () => {
    const { app, placed } = await setup();
    expect((await app.request("/api/telephony/test-call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "+919876543210" }) })).status).toBe(401);

    const res = await app.request("/api/telephony/test-call", { method: "POST", headers: admin, body: JSON.stringify({ to: "+91 98765 43210" }) });
    expect(res.status).toBe(202);
    const { callId } = (await res.json()) as { callId: string };
    expect(placed).toEqual([expect.objectContaining({ to: "+919876543210", answer_url: `${BASE}/api/webhooks/vobiz/${callId}/answer` })]);

    expect((await app.request(`/api/webhooks/vobiz/${callId}/ring`, callback(callId, "ring", { RequestUUID: "req-1", CallUUID: "cu-1" }))).status).toBe(204);
    const answer = await app.request(`/api/webhooks/vobiz/${callId}/answer`, callback(callId, "answer", { RequestUUID: "req-1", CallUUID: "cu-1" }));
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("application/xml");
    expect(await answer.text()).toContain("<Speak>This is a test call from CrisisCrew.");
    await app.request(`/api/webhooks/vobiz/${callId}/digits`, callback(callId, "digits", { Digits: "1" }));
    await app.request(`/api/webhooks/vobiz/${callId}/hangup`, callback(callId, "hangup", { RequestUUID: "req-1", HangupCause: "NORMAL_CLEARING", Duration: "12" }));

    const call = (await (await app.request(`/api/calls/${callId}`)).json()) as CallView;
    expect(call).toMatchObject({ id: callId, state: "completed", digits: "1", durationSec: 12, to: "••••3210", adapter: "vobiz" });
    const state = (await (await app.request("/api/state")).json()) as CrisisState;
    expect(state.calls[callId]?.state).toBe("completed");
    expect(JSON.stringify(state)).not.toContain("9876543210");
  });

  it("refuses unsigned callbacks, unknown callback kinds and unknown calls", async () => {
    const { app } = await setup();
    const { callId } = (await (await app.request("/api/telephony/test-call", { method: "POST", headers: admin, body: JSON.stringify({ to: "+919876543210" }) })).json()) as { callId: string };
    expect((await app.request(`/api/webhooks/vobiz/${callId}/answer`, callback(callId, "answer", {}, false))).status).toBe(401);
    expect((await app.request(`/api/webhooks/vobiz/${callId}/transfer`, callback(callId, "transfer", {}))).status).toBe(404);
    expect((await app.request(`/api/webhooks/vobiz/CALL-nope/answer`, callback("CALL-nope", "answer", {}))).status).toBe(404);
    expect((await app.request("/api/telephony/test-call", { method: "POST", headers: admin, body: JSON.stringify({ to: "not a number" }) })).status).toBe(400);
  });

  it("keeps the Vobiz callbacks off when calls are simulated, and simulates the test call", async () => {
    const { app, runtime } = await setup(false);
    expect((await app.request("/api/webhooks/vobiz/CALL-001/answer", callback("CALL-001", "answer", {}))).status).toBe(404);
    const res = await app.request("/api/telephony/test-call", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ to: "+919876543210" }) });
    expect(res.status).toBe(202);
    const { callId } = (await res.json()) as { callId: string };
    // The live session runs on the wall clock, so the simulated call is only queued this soon; the sandbox tests follow it to the end.
    expect(runtime.state().calls[callId]).toMatchObject({ state: "queued", adapter: "sandbox", to: "••••3210" });
  });
});
