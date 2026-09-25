import type { AgentId, AgentStatus, CrisisState, EventInput, IncidentStatus, Policy } from "@crisiscrew/contracts";
import type { PolicyGate } from "../policy/gate";
import type { Ports } from "../ports";
import type { Draft } from "../recovery/templates";
import type { ToolCtx } from "../tools/definitions";
import type { Tracer } from "../trace/tracer";

/** What every agent gets: the policy gate (its only way to act), a read-only view of state, and status reporting. */
export type AgentKit = {
  gate: PolicyGate<ToolCtx>;
  state(): CrisisState;
  /** The update drafted for an incident, once draft_customer_update has run. */
  draftFor(incidentId: string): Draft | undefined;
  policy: Policy;
  ports: Pick<Ports, "catalog">;
  now(): number;
  /** Waits on the session's clock (scaled in replays). */
  sleep(ms: number): Promise<void>;
  /** False once a newer session has replaced this one: nothing more should reach the outside world. */
  alive(): boolean;
  emit(event: EventInput): void;
  setAgent(agent: AgentId, status: AgentStatus, task?: string): void;
  setStatus(incidentId: string, to: IncidentStatus, note: string): void;
  /** Runs one incident's recovery steps one at a time, so two passes never plan or pay the same thing. */
  serial<T>(incidentId: string, run: () => Promise<T>): Promise<T>;
  /** "incidentId:customerRef" pairs whose ticket already carries the recovery outcome note. */
  noted: Set<string>;
  /** Records workflow runs as traces; every gate call inside a node becomes a span of it. */
  tracer: Tracer;
};

/** Runs up to `size` promises at a time, in order. */
export async function inBatches<T>(items: T[], size: number, run: (item: T) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(run));
}
