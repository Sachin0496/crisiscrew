import type { CallView } from "@crisiscrew/contracts";
import { describe, expect, it, vi } from "vitest";
import { pcmOf, sarvamSpeech, wavOf, type CallSpeech } from "./sarvam";
import { streamConversation } from "./stream";
import { vobizTelephony } from "./vobiz";

const FRAME = 640; // 20 ms of 16 kHz L16
const tone = (frames: number, amplitude = 4000) => {
  const buf = Buffer.alloc(FRAME * frames);
  for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 3)), i * 2);
  return buf;
};
const silence = (frames: number) => Buffer.alloc(FRAME * frames);
const media = (pcm: Buffer) => JSON.stringify({ event: "media", media: { payload: pcm.toString("base64") } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fakeSpeech(heard: string[] = []): CallSpeech & { said: string[] } {
  const said: string[] = [];
  return {
    name: "fake",
    said,
    hear: vi.fn(async () => heard.shift() ?? ""),
    say: vi.fn(async (text: string) => {
      said.push(text);
      return tone(5, 100);
    }),
  };
}

function conversation(speech: CallSpeech, respond = (u: string) => ({ say: `You said ${u}` })) {
  const sent: Record<string, unknown>[] = [];
  const lines: [string, string][] = [];
  const hooks = { acknowledged: 0, hungUp: 0 };
  const convo = streamConversation({
    socket: { send: (d) => sent.push(JSON.parse(d)), close: () => {} },
    speech,
    opening: "Hello Neha, CrisisCrew here.",
    respond,
    onLine: (speaker, text) => lines.push([speaker, text]),
    onAcknowledge: () => hooks.acknowledged++,
    hangup: async () => {
      hooks.hungUp++;
    },
  });
  return { convo, sent, lines, hooks };
}

describe("streamed call conversation", () => {
  it("speaks the opening when the stream starts, then answers each spoken turn", async () => {
    const speech = fakeSpeech(["what changed"]);
    const { convo, sent, lines } = conversation(speech);
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1", callId: "c1" } }));
    await flush();
    expect(sent.filter((m) => m.event === "playAudio")[0]).toMatchObject({ streamId: "s1", media: { contentType: "audio/x-l16", sampleRate: 16000 } });
    expect(sent.at(-1)).toMatchObject({ event: "checkpoint", name: "turn-1" });
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-1" }));

    convo.receive(media(silence(10)));
    convo.receive(media(tone(30)));
    convo.receive(media(silence(40)));
    await flush();
    await flush();
    expect(speech.hear).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([
      ["agent", "Hello Neha, CrisisCrew here."],
      ["callee", "what changed"],
      ["agent", "You said what changed"],
    ]);
  });

  it("ignores noise that transcribes to nothing", async () => {
    const speech = fakeSpeech([""]);
    const { convo, lines } = conversation(speech);
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    await flush();
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-1" }));
    convo.receive(media(Buffer.concat([tone(10), silence(40)])));
    await flush();
    expect(lines.map(([s]) => s)).toEqual(["agent"]);
  });

  it("acknowledges, and hangs up once the last reply has played", async () => {
    const speech = fakeSpeech(["acknowledge, bye"]);
    const { convo, sent, hooks } = conversation(speech, () => ({ say: "Thanks, goodbye.", acknowledge: true, end: true }));
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    await flush();
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-1" }));
    convo.receive(media(Buffer.concat([tone(20), silence(40)])));
    await flush();
    await flush();
    expect(hooks.acknowledged).toBe(1);
    expect(hooks.hungUp).toBe(0);
    expect(sent.at(-1)).toMatchObject({ event: "checkpoint", name: "turn-2" });
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-2" }));
    expect(hooks.hungUp).toBe(1);
  });

  it("stops talking when the callee talks over it", async () => {
    const { convo, sent } = conversation(fakeSpeech());
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    await flush();
    convo.receive(media(tone(5))); // too short to interrupt
    expect(sent.some((m) => m.event === "clearAudio")).toBe(false);
    convo.receive(media(silence(2)));
    convo.receive(media(tone(25)));
    expect(sent.at(-1)).toEqual({ event: "clearAudio", streamId: "s1" });
  });

  it("always plays the opening, even when the callee talks while it's being prepared", async () => {
    let release!: (pcm: Buffer) => void;
    const speech = fakeSpeech(["hello"]);
    const lines: [string, string][] = [];
    const openingAudio = new Promise<Buffer>((resolve) => (release = resolve));
    const convo = streamConversation({
      socket: { send: () => {}, close: () => {} },
      speech,
      opening: "Hello Neha, CrisisCrew here.",
      openingAudio,
      respond: (u) => ({ say: `You said ${u}` }),
      onLine: (speaker, text) => lines.push([speaker, text]),
      onAcknowledge: () => {},
      hangup: async () => {},
    });
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    convo.receive(media(Buffer.concat([tone(20), silence(40)]))); // "hello" before the opening is ready
    await flush();
    await flush();
    release(tone(5, 100));
    await flush();
    await flush();
    expect(lines).toContainEqual(["callee", "hello"]);
    expect(lines).toContainEqual(["agent", "Hello Neha, CrisisCrew here."]);
    expect(speech.say).not.toHaveBeenCalledWith("Hello Neha, CrisisCrew here."); // it came from the audio made while ringing
  });

  it("keeps a reply when only noise follows it, and says a line again when noise cut it off", async () => {
    let finishReply!: (pcm: Buffer) => void;
    const heard = ["what changed", "", ""];
    const said: string[] = [];
    const speech: CallSpeech = {
      name: "fake",
      hear: async () => heard.shift() ?? "",
      say: async (text) => {
        said.push(text);
        return text.startsWith("You said") && said.filter((t) => t.startsWith("You said")).length === 1 ? new Promise<Buffer>((r) => (finishReply = r)) : tone(5, 100);
      },
    };
    const { convo, sent, lines } = conversation(speech);
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    await flush();
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-1" }));
    convo.receive(media(Buffer.concat([tone(20), silence(40)]))); // "what changed"
    await flush();
    convo.receive(media(Buffer.concat([tone(10), silence(40)]))); // a cough while the reply is being prepared
    await flush();
    finishReply(tone(5, 100));
    await flush();
    await flush();
    expect(lines.at(-1)).toEqual(["agent", "You said what changed"]);
    // Noise talks over the reply: it stops, and, since nothing was said, plays again.
    convo.receive(media(tone(25)));
    expect(sent.at(-1)).toEqual({ event: "clearAudio", streamId: "s1" });
    convo.receive(media(silence(40)));
    await flush();
    await flush();
    expect(lines.filter(([, t]) => t === "You said what changed")).toHaveLength(2);
  });
});

describe("Sarvam speech", () => {
  it("round-trips PCM through a WAV header", () => {
    const pcm = tone(3);
    expect(pcmOf(wavOf(pcm)).equals(pcm)).toBe(true);
  });

  it("hears English with saaras:v3 and speaks with bulbul:v3 at 16 kHz", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body });
      if (url.endsWith("/speech-to-text")) return Response.json({ transcript: " what changed " });
      return Response.json({ audios: [wavOf(tone(2)).toString("base64")] });
    }) as unknown as typeof globalThis.fetch;
    const speech = sarvamSpeech({ apiKey: "k", speaker: "anand", fetch });
    expect(await speech.hear(tone(2))).toBe("what changed");
    const form = calls[0]!.body as FormData;
    expect([form.get("model"), form.get("language_code")]).toEqual(["saaras:v3", "en-IN"]);
    expect((await speech.say("Hello")).length).toBe(FRAME * 2);
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({ model: "bulbul:v3", speaker: "anand", speech_sample_rate: 16000, target_language_code: "en-IN" });
  });

  it("says why Sarvam refused", async () => {
    const fetch = (async () => Response.json({ error: { message: "Invalid API key" } }, { status: 403 })) as unknown as typeof globalThis.fetch;
    await expect(sarvamSpeech({ apiKey: "bad", fetch }).say("hi")).rejects.toThrow(/403: Invalid API key/);
  });
});

