import type { AlertView, Customer, PaymentMethod, Ticket } from "@crisiscrew/contracts";

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

/**
 * Freshservice Alert Management, and the monitoring tools behind it. The
 * investigator reads live alerts as operational evidence; the incident
 * commander pushes the incident back out so ITOps sees the customer harm.
 */
export interface AlertsPort extends AdapterMode {
  /** Alerts raised since `sinceMs`; open alerts only unless resolved ones are asked for too. */
  active(sinceMs: number, options?: { includeResolved?: boolean }): Promise<AlertView[]>;
  /**
   * Sends one alert to the monitoring tool's integration endpoint. Answers with
   * a reason instead of throwing when the push fails: a monitoring outage must
   * not take the incident response down with it.
   */
  push(alert: {
    hostname: string;
    resource: string;
    severity: "critical" | "warning" | "ok";
    message: string;
    description?: string;
    additional_info?: Record<string, string>;
  }): Promise<{ ok: boolean; reason?: string }>;
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

export type ServiceInfo = { name: string; surfaces: string[] };

export interface ServiceCatalog {
  servicesFor(surface: string): ServiceInfo[];
}

export type Ports = {
  deployments: DeploymentsPort;
  payments: PaymentsPort;
  metrics: MetricsPort;
  alerts: AlertsPort;
  orders: OrdersPort;
  ticketActions: TicketActionsPort;
  notifier: NotifierPort;
  voice: VoicePort;
  credits: CreditsPort;
  incidents: IncidentsPort;
  catalog: ServiceCatalog;
};
