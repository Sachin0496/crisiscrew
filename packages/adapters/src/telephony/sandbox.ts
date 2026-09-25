import type { CallState } from "@crisiscrew/contracts";
import { hashSeed, mulberry32, type Clock, type TelephonyPort } from "@crisiscrew/core";
import { CallBook, e164 } from "./calls";

export type SandboxCall = { id: string; to: string; purpose: string; script: string; outcome: CallState; digits?: string };

/**
 * Calls that are never dialled. Each one rings, then is answered (70%), not
 * answered (20%) or busy (10%), decided by a hash of the scenario and the
 * number so a replay always gives the same outcomes. An answered call that
 * asks for a key press gets "1".
 */
export function sandboxTelephony(options: { seed: string; clock: Clock; record?: SandboxCall[] }): TelephonyPort {
  const { seed, clock } = options;
  const book = new CallBook("sandbox", () => clock.now());
  let count = 0;

  async function progress(id: string, outcome: CallState, script: string, gather: boolean): Promise<void> {
    await clock.sleep(2_000);
    book.update(id, { state: "ringing" });
    await clock.sleep(6_000);
    if (outcome !== "completed") {
      book.update(id, { state: outcome, reason: outcome === "busy" ? "Busy line" : "No answer" });
      return;
    }
    book.update(id, { state: "answered" });
    // About two and a half words a second, as a text-to-speech voice reads.
    const durationSec = Math.max(5, Math.round(script.split(/\s+/).length / 2.5) + (gather ? 5 : 0));
    await clock.sleep(durationSec * 1000);
    book.update(id, { state: "completed", durationSec, ...(gather ? { digits: "1" } : {}) });
  }

  return {
    mode: "sandbox",
    adapter: "sandbox",
    async call({ to, script, purpose, gather, metadata }) {
      const number = e164(to);
      count += 1;
      const id = `CALL-${String(count).padStart(3, "0")}`;
      const roll = mulberry32(hashSeed(`${seed}:call:${number}:${count}`))();
      const outcome: CallState = roll < 0.7 ? "completed" : roll < 0.9 ? "no_answer" : "busy";
      book.open(id, number, purpose, metadata);
      options.record?.push({ id, to: number, purpose, script, outcome, ...(gather && outcome === "completed" ? { digits: "1" } : {}) });
      void progress(id, outcome, script, Boolean(gather));
      return { callId: id };
    },
    async status(callId) {
      return book.get(callId);
    },
    onUpdate(listener) {
      return book.subscribe(listener);
    },
  };
}
