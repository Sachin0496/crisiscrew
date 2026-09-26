import type { DialogTurn } from "@crisiscrew/core";
import { SPEECH_RATE, type CallAnswerer, type CallSpeech } from "./sarvam";

/** The WebSocket Vobiz streams a call's audio over, as far as a conversation needs it. */
export type StreamSocket = { send(data: string): void; close(): void };

export type StreamConversationOptions = {
  socket: StreamSocket;
  speech: CallSpeech;
  /** What the call says as soon as the stream opens. */
  opening: string;
  /** The opening, already synthesized while the phone rang, so it plays the moment the stream opens. */
  openingAudio?: Promise<Buffer>;
  /** CrisisCrew's answer to one turn of the callee's speech. */
  respond(utterance: string): DialogTurn;
  /** For open questions: words an answer from facts() alone; the rules' reply stands if it fails or says nothing. */
  answer?: CallAnswerer;
  facts?(): string;
  /** One line of the transcript, as it happens. */
  onLine(speaker: "agent" | "callee", text: string): void;
  /** The callee took the incident. */
  onAcknowledge(): void;
  /** Hangs the call up, once the last reply has played. */
  hangup(): Promise<void>;
  onError?(error: unknown): void;
  /** When set, the whole call (both sides, mixed) is handed over as 16 kHz PCM once the stream closes. */
  onRecording?(pcm: Buffer): void;
};

/** A spoken turn needs this many 20 ms frames above the noise to start: 80 ms, or 400 ms to interrupt the agent. */
const START_FRAMES = 4;
const BARGE_IN_FRAMES = 20;
/** 700 ms of quiet ends a turn; no turn runs past 15 s. */
const END_FRAMES = 35;
const MAX_FRAMES = 750;
/** Audio kept from just before a turn starts, so its first syllable isn't cut: 300 ms. */
const PRE_ROLL = 15;
const FRAME_BYTES = (SPEECH_RATE / 50) * 2;
/** Played in 200 ms chunks. */
const CHUNK_BYTES = FRAME_BYTES * 10;

