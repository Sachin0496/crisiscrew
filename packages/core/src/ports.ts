import type { CallPurpose, CallView, Customer, ImportanceLevel, OnCallRole, PaymentMethod, Ticket } from "@crisiscrew/contracts";

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

export type CallRequest = {
  /** The number to call, in E.164 format (+919876543210). */
  to: string;
  /** What the call says once answered. */
  script: string;
  purpose: CallPurpose;
  /** Asks the callee to press a key after the script, e.g. "Press 1 to acknowledge". */
  gather?: { prompt: string; numDigits?: number };
  /** Ids that tie the call back to its incident, customer or action. */
  metadata?: Record<string, string>;
};

/** Outbound phone calls (Vobiz, or its sandbox): paging on-call, and calling affected customers. */
export interface TelephonyPort extends AdapterMode {
  /** Places a call and returns at once; its progress arrives through onUpdate. */
  call(request: CallRequest): Promise<{ callId: string }>;
  /** The call as last known, or null for an unknown id. */
  status(callId: string): Promise<CallView | null>;
  /** Called on every state change of every call; returns a function that unsubscribes. */
  onUpdate(listener: (call: CallView) => void): () => void;
}

/** Someone on call right now, with how to reach them. */
export type Responder = { name: string; role: OnCallRole; phone?: string; email?: string };

/** Who is on call for a service (Freshservice on-call schedules, or the scenario's roster). */
export interface OnCallPort extends AdapterMode {
  /** Everyone on call now for the service, primary first. */
  whoIsOnCall(service: string): Promise<Responder[]>;
}

export interface CreditsPort extends AdapterMode {
  issue(customerRefs: string[], amountInrTotal: number, reference: string): Promise<{ id: string }>;
}

/** The engineering incident record (Freshservice, or its sandbox) the operational side works from. */
export interface IncidentsPort extends AdapterMode {
  open(input: { incidentId: string; title: string; description: string; importance: ImportanceLevel }): Promise<{ id: string; url?: string }>;
  note(recordId: string, text: string): Promise<void>;
  /** Raises (or lowers) the record's priority when the incident's importance changes after it was filed. */
  setImportance(recordId: string, importance: ImportanceLevel): Promise<void>;
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
  telephony: TelephonyPort;
  oncall: OnCallPort;
  credits: CreditsPort;
  incidents: IncidentsPort;
  catalog: ServiceCatalog;
};
