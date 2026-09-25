import type { CallState } from "@crisiscrew/contracts";
import type { CallRequest, TelephonyPort } from "@crisiscrew/core";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { CallBook, e164, isFinal } from "./calls";

export type VobizOptions = {
  authId: string;
  authToken: string;
  /** The caller id: a number on the Vobiz account, in E.164 format. */
  from: string;
  /** The public HTTPS origin Vobiz calls back, e.g. https://crisiscrew.example.com */
  publicBaseUrl: string;
  /** Hang up if nobody answers within this many seconds of ringing. */
  ringTimeoutSec?: number;
  /** Hang up an answered call after this many seconds. */
  timeLimitSec?: number;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  apiBase?: string;
};

/** The callbacks Vobiz makes for each call, one route each: /api/webhooks/vobiz/:callId/:kind */
export const VOBIZ_CALLBACKS = ["answer", "ring", "hangup", "digits"] as const;
export type VobizCallback = (typeof VOBIZ_CALLBACKS)[number];

/** What the server needs, beyond the port, to answer Vobiz's callbacks. */
export type VobizTelephony = TelephonyPort & {
  /** Applies one callback and returns the XML to answer it with (answer and digits), or null. Unknown calls return null. */
  handleCallback(callId: string, kind: VobizCallback, params: Record<string, string>): string | null;
  /** Checks X-Vobiz-Signature-V3 (or -V2) against the public URL the callback was sent to. */
  verifySignature(url: string, header: (name: string) => string | undefined): boolean;
  /** The public URL of one callback, as Vobiz is told to call it and as it signs it. */
  callbackUrl(callId: string, kind: VobizCallback): string;
};

