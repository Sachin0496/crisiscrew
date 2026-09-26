import type { CallState } from "@crisiscrew/contracts";
import type { CallRequest, TelephonyPort } from "@crisiscrew/core";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { CallBook, e164, isFinal, maskNumber } from "./calls";
import { wavOf, type CallAnswerer, type CallSpeech } from "./sarvam";
import { streamConversation, type StreamSocket } from "./stream";

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
  /**
   * The voice of conversational calls (the on-call page). When set, such a
   * call streams its audio both ways over a WebSocket and this port hears and
   * speaks each turn; otherwise Vobiz's own Speak and speech Gather do.
   */
  speech?: CallSpeech;
  /** Streamed calls only: answers the callee's open questions from the dialog's facts (Sarvam's chat model). */
  answer?: CallAnswerer;
  /** Streamed calls only: the whole call, both sides mixed, as a WAV file once it ends. */
  onRecording?: (callId: string, wav: Buffer) => void;
  /** When non-empty, the only numbers a call may go to; any other is refused before dialling. */
  allowedNumbers?: readonly string[];
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
  /**
   * Opens the audio stream of a streamed call, once, for the socket Vobiz
   * connected with the call's own token. Returns what to do with each
   * message and with the close, or null for an unknown call or a wrong token.
   */
  openStream(callId: string, token: string, socket: StreamSocket): { receive(data: string): void; close(): void } | null;
};

/** The path Vobiz opens a streamed call's WebSocket on: /api/webhooks/vobiz/:callId/stream?token=… */
export const VOBIZ_STREAM_PATH = /^\/api\/webhooks\/vobiz\/([^/]+)\/stream$/;

export class VobizError extends Error {
  override name = "VobizError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Placed = {
  script: string;
  gather?: CallRequest["gather"];
  dialog?: CallRequest["dialog"];
  requestUuid?: string;
  callUuid?: string;
  /** A streamed call's secret: the WebSocket must present it. */
  streamToken?: string;
  streamOpened?: boolean;
  /** The opening, synthesized while the phone rings. */
  openingAudio?: Promise<Buffer>;
};

const xmlReply = (text: string) => `<?xml version="1.0" encoding="UTF-8"?><Response><Speak>${xml(text)}</Speak><Hangup/></Response>`;

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

/** Speaks, then listens for speech (as text) or a key press, posted to the digits URL. */
function listen(say: string, digitsUrl: string): string {
  return `<Gather action="${xml(digitsUrl)}" method="POST" inputType="dtmf speech" numDigits="1" executionTimeout="15" speechEndTimeout="auto" language="en-IN"><Speak>${xml(say)}</Speak></Gather><Speak>I'll leave it there. Goodbye.</Speak><Hangup/>`;
}

/** What a streamed call says first: the script, then the question. */
const openingOf = (script: string, gather: CallRequest["gather"] | undefined) => `${script} ${gather?.prompt ?? ""}`.trim();

/** A streamed call's XML: the audio goes both ways over the WebSocket until the call ends. */
export function streamXml(wsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-l16;rate=16000">${xml(wsUrl)}</Stream></Response>`;
}