describe("Vobiz streamed calls", () => {
  function adapter(options: { allowedNumbers?: string[] } = {}) {
    const sent: { url: string; method: string }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      sent.push({ url: String(url), method: init?.method ?? "GET" });
      return Response.json({ request_uuid: "req-1" }, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const vobiz = vobizTelephony({ authId: "MA1", authToken: "t", from: "+918065551234", publicBaseUrl: "https://crisis.example.com", speech: fakeSpeech(["acknowledge"]), fetch, ...options });
    const updates: CallView[] = [];
    vobiz.onUpdate((c) => updates.push(c));
    return { vobiz, sent, updates };
  }
  const dialog = { respond: () => ({ say: "It's yours.", acknowledge: true }) };

  it("answers a conversational call with a bidirectional stream to its own tokened URL", async () => {
    const { vobiz } = adapter();
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "oncall", dialog });
    const xml = vobiz.handleCallback(callId, "answer", { RequestUUID: "req-1", CallUUID: "uuid-1" })!;
    const url = /<Stream [^>]*bidirectional="true"[^>]*>([^<]+)<\/Stream>/.exec(xml)?.[1];
    expect(url).toMatch(new RegExp(`^wss://crisis\\.example\\.com/api/webhooks/vobiz/${callId}/stream\\?token=[\\w-]{32}$`));
    // A call without a dialog keeps Vobiz's own voice.
    const plain = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "customer" });
    expect(vobiz.handleCallback(plain.callId, "answer", {})).toContain("<Speak>Hi</Speak>");
  });

  it("opens the stream once, only with the right token, and acknowledges like pressing 1", async () => {
    const { vobiz, updates } = adapter();
    const { callId } = await vobiz.call({ to: "+919876543210", script: "Hi", purpose: "oncall", dialog });
    const xml = vobiz.handleCallback(callId, "answer", { RequestUUID: "req-1", CallUUID: "uuid-1" })!;
    const token = /token=([\w-]+)/.exec(xml)![1]!;
    const socket = { send: () => {}, close: () => {} };
    expect(vobiz.openStream(callId, "wrong-token-wrong-token-wrong-to", socket)).toBeNull();
    const convo = vobiz.openStream(callId, token, socket)!;
    expect(convo).not.toBeNull();
    expect(vobiz.openStream(callId, token, socket)).toBeNull();
    convo.receive(JSON.stringify({ event: "start", start: { streamId: "s1" } }));
    await flush();
    convo.receive(JSON.stringify({ event: "playedStream", name: "turn-1" }));
    convo.receive(media(Buffer.concat([tone(20), silence(40)])));
    await flush();
    await flush();
    const last = updates.at(-1)!;
    expect(last.digits).toBe("1");
    expect(last.transcript?.map((t) => t.speaker)).toEqual(["agent", "callee", "agent"]);
  });

  it("refuses numbers outside the allow-list before dialling", async () => {
    const { vobiz, sent } = adapter({ allowedNumbers: ["+91 98450 12345"] });
    await expect(vobiz.call({ to: "+91 90000 10001", script: "Hi", purpose: "oncall" })).rejects.toThrow(/••••0001 is not on VOBIZ_ALLOWED_NUMBERS/);
    expect(sent).toHaveLength(0);
    await vobiz.call({ to: "+919845012345", script: "Hi", purpose: "oncall" });
    expect(sent).toHaveLength(1);
  });
});
