import type { Customer, PaymentMethod, Ticket } from "@crisiscrew/contracts";

/**
 * Ports: the only way core reaches the outside world. Sandbox adapters
 * implement every port; live adapters are listed in .env.example and not
 * wired yet.
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
}

export interface TicketActionsPort extends AdapterMode {
  addNote(ticket: Ticket, text: string): Promise<void>;
  reply(ticket: Ticket, text: string): Promise<void>;
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
  catalog: ServiceCatalog;
};
