import type { ClassifierInfo, ClusterView, CorrelationConfig, Policy, SignalView, Surface, Ticket, TicketType } from "@crisiscrew/contracts";
import { cosine, meanVector, type Vector } from "../math/vector";
import type { ClassifierVerdict, Embedder } from "../ports";
import { clusterComponents, meanPairwiseSimilarity } from "./cluster";
import { classify, extractEntities, questionForm, surfaceProfile, type ProductSurface, type PrototypeVectors } from "./enrich";
import { evaluateGates } from "./gates";
import { DEFAULT_PROTOTYPES, type Prototypes } from "./prototypes";

type Stored = { ticket: Ticket; vector: Vector; profile: Vector; signal: SignalView };
type OpenIncident = { id: string; members: Set<string>; centroid: Vector; profileCentroid: Vector; lastActivity: number };

export type PatternResult = {
  signal: SignalView;
  nearest: { ticketId: string; similarity: number }[];
  /** The cluster the new ticket belongs to (or its nearest pair), with every gate evaluated. */
  candidate: ClusterView | null;
  fires: boolean;
  /** Set when the ticket matches an open incident and should be linked to it. */
  joinIncidentId?: string;
};

export type ClassifierThresholds = Pick<Policy["classifier"], "failureMin" | "surfaceMin">;

export type PatternOptions = {
  prototypes?: Prototypes;
  /** The world's normal failure-report volume per surface; the policy floor applies below it. */
  baselinePerHour?: Partial<Record<Surface, number>>;
};

const HOUR = 3_600_000;
const INCIDENT_JOIN_WINDOW = HOUR;

export function ticketText(ticket: Pick<Ticket, "subject" | "body">): string {
  const text = [ticket.subject, ticket.body].filter(Boolean).join("\n");
  return text.replace(/\s+/g, " ").trim().slice(0, 1000);
}

/**
 * The Pattern Agent's detection logic (design section 5).
 *
 * Similarity between two tickets = semanticWeight x cosine of their sentence
 * embeddings (meaning) + (1 - semanticWeight) x cosine of their product-area
 * profiles (area). Pure: no I/O besides the embedder.
 */
export class PatternEngine {
  private readonly stored = new Map<string, Stored>();
  private readonly order: string[] = [];
  private readonly incidents = new Map<string, OpenIncident>();
  private prototypeVectors: PrototypeVectors | null = null;
  private surfaceOrder: ProductSurface[] = [];
  private readonly prototypes: Prototypes;

  constructor(
    private readonly embedder: Embedder,
    private readonly cfg: CorrelationConfig,
    private readonly options: PatternOptions = {},
  ) {
    this.prototypes = options.prototypes ?? DEFAULT_PROTOTYPES;
  }

  async init(): Promise<void> {
    const p = this.prototypes;
    const surfaceEntries = Object.entries(p.surfaces) as [ProductSurface, string[]][];
    const texts = [...surfaceEntries.flatMap(([, t]) => t), ...p.failure, ...p.question];
    const vectors = await this.embedder.embed(texts);
    let i = 0;
    const take = (n: number) => vectors.slice(i, (i += n));
    this.surfaceOrder = surfaceEntries.map(([surface]) => surface);
    this.prototypeVectors = {
      surfaces: surfaceEntries.map(([surface, t]) => ({ surface, vectors: take(t.length) })),
      failure: take(p.failure.length),
      question: take(p.question.length),
    };
  }

  signalOf(ticketId: string): SignalView | undefined {
    return this.stored.get(ticketId)?.signal;
  }

  /** Reads one ticket end to end: embed and classify it, then correlate it. The engine runs these as separate graph nodes. */
  async ingest(ticket: Ticket, verdict?: ClassifierVerdict, thresholds?: ClassifierThresholds): Promise<PatternResult> {
    await this.read(ticket);
    if (verdict && thresholds) this.applyVerdict(ticket.id, verdict, thresholds);
    return this.correlate(ticket.id);
  }

  /**
   * Embeds the ticket and classifies it against the prototype sentences: its
   * product area, and whether it reports a failure. Stores it for correlation.
   */
  async read(ticket: Ticket): Promise<SignalView> {
    if (!this.prototypeVectors) throw new Error("PatternEngine.init() must run before read()");
    const text = ticketText(ticket);
    const [vector] = await this.embedder.embed([text]);
    if (!vector) throw new Error("embedder returned no vector");

    const { surfaceScores, ...classification } = classify(vector, text, this.prototypeVectors, this.cfg);
    const weights = surfaceProfile(surfaceScores, this.cfg.surfaceTemperature, this.cfg.surfaceMin);
    const profile = Float32Array.from(this.surfaceOrder.map((s) => weights[s] ?? 0));
    const ticketType: TicketType = classification.isFailure ? "failure" : questionForm(text) ? "question" : "request";
    const signal: SignalView = {
      ticketId: ticket.id,
      ...classification,
      entities: extractEntities(text),
      ticketType,
      classifier: { source: "embeddings", ticketType },
    };
    this.stored.set(ticket.id, { ticket, vector, profile, signal });
    this.order.push(ticket.id);
    return signal;
  }

