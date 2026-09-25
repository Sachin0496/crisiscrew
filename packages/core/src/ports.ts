import type { Customer, GuardVerdict, PaymentMethod, Surface, Ticket, TicketType } from "@crisiscrew/contracts";

/**
 * Ports: the only way core reaches the outside world. Sandbox adapters
 * implement every port; live adapters (Freshdesk, Freshservice) are chosen
 * by the switches in .env.example.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface Embedder {
  readonly id: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export type Deployment = {
  service: string;
  version: string;
  sha: string;
  author: string;
  at: number;
  message: string;
  environment: string;
};

export type ProviderHealth = {
  provider: string;
  status: "operational" | "degraded" | "outage";
  components: { name: string; status: string }[];
  detail: string;
};

export type PaymentAttempt = {
  customerRef: string;
  at: number;
  method: PaymentMethod;
  status: "success" | "failed" | "pending";
  amountInr: number;
};

export type ErrorRatePoint = { at: number; rate: number };

export type AdapterMode = { mode: "sandbox" | "live" | "off"; adapter: string };

export interface DeploymentsPort extends AdapterMode {
  recent(service: string, sinceMs: number): Promise<Deployment[]>;
}

export interface PaymentsPort extends AdapterMode {
  health(): Promise<ProviderHealth[]>;
}

export interface MetricsPort extends AdapterMode {
  errorRates(service: string, fromMs: number, toMs: number): Promise<ErrorRatePoint[]>;
}

export interface OrdersPort extends AdapterMode {
  attemptsSince(sinceMs: number): Promise<PaymentAttempt[]>;
  customer(ref: string): Promise<Customer | null>;
  /** Finds a customer by email (case-insensitive) or exact name, e.g. to match a Freshdesk requester. */
  findCustomer(query: { email?: string; name?: string }): Promise<Customer | null>;
  /** Leaves a note on the customer's account, for support to see if they get in touch. */
  addAccountNote(customerRef: string, text: string): Promise<{ id: string }>;
}

export interface TicketActionsPort extends AdapterMode {
  addNote(ticket: Ticket, text: string): Promise<void>;
  reply(ticket: Ticket, text: string): Promise<void>;
  /** The adapter that handles this ticket, when it depends on where the ticket came from. */
  adapterFor?(ticket: Ticket): string;
}

export interface NotifierPort extends AdapterMode {
  proactive(customer: Customer, text: string): Promise<void>;
}

export interface VoicePort extends AdapterMode {
  /** Returns an audio id when audio was produced, or null when voice is off. */
  synthesize(text: string): Promise<{ audioId: string | null }>;
}

export interface CreditsPort extends AdapterMode {
  issue(customerRefs: string[], amountInrTotal: number, reference: string): Promise<{ id: string }>;
}

/** The engineering incident record (Freshservice, or its sandbox) the operational side works from. */
export interface IncidentsPort extends AdapterMode {
  open(input: { incidentId: string; title: string; description: string; severity: "high" | "medium" }): Promise<{ id: string; url?: string }>;
  note(recordId: string, text: string): Promise<void>;
}

/**
 * Screens untrusted text (tickets, text inside tool outputs) for
 * instruction-like content before any language model could read it. The
 * built-in guard is rule-based; a model such as Lakera Guard can replace it.
 */
export interface PromptGuard extends AdapterMode {
  screen(text: string): Promise<GuardVerdict>;
}

/** A classifier's answer for one ticket: labels with probabilities, never an action. */
export type ClassifierVerdict = {
  source: string;
  model?: string;
  ticketType: { label: TicketType; confidence: number; probabilities: Partial<Record<TicketType, number>> };
  surface: { label: Surface; confidence: number; probabilities: Partial<Record<Surface, number>> };
  latencyMs: number;
};

/**
 * Bounded decisions about one ticket: failure, question or request, and its
 * product area. The built-in answer comes from the embedding prototypes; a
 * decision model such as Laya can be switched on. A classifier's output only
 * feeds the detection gates; it can't call a tool.
 */
export interface TicketClassifier extends AdapterMode {
  classify(text: string): Promise<ClassifierVerdict>;
}

export type ServiceInfo = { name: string; surfaces: string[] };

export interface ServiceCatalog {
  servicesFor(surface: string): ServiceInfo[];
}

export type Ports = {
  deployments: DeploymentsPort;
  payments: PaymentsPort;
  metrics: MetricsPort;
  orders: OrdersPort;
  ticketActions: TicketActionsPort;
  notifier: NotifierPort;
  voice: VoicePort;
  credits: CreditsPort;
  incidents: IncidentsPort;
  catalog: ServiceCatalog;
};
