import type { DialogTurn } from "@crisiscrew/core";
import { SPEECH_RATE, type CallSpeech } from "./sarvam";

/** The WebSocket Vobiz streams a call's audio over, as far as a conversation needs it. */
export type StreamSocket = { send(data: string): void; close(): void };

export type StreamConversationOptions = {
  socket: StreamSocket;
  speech: CallSpeech;
  /** What the call says as soon as the stream opens. */
  opening: string;
  /** CrisisCrew's answer to one turn of the callee's speech. */
  respond(utterance: string): DialogTurn;
  /** One line of the transcript, as it happens. */
  onLine(speaker: "agent" | "callee", text: string): void;
  /** The callee took the incident. */
  onAcknowledge(): void;
  /** Hangs the call up, once the last reply has played. */
  hangup(): Promise<void>;
  onError?(error: unknown): void;
};

/** A spoken turn needs this many 20 ms frames above the noise to start: 80 ms, or 240 ms while the agent is talking. */
const START_FRAMES = 4;
const BARGE_IN_FRAMES = 12;
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
 * dialog answers, and the answer is spoken back into the call. Talking over
 * the agent stops it (barge-in), and a newer turn makes an answer still
 * being prepared stale.
 */
export function streamConversation(options: StreamConversationOptions) {
  const { socket, speech } = options;
  let streamId: string | null = null;
  let speaking = false;
  let hangUpAfterPlayback = false;
  let ended = false;
  let turn = 0;
  let checkpoints = 0;

  let floor = 150;
  let inSpeech = false;
  let loud = 0;
  let quiet = 0;
  let pre: Buffer[] = [];
  let spoken: Buffer[] = [];
  let carry = Buffer.alloc(0);

  const send = (message: object) => {
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      options.onError?.(error);
    }
  };

  function play(pcm: Buffer, hangUp = false): void {
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      send({ event: "playAudio", streamId, media: { contentType: "audio/x-l16", sampleRate: SPEECH_RATE, payload: pcm.subarray(i, i + CHUNK_BYTES).toString("base64") } });
    }
    // Vobiz answers the checkpoint with playedStream once everything before it has played.
    send({ event: "checkpoint", streamId, name: `turn-${++checkpoints}` });
    speaking = true;
    hangUpAfterPlayback = hangUp;
  }

  async function speak(text: string, hangUp = false, at = turn): Promise<void> {
    const audio = await speech.say(text);
    if (at !== turn || ended) return; // the callee spoke again while this was being prepared
    options.onLine("agent", text);
    play(audio, hangUp);
  }

  async function answer(pcm: Buffer): Promise<void> {
    const at = ++turn;
    try {
      const heard = await speech.hear(pcm);
      // Coughs and clicks come back as nothing, or as a stray letter.
      if (heard.replace(/[^\p{L}\p{N}]/gu, "").length < 2 || at !== turn || ended) return;
      options.onLine("callee", heard);
      const reply = options.respond(heard);
      if (reply.acknowledge) options.onAcknowledge();
      await speak(reply.say, Boolean(reply.end), at);
    } catch (error) {
      options.onError?.(error);
      if (at === turn && !ended) await speak("Sorry, I missed that. Could you say it again?", false, at).catch(() => {});
    }
  }

  function bargeIn(): void {
    if (!speaking) return;
    send({ event: "clearAudio", streamId });
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
        turn += 1; // whatever answer is still in flight is now stale
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
          speak(options.opening).catch((error) => options.onError?.(error));
          return;
        case "media": {
          if (!msg.media?.payload || ended) return;
          carry = Buffer.concat([carry, Buffer.from(msg.media.payload, "base64")]);
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
      ended = true;
    },
  };
}
