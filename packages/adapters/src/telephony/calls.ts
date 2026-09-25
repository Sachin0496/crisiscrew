import { FINAL_CALL_STATES, type CallPurpose, type CallState, type CallView } from "@crisiscrew/contracts";

/** Accepts "+91 98765 43210", "0091-9876543210" or "919876543210" and returns "+919876543210"; throws on anything else. */
export function e164(input: string): string {
  const digits = input.trim().replace(/^00/, "+").replace(/[\s()-]/g, "");
  const normalized = digits.startsWith("+") ? digits : `+${digits}`;
  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) throw new Error(`not a phone number in E.164 format: "${maskNumber(input)}"`);
  return normalized;
}

/** "+919876543210" → "••••3210": enough to tell calls apart, never the whole number in the UI or logs. */
export function maskNumber(input: string): string {
  const digits = input.replace(/\D/g, "");
  return `••••${digits.slice(-4)}`;
}

export const isFinal = (state: CallState) => FINAL_CALL_STATES.includes(state);

/**
 * The calls an adapter has placed, and who wants to hear about them. A final
 * state is never replaced: a late or repeated callback can't reopen a call.
 */
export class CallBook {
  private readonly calls = new Map<string, CallView>();
  private readonly listeners = new Set<(call: CallView) => void>();

  constructor(
    private readonly adapter: string,
    private readonly now: () => number,
  ) {}

  open(id: string, to: string, purpose: CallPurpose, metadata?: Record<string, string>): CallView {
    const at = this.now();
    const call: CallView = { id, purpose, to: maskNumber(to), state: "queued", adapter: this.adapter, startedAt: at, updatedAt: at, ...(metadata ? { metadata } : {}) };
    this.calls.set(id, call);
    this.notify(call);
    return call;
  }

  get(id: string): CallView | null {
    return this.calls.get(id) ?? null;
  }

  /** Applies a change and tells the listeners. Returns the call, unchanged when it was already final or unknown. */
  update(id: string, change: Partial<Pick<CallView, "state" | "durationSec" | "digits" | "reason">>): CallView | null {
    const call = this.calls.get(id);
    if (!call) return null;
    if (isFinal(call.state) && change.state !== undefined) return call;
    const next: CallView = { ...call, ...change, updatedAt: this.now() };
    this.calls.set(id, next);
    this.notify(next);
    return next;
  }

  subscribe(listener: (call: CallView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(call: CallView): void {
    for (const listener of this.listeners) listener(call);
  }
}