  /**
   * Takes a classifier's labels where it is confident enough, and keeps the
   * built-in answer where it isn't. Only the labels change: similarity still
   * comes from the embeddings, so the gates stay calibrated.
   */
  applyVerdict(ticketId: string, verdict: ClassifierVerdict, thresholds: ClassifierThresholds): SignalView {
    const stored = this.stored.get(ticketId);
    if (!stored) throw new Error(`no ticket ${ticketId}`);
    const typeSure = verdict.ticketType.confidence >= thresholds.failureMin;
    const areaSure = verdict.surface.confidence >= thresholds.surfaceMin;
    const ticketType = typeSure ? verdict.ticketType.label : (stored.signal.ticketType ?? "request");
    const info: ClassifierInfo = {
      source: typeSure || areaSure ? verdict.source : "embeddings",
      ...(verdict.model ? { model: verdict.model } : {}),
      ticketType,
      confidence: verdict.ticketType.confidence,
      surfaceConfidence: verdict.surface.confidence,
      latencyMs: verdict.latencyMs,
      ...(!typeSure && !areaSure ? { fallback: `${verdict.source} was unsure (${verdict.ticketType.confidence.toFixed(2)}), so the built-in answer stands` } : {}),
    };
    stored.signal = {
      ...stored.signal,
      ticketType,
      isFailure: typeSure ? verdict.ticketType.label === "failure" : stored.signal.isFailure,
      surface: areaSure ? verdict.surface.label : stored.signal.surface,
      classifier: info,
    };
    return stored.signal;
  }

  /** Records a fallback: the configured classifier didn't answer, so the built-in labels stand. */
  noteFallback(ticketId: string, source: string, reason: string): void {
    const stored = this.stored.get(ticketId);
    if (!stored) return;
    stored.signal = { ...stored.signal, classifier: { ...stored.signal.classifier!, fallback: `${source}: ${reason}; the built-in answer was used` } };
  }

  /** Marks what the prompt guard found in the ticket, so the UI can show it. The ticket stays data either way. */
  noteGuard(ticketId: string, guard: { flagged: boolean; reasons: string[] }): void {
    const stored = this.stored.get(ticketId);
    if (stored) stored.signal = { ...stored.signal, guard };
  }

  /** Groups the stored ticket with the last window of tickets and evaluates the incident gates. */
  correlate(ticketId: string): PatternResult {
    const stored = this.stored.get(ticketId);
    if (!stored) throw new Error(`no ticket ${ticketId}`);
    const { ticket, vector, profile, signal } = stored;

    const now = ticket.receivedAt;
    const windowStart = now - this.cfg.windowMin * 60_000;
    const active = this.order.filter((id) => {
      const at = this.stored.get(id)!.ticket.receivedAt;
      return at >= windowStart && at <= now;
    });

    const nearest = active
      .filter((id) => id !== ticket.id)
      .map((id) => ({ ticketId: id, similarity: this.similarity(ticket.id, id) }))
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3);

    const joinIncidentId = signal.isFailure ? this.matchIncident(vector, profile, now) : undefined;
    if (joinIncidentId) {
      const incident = this.incidents.get(joinIncidentId)!;
      incident.members.add(ticket.id);
      this.recentre(incident);
      incident.lastActivity = now;
      return { signal, nearest, candidate: { ...this.describe([...incident.members]), incidentId: joinIncidentId }, fires: false, joinIncidentId };
    }

    const inIncident = new Set([...this.incidents.values()].flatMap((i) => [...i.members]));
    const free = active.filter((id) => !inIncident.has(id));
    const components = clusterComponents(free, (a, b) => this.similarity(a, b), this.cfg.edgeThreshold);
    let members = components.find((c) => c.includes(ticket.id)) ?? [ticket.id];
    if (members.length === 1) {
      const pair = nearest.find((n) => !inIncident.has(n.ticketId));
      if (pair) members = [pair.ticketId, ticket.id];
    }