/** A conversational call's XML: the opening script then the first question, or one reply; the last reply hangs up. */
export function conversationXml(parts: { script?: string; say: string; end?: boolean }, digitsUrl: string): string {
  const open = parts.script ? `<Speak>${xml(parts.script)}</Speak>` : "";
  const body = parts.end ? `<Speak>${xml(parts.say)}</Speak><Hangup/>` : listen(parts.say, digitsUrl);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${open}${body}</Response>`;
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
  const allowed = new Set((options.allowedNumbers ?? []).map(e164));

  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown): Promise<T> {
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
  const streamUrl = (callId: string, token: string) => `${base.replace(/^http/, "ws")}/api/webhooks/vobiz/${encodeURIComponent(callId)}/stream?token=${token}`;

  function sign(key: string, message: string): Buffer {
    return createHmac("sha256", key).update(message).digest();
  }

  return {
    mode: "live",
    adapter: "vobiz",
    callbackUrl,

    async call({ to, script, purpose, gather, metadata, dialog }) {
      const number = e164(to);
      if (allowed.size > 0 && !allowed.has(number)) throw new VobizError(0, `${maskNumber(number)} is not on VOBIZ_ALLOWED_NUMBERS, so it was not called`);
      const callId = `CALL-${randomUUID()}`;
      const streamed = Boolean(dialog && options.speech);
      placed.set(callId, { script, ...(gather ? { gather } : {}), ...(dialog ? { dialog } : {}), ...(streamed ? { streamToken: randomBytes(24).toString("base64url") } : {}) });
      if (streamed) {
        // Synthesize the opening while the phone rings, so it plays the moment the call is answered.
        const audio = options.speech!.say(openingOf(script, gather));
        audio.catch(() => {}); // a failure here is retried when the stream opens
        placed.get(callId)!.openingAudio = audio;
      }
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
          if (info.streamToken) return streamXml(streamUrl(callId, info.streamToken));
          if (info.dialog) {
            book.line(callId, "agent", `${info.script} ${info.gather?.prompt ?? ""}`);
            return conversationXml({ script: info.script, say: info.gather?.prompt ?? "Are you there?" }, callbackUrl(callId, "digits"));
          }
          return answerXml(info.script, info.gather, callbackUrl(callId, "digits"));
        case "digits":
          if (info.dialog) {
            // A conversational turn: speech (as text) or a key. Pressing 1 is the same as saying "acknowledge".
            const speech = params.Speech?.trim();
            const utterance = speech || (params.Digits === "1" ? "acknowledge" : params.Digits ? `pressed ${params.Digits}` : "");
            if (utterance) book.line(callId, "callee", speech || `Pressed ${params.Digits}`);
            const turn = info.dialog.respond(utterance);
            if (turn.acknowledge || params.Digits === "1") book.update(callId, { digits: `${call.digits ?? ""}1` });
            book.line(callId, "agent", turn.say);
            return conversationXml({ say: turn.say, end: Boolean(turn.end) }, callbackUrl(callId, "digits"));
          }
          if (params.Digits) book.update(callId, { digits: params.Digits.slice(0, 32) });
          // The call's own reply for the key pressed, or a plain goodbye.
          return xmlReply(info.gather?.replies?.[params.Digits ?? ""] ?? "Thank you. Goodbye.");
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

    openStream(callId, token, socket) {
      const info = placed.get(callId);
      const expected = info?.streamToken;
      if (!info || !expected || info.streamOpened || !options.speech || !info.dialog) return null;
      const given = Buffer.from(token);
      if (given.length !== expected.length || !timingSafeEqual(given, Buffer.from(expected))) return null;
      info.streamOpened = true;
      const dialog = info.dialog;
      return streamConversation({
        socket,
        speech: options.speech,
        opening: openingOf(info.script, info.gather),
        ...(info.openingAudio ? { openingAudio: info.openingAudio } : {}),
        respond: (utterance) => dialog.respond(utterance),
        ...(options.answer && dialog.facts ? { answer: options.answer, facts: () => dialog.facts!() } : {}),
        onLine: (speaker, text) => book.line(callId, speaker, text),
        // The same signal as pressing 1: the engine sees the digit and marks the page acknowledged.
        onAcknowledge: () => book.update(callId, { digits: `${book.get(callId)?.digits ?? ""}1` }),
        hangup: async () => {
          if (info.callUuid) await request("DELETE", `/Call/${encodeURIComponent(info.callUuid)}/`);
          else socket.close();
        },
        onError: (error) => console.error(`[vobiz] ${callId}: ${error instanceof Error ? error.message : String(error)}`),
        ...(options.onRecording ? { onRecording: (pcm: Buffer) => options.onRecording!(callId, wavOf(pcm)) } : {}),
      });
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
