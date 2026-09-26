/** 16-bit little-endian mono PCM at 16 kHz: what Vobiz streams in, and what is played back. */
export const SPEECH_RATE = 16_000;

/** How a streamed call hears and speaks. */
export interface CallSpeech {
  readonly name: string;
  /** Speech to text, for one turn of the callee's audio. Empty text when nothing was said. */
  hear(pcm: Buffer): Promise<string>;
  /** Text to speech, as PCM ready to stream into the call. */
  say(text: string): Promise<Buffer>;
}

export type SarvamSpeechOptions = {
  apiKey: string;
  /** A bulbul:v3 voice, e.g. priya, rahul, anand. */
  speaker?: string;
  /** Speaking rate, 0.5 to 2.0; 1 is bulbul's normal pace. */
  pace?: number;
  /** Injected in tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  apiBase?: string;
};

export class SarvamError extends Error {
  override name = "SarvamError";
}

/** A 44-byte WAV header around PCM, so the speech-to-text API can read it. */
export function wavOf(pcm: Buffer, rate = SPEECH_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** The PCM inside a WAV file: the "data" chunk, wherever the encoder put it. */
export function pcmOf(wav: Buffer): Buffer {
  let i = 12;
  while (i + 8 <= wav.length) {
    const id = wav.toString("ascii", i, i + 4);
    const size = wav.readUInt32LE(i + 4);
    if (id === "data") return wav.subarray(i + 8, Math.min(wav.length, i + 8 + size));
    i += 8 + size + (size % 2);
  }
  return wav.subarray(Math.min(44, wav.length));
}

/**
 * Sarvam AI as the voice of a streamed call, in English: saaras:v3 hears each
 * turn (REST speech to text) and bulbul:v3 speaks each reply at 16 kHz, the
 * rate the call streams at. What is said still comes from CrisisCrew; Sarvam
 * only turns it into speech and back.
 */
export function sarvamSpeech(options: SarvamSpeechOptions): CallSpeech {
  const api = (options.apiBase ?? "https://api.sarvam.ai").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeout = () => AbortSignal.timeout(options.timeoutMs ?? 15_000);

  async function read<T>(res: Response, what: string): Promise<T> {
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const json = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
        detail = (typeof json.error === "string" ? json.error : json.error?.message) ?? json.message ?? detail;
      } catch {
        // not JSON: keep the text
      }
      throw new SarvamError(`Sarvam ${what} failed with ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return JSON.parse(text) as T;
  }

  return {
    name: "sarvam",

    async hear(pcm) {
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(wavOf(pcm))], { type: "audio/wav" }), "turn.wav");
      form.append("model", "saaras:v3");
      form.append("language_code", "en-IN");
      const res = await doFetch(`${api}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": options.apiKey }, body: form, signal: timeout() });
      const json = await read<{ transcript?: string }>(res, "speech to text");
      return (json.transcript ?? "").trim();
    },

    async say(text) {
      const res = await doFetch(`${api}/text-to-speech`, {
        method: "POST",
        headers: { "api-subscription-key": options.apiKey, "content-type": "application/json" },
        body: JSON.stringify({ text, target_language_code: "en-IN", model: "bulbul:v3", speaker: options.speaker ?? "priya", speech_sample_rate: SPEECH_RATE, ...(options.pace ? { pace: options.pace } : {}) }),
        signal: timeout(),
      });
      const json = await read<{ audios?: string[] }>(res, "text to speech");
      if (!json.audios?.length) throw new SarvamError("Sarvam text to speech returned no audio");
      return Buffer.concat(json.audios.map((a) => pcmOf(Buffer.from(a, "base64"))));
    },
  };
}

/** Answers a free-form question on a call from the facts given, and nothing else. */
export type CallAnswerer = (question: string, facts: string) => Promise<string>;

const ANSWER_RULES = `You are CrisisCrew's voice agent, on a live phone call with the on-call engineer about an incident.
Answer the engineer's question in one to three short spoken sentences, at most 60 words.
Use ONLY the facts below. If they don't contain the answer, say you don't know that yet, and say what you do know that is closest.
Never invent numbers, file names, people, times or links. Never promise anything the facts don't say.
Plain speech only: no markdown, lists, emojis or stage directions. Say "pull request" rather than "PR".`;

/**
 * Sarvam's conversational model (sarvam-105b-conversations) answering one
 * question on a call, grounded in the facts CrisisCrew passes: the incident
 * and the Fix Agent's live state. It never decides anything; it only words
 * an answer from what the engine knows.
 */
export function sarvamAnswerer(options: { apiKey: string; model?: string; fetch?: typeof fetch; timeoutMs?: number; apiBase?: string }): CallAnswerer {
  const api = (options.apiBase ?? "https://api.sarvam.ai").replace(/\/+$/, "");
  return async (question, facts) => {
    const res = await (options.fetch ?? fetch)(`${api}/v1/chat/completions`, {
      method: "POST",
      headers: { "api-subscription-key": options.apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        model: options.model ?? "sarvam-105b-conversations",
        max_tokens: 160,
        temperature: 0.2,
        messages: [
          { role: "system", content: `${ANSWER_RULES}\n\nFacts:\n${facts}` },
          { role: "user", content: question },
        ],
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 4_000),
    });
    const json = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } };
    if (!res.ok) throw new SarvamError(`Sarvam chat failed with ${res.status}: ${json.error?.message ?? ""}`);
    return (json.choices?.[0]?.message?.content ?? "").replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim();
  };
}