    const candidate = this.describe(members);
    return { signal, nearest, candidate, fires: candidate.fires };
  }

  /** Registers an incident so later matching failures join it instead of forming a new cluster. */
  attachIncident(incidentId: string, memberIds: readonly string[]): void {
    const known = memberIds.filter((id) => this.stored.has(id));
    if (known.length === 0) return;
    const lastActivity = Math.max(...known.map((id) => this.stored.get(id)!.ticket.receivedAt));
    const incident: OpenIncident = {
      id: incidentId,
      members: new Set(known),
      centroid: new Float32Array(),
      profileCentroid: new Float32Array(),
      lastActivity,
    };
    this.recentre(incident);
    this.incidents.set(incidentId, incident);
  }

  private recentre(incident: OpenIncident): void {
    const members = [...incident.members].map((id) => this.stored.get(id)!);
    incident.centroid = meanVector(members.map((m) => m.vector));
    incident.profileCentroid = meanVector(members.map((m) => m.profile));
  }

  private matchIncident(vector: Vector, profile: Vector, now: number): string | undefined {
    const w = this.cfg.semanticWeight;
    let best: { id: string; similarity: number } | undefined;
    for (const incident of this.incidents.values()) {
      if (now - incident.lastActivity > INCIDENT_JOIN_WINDOW) continue;
      const similarity = w * cosine(vector, incident.centroid) + (1 - w) * cosine(profile, incident.profileCentroid);
      if (similarity >= this.cfg.joinThreshold && (!best || similarity > best.similarity)) best = { id: incident.id, similarity };
    }
    return best?.id;
  }

  private meaning(a: string, b: string): number {
    return cosine(this.stored.get(a)!.vector, this.stored.get(b)!.vector);
  }

  private area(a: string, b: string): number {
    return cosine(this.stored.get(a)!.profile, this.stored.get(b)!.profile);
  }

  private similarity(a: string, b: string): number {
    const w = this.cfg.semanticWeight;
    return w * this.meaning(a, b) + (1 - w) * this.area(a, b);
  }

  private describe(memberIds: string[]): ClusterView {
    const members = memberIds.map((id) => this.stored.get(id)!).sort((a, b) => a.ticket.receivedAt - b.ticket.receivedAt);
    const ids = members.map((m) => m.ticket.id);
    const failures = members.filter((m) => m.signal.isFailure);
    const dominantSurface = mostCommonSurface(members.map((m) => m.signal.surface));
    const firstAt = members[0]!.ticket.receivedAt;
    const lastAt = members[members.length - 1]!.ticket.receivedAt;
    const failureTimes = failures.map((m) => m.ticket.receivedAt);
    const spanSec = failureTimes.length > 1 ? (Math.max(...failureTimes) - Math.min(...failureTimes)) / 1000 : 0;

    const single = members.length < 2;
    const meaning = single ? 1 : meanPairwiseSimilarity(ids, (a, b) => this.meaning(a, b));
    const area = single ? 1 : meanPairwiseSimilarity(ids, (a, b) => this.area(a, b));
    const w = this.cfg.semanticWeight;
    const cohesion = w * meaning + (1 - w) * area;

    const { gates, fires, burstP, baselinePerHour } = evaluateGates(
      {
        size: members.length,
        cohesion,
        failureCount: failures.length,
        spanSec,
        baselinePerHour: this.baselineBefore(dominantSurface, firstAt),
      },
      this.cfg,
    );

    return {
      id: `cl-${ids[0]}`,
      memberTicketIds: ids,
      reportTicketIds: failures.map((m) => m.ticket.id),
      cohesion,
      cohesionParts: { meaning, area },
      failureShare: failures.length / members.length,
      failureCount: failures.length,
      spanSec,
      burstP,
      baselinePerHour,
      dominantSurface,
      gates,
      fires,
      firstAt,
      lastAt,
    };
  }

  /** Normal volume: the world's figure for the surface, or failure reports seen in the hour before the cluster, whichever is higher. */
  private baselineBefore(surface: Surface, before: number): number {
    const prior = this.options.baselinePerHour?.[surface] ?? this.cfg.baselineFloorPerHour;
    let observed = 0;
    for (const s of this.stored.values()) {
      const at = s.ticket.receivedAt;
      if (s.signal.isFailure && s.signal.surface === surface && at >= before - HOUR && at < before) observed += 1;
    }
    return Math.max(prior, observed);
  }
}

function mostCommonSurface(surfaces: Surface[]): Surface {
  const counts = new Map<Surface, number>();
  for (const s of surfaces) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: Surface = "other";
  let bestCount = 0;
  for (const [surface, count] of counts) {
    if (count > bestCount || (count === bestCount && surface !== "other")) {
      best = surface;
      bestCount = count;
    }
  }
  return best;
}