export class VobizError extends Error {
  override name = "VobizError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Placed = { script: string; gather?: CallRequest["gather"]; requestUuid?: string; callUuid?: string };

type CallRecord = {
  call_uuid?: string;
  answer_time?: string | null;
  end_time?: string | null;
  call_duration?: number | string | null;
  hangup_cause_name?: string | null;
};

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
const xml = (text: string) => text.replace(/[&<>"']/g, (ch) => XML_ESCAPES[ch]!);

/**
 * How a finished call ended, from the hangup callback or the call record.
 * Vobiz reports the cause by name ("NORMAL_CLEARING", "USER_BUSY",
 * "NO_ANSWER", …); a call that was answered counts as completed whatever
 * ended it.
 */
export function endState(input: { answered: boolean; cause?: string; status?: string }): CallState {
  const text = `${input.status ?? ""} ${input.cause ?? ""}`.toLowerCase();
  if (input.answered) return "completed";
  if (/busy/.test(text)) return "busy";
  if (/no.?answer|not.?answered|timeout|cancel|originator/.test(text)) return "no_answer";
  return "failed";
}

function seconds(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Answer XML: speak the script, optionally ask for a key press, then hang up. */
export function answerXml(script: string, gather: CallRequest["gather"] | undefined, digitsUrl: string): string {
  const ask = gather
    ? `<Gather action="${xml(digitsUrl)}" method="POST" inputType="dtmf" numDigits="${gather.numDigits ?? 1}" executionTimeout="10"><Speak>${xml(gather.prompt)}</Speak></Gather>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>${xml(script)}</Speak>${ask}<Hangup/></Response>`;
}

/**
 * Outbound calls through Vobiz (api.vobiz.ai, v1). A call is placed with
 * answer, ring and hangup URLs on this server; Vobiz fetches the answer URL
 * for the XML to play and reports progress to the others. Callbacks are
 * signed with the auth token, and each carries our call id in its path.
 */
export function vobizTelephony(options: VobizOptions): VobizTelephony {
  const now = options.now ?? Date.now;
  const book = new CallBook("vobiz", now);
  const placed = new Map<string, Placed>();
  const base = options.publicBaseUrl.replace(/\/+$/, "");
  const api = `${(options.apiBase ?? "https://api.vobiz.ai").replace(/\/+$/, "")}/api/v1/Account/${encodeURIComponent(options.authId)}`;
  const from = e164(options.from);

  async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const doFetch = options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(`${api}${path}`, {
        method,
        headers: {
          "x-auth-id": options.authId,
          "x-auth-token": options.authToken,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 4_000),
      });
    } catch (error) {
      throw new VobizError(0, `Vobiz ${method} ${path} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const json = JSON.parse(text) as { error?: string; message?: string };
        detail = json.error ?? json.message ?? detail;
      } catch {
        // not JSON: keep the text
      }
      throw new VobizError(res.status, `Vobiz ${method} ${path} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const callbackUrl = (callId: string, kind: VobizCallback) => `${base}/api/webhooks/vobiz/${encodeURIComponent(callId)}/${kind}`;

  function sign(key: string, message: string): Buffer {
    return createHmac("sha256", key).update(message).digest();
  }

  return {
    mode: "live",
    adapter: "vobiz",
    callbackUrl,

    async call({ to, script, purpose, gather, metadata }) {
      const number = e164(to);
      const callId = `CALL-${randomUUID()}`;
      placed.set(callId, { script, ...(gather ? { gather } : {}) });
      book.open(callId, number, purpose, metadata);
      try {
        const created = await request<{ request_uuid?: string; message?: string }>("POST", "/Call/", {
          from: from.slice(1),
          to: number,
          answer_url: callbackUrl(callId, "answer"),
          answer_method: "POST",
          ring_url: callbackUrl(callId, "ring"),
          ring_method: "POST",
          hangup_url: callbackUrl(callId, "hangup"),
          hangup_method: "POST",
          hangup_on_ring: options.ringTimeoutSec ?? 30,
          time_limit: options.timeLimitSec ?? 300,
        });
        if (created?.request_uuid) placed.get(callId)!.requestUuid = created.request_uuid;
      } catch (error) {
        book.update(callId, { state: "failed", reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
      return { callId };
    },

    async status(callId) {
      const call = book.get(callId);
      const uuid = placed.get(callId)?.callUuid;
      if (!call || isFinal(call.state) || !uuid) return call;
      // A missed hangup callback: the call record says how it ended.
      try {
        const record = await request<CallRecord>("GET", `/Call/${encodeURIComponent(uuid)}/`);
        if (!record?.end_time) return call;
        const answered = Boolean(record.answer_time) || call.state === "answered";
        const duration = seconds(record.call_duration);
        return book.update(callId, {
          state: endState({ answered, cause: record.hangup_cause_name ?? undefined }),
          ...(answered && duration !== undefined ? { durationSec: duration } : {}),
          ...(!answered && record.hangup_cause_name ? { reason: record.hangup_cause_name } : {}),
        });
      } catch {
        return call;
      }
    },

    onUpdate(listener) {
      return book.subscribe(listener);
    },

    handleCallback(callId, kind, params) {
      const call = book.get(callId);
      const info = placed.get(callId);
      if (!call || !info) return null;
      // A callback for someone else's call can't move this one.
      if (info.requestUuid && params.RequestUUID && params.RequestUUID !== info.requestUuid) return null;
      if (params.CallUUID) info.callUuid = params.CallUUID;

      switch (kind) {
        case "ring":
          if (call.state === "queued") book.update(callId, { state: "ringing" });
          return null;
        case "answer":
          book.update(callId, { state: "answered" });
          return answerXml(info.script, info.gather, callbackUrl(callId, "digits"));
        case "digits":
          if (params.Digits) book.update(callId, { digits: params.Digits.slice(0, 32) });
          return `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>Thank you. Goodbye.</Speak><Hangup/></Response>`;
        case "hangup": {
          const answered = call.state === "answered" || Boolean(params.AnswerTime);
          const cause = params.HangupCauseName ?? params.HangupCause;
          const duration = seconds(params.BillDuration ?? params.Duration);
          book.update(callId, {
            state: endState({ answered, cause, status: params.CallStatus }),
            ...(answered && duration !== undefined ? { durationSec: duration } : {}),
            ...(!answered && cause ? { reason: cause } : {}),
          });
          return null;
        }
      }
    },

    verifySignature(url, header) {
      const baseUrl = url.replace(/[?#].*$/, "");
      const check = (signature: string | undefined, message: string | null) => {
        if (!signature || message === null) return false;
        const expected = sign(options.authToken, message);
        const given = Buffer.from(signature, "base64");
        return given.length === expected.length && timingSafeEqual(given, expected);
      };
      const v3Nonce = header("x-vobiz-signature-v3-nonce");
      const v2Nonce = header("x-vobiz-signature-v2-nonce");
      return (
        check(header("x-vobiz-signature-v3"), v3Nonce ? `${baseUrl}.${v3Nonce}` : null) ||
        check(header("x-vobiz-signature-v2"), v2Nonce ? `${baseUrl}${v2Nonce}` : null)
      );
    },
  };
}