function rms(frame: Buffer): number {
  let sum = 0;
  const n = frame.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = frame.readInt16LE(i * 2);
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

type StreamEvent = {
  event?: string;
  streamId?: string;
  name?: string;
  start?: { streamId?: string; callId?: string };
  media?: { payload?: string };
};

/**
 * A phone conversation over a bidirectional Vobiz audio stream. Vobiz sends
 * the callee's audio as 16 kHz L16; a simple energy detector finds where each
 * spoken turn starts and ends, the speech port turns it into text, the
 * dialog answers, and the answer is spoken back into the call. The opening
 * always plays. Talking over the agent stops it (barge-in); if what
 * interrupted it had no words, the agent says its line again. Only a newer
 * turn with words makes an answer still being prepared stale, so noise and
 * coughs never cost the callee a reply.
 */
export function streamConversation(options: StreamConversationOptions) {
  const { socket, speech } = options;
  let streamId: string | null = null;
  let speaking = false;
  let hangUpAfterPlayback = false;
  let ended = false;
  let turn = 0;
  let checkpoints = 0;
  /** What the agent was saying when the callee talked over it, until we know whether they said anything. */
  let lastSaid: { text: string; hangUp: boolean } | null = null;
  let interrupted: { text: string; hangUp: boolean } | null = null;

  let floor = 150;
  let inSpeech = false;
  let loud = 0;
  let quiet = 0;
  let pre: Buffer[] = [];
  let spoken: Buffer[] = [];
  let carry = Buffer.alloc(0);

  // The recording: the callee's audio as it arrives (Vobiz streams silence too, so it keeps time), and each
  // agent line placed where it started playing, cut short where the callee talked over it.
  const heardAudio: Buffer[] = [];
  let heardBytes = 0;
  const agentAudio: { at: number; pcm: Buffer }[] = [];
  const agentEnd = () => agentAudio.reduce((end, a) => Math.max(end, a.at + a.pcm.length), 0);

  const send = (message: object) => {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      options.onError?.(error);
    }
  };

  function play(pcm: Buffer, hangUp = false): void {
    if (options.onRecording) agentAudio.push({ at: Math.max(heardBytes, agentEnd()), pcm });
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      send({ event: "playAudio", streamId, media: { contentType: "audio/x-l16", sampleRate: SPEECH_RATE, payload: pcm.subarray(i, i + CHUNK_BYTES).toString("base64") } });
    }
    // Vobiz answers the checkpoint with playedStream once everything before it has played.
    send({ event: "checkpoint", streamId, name: `turn-${++checkpoints}` });
    speaking = true;
    hangUpAfterPlayback = hangUp;
  }

  /** Speaks a line. With a turn number, the line is dropped if a newer turn with words arrived while it was being prepared. */
  async function speak(text: string, hangUp = false, at?: number, audio?: Promise<Buffer>): Promise<void> {
    const pcm = await (audio ?? speech.say(text));
    if ((at !== undefined && at !== turn) || ended) return;
    options.onLine("agent", text);
    lastSaid = { text, hangUp };
    play(pcm, hangUp);
  }

  async function answer(pcm: Buffer): Promise<void> {
    let at: number | undefined;
    try {
      const heard = await speech.hear(pcm);
      if (ended) return;
      // Coughs, clicks and noise come back as nothing, or as a stray letter: they change nothing, except that an
      // agent line they cut off is said again.
      if (heard.replace(/[^\p{L}\p{N}]/gu, "").length < 2) {
        const again = interrupted;
        interrupted = null;
        if (again && !speaking) await speak(again.text, again.hangUp);
        return;
      }
      interrupted = null;
      at = ++turn; // the newest turn with words: any answer still being prepared for an older one is stale
      options.onLine("callee", heard);
      const reply = options.respond(heard);
      if (reply.acknowledge) options.onAcknowledge();
      let say = reply.say;
      if (reply.open && !reply.end && options.answer && options.facts) {
        try {
          const worded = await options.answer(heard, options.facts());
          if (worded && at === turn && !ended) say = `${reply.acknowledge ? say.split(/(?<=yours\.)\s/)[0] + " " : ""}${worded}`.trim();
        } catch (error) {
          options.onError?.(error);
        }
      }
      await speak(say, Boolean(reply.end), at);
    } catch (error) {
      options.onError?.(error);
      if ((at === undefined || at === turn) && !ended) await speak("Sorry, I missed that. Could you say it again?", false, at).catch(() => {});
    }
  }

  function bargeIn(): void {
    if (!speaking) return;
    send({ event: "clearAudio", streamId });
    const last = agentAudio.at(-1);
    if (last && last.at + last.pcm.length > heardBytes) last.pcm = last.pcm.subarray(0, Math.max(0, heardBytes - last.at));
    interrupted = lastSaid;
    speaking = false;
    hangUpAfterPlayback = false;
  }

  function frame(pcm: Buffer): void {
    const level = rms(pcm);
    const isLoud = level > Math.max(floor * 3, 700);
    if (!inSpeech) {
      pre.push(pcm);
      if (pre.length > PRE_ROLL) pre.shift();
      if (isLoud) loud += 1;
      else {
        loud = 0;
        floor = floor * 0.95 + level * 0.05;
      }
      if (loud >= (speaking ? BARGE_IN_FRAMES : START_FRAMES)) {
        inSpeech = true;
        quiet = 0;
        spoken = pre;
        pre = [];
        bargeIn();
      }
      return;
    }
    spoken.push(pcm);
    quiet = isLoud ? 0 : quiet + 1;
    if (quiet >= END_FRAMES || spoken.length >= MAX_FRAMES) {
      inSpeech = false;
      loud = 0;
      const audio = Buffer.concat(spoken);
      spoken = [];
      void answer(audio);
    }
  }

  return {
    /** One message from Vobiz over the socket. */
    receive(data: string): void {
      let msg: StreamEvent;
      try {
        msg = JSON.parse(data) as StreamEvent;
      } catch {
        return;
      }
      switch (msg.event) {
        case "start":
          streamId = msg.start?.streamId ?? msg.streamId ?? null;
          // The opening always plays, whatever the callee says while it's being prepared.
          speak(options.opening, false, undefined, options.openingAudio?.catch(() => speech.say(options.opening))).catch((error) => options.onError?.(error));
          return;
        case "media": {
          if (!msg.media?.payload || ended) return;
          const chunk = Buffer.from(msg.media.payload, "base64");
          if (options.onRecording) {
            heardAudio.push(chunk);
            heardBytes += chunk.length;
          }
          carry = Buffer.concat([carry, chunk]);
          while (carry.length >= FRAME_BYTES) {
            frame(carry.subarray(0, FRAME_BYTES));
            carry = carry.subarray(FRAME_BYTES);
          }
          return;
        }
        case "playedStream":
          speaking = false;
          if (hangUpAfterPlayback && !ended) {
            ended = true;
            options.hangup().catch((error) => options.onError?.(error));
          }
          return;
        case "clearedAudio":
          speaking = false;
          return;
      }
    },
    /** The socket closed: nothing more to say. */
    close(): void {
      if (ended && !options.onRecording) return;
      ended = true;
      if (!options.onRecording || (heardBytes === 0 && agentAudio.length === 0)) return;
      const mix = Buffer.alloc(Math.max(heardBytes, agentEnd()) & ~1);
      Buffer.concat(heardAudio).copy(mix);
      for (const { at, pcm } of agentAudio) {
        for (let i = 0; i + 1 < pcm.length && at + i + 1 < mix.length; i += 2) {
          mix.writeInt16LE(Math.max(-32768, Math.min(32767, mix.readInt16LE(at + i) + pcm.readInt16LE(i))), at + i);
        }
      }
      const recorded = options.onRecording;
      options.onRecording = undefined; // once
      recorded(mix);
    },
  };
}
