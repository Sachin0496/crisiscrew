import type { CrisisEvent, EventInput } from "@crisiscrew/contracts";

/** Ordered log of everything that happens, with numbered events so clients can resume a stream. */
export class EventBus {
  private seq = 0;
  private readonly log: CrisisEvent[] = [];
  private readonly listeners = new Set<(event: CrisisEvent) => void>();

  constructor(private readonly cap = 20_000) {}

  get lastSeq(): number {
    return this.seq;
  }

  emit(input: EventInput, at: number): CrisisEvent {
    this.seq += 1;
    const event = { ...input, seq: this.seq, at } as CrisisEvent;
    this.log.push(event);
    if (this.log.length > this.cap) this.log.splice(0, this.log.length - this.cap);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  since(seq: number): CrisisEvent[] {
    const i = this.log.findIndex((e) => e.seq > seq);
    return i === -1 ? [] : this.log.slice(i);
  }

  subscribe(listener: (event: CrisisEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
