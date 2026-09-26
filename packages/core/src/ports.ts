import type { CallPurpose, CallView, Customer, GuardVerdict, ImportanceLevel, OnCallRole, PaymentMethod, Surface, Ticket, TicketType } from "@crisiscrew/contracts";

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

export interface PromptGuard extends AdapterMode {
  screen(text: string): Promise<GuardVerdict>;
}

export type ClassifierVerdict = {
  source: string;
  model?: string;
  ticketType: { label: TicketType; confidence: number; probabilities: Partial<Record<TicketType, number>> };
  surface: { label: Surface; confidence: number; probabilities: Partial<Record<Surface, number>> };
  latencyMs: number;
};

export interface TicketClassifier extends AdapterMode {
  classify(text: string): Promise<ClassifierVerdict>;
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
  /** Records that the customer no longer wants this kind of contact. */
  withdrawConsent(customerRef: string, channel: "voice" | "proactive"): Promise<void>;
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
  /** Asks the callee to press a key after the script, e.g. "Press 1 to acknowledge"; replies are what the call says back for each key. */
  gather?: { prompt: string; numDigits?: number; replies?: Record<string, string> };
  /** Ids that tie the call back to its incident, customer or action. */
  metadata?: Record<string, string>;
  /**
   * Makes the call a conversation: after the script, the callee can speak
   * (speech to text on the telephony side) and CrisisCrew answers each turn
   * from what it knows at that moment. Pressing 1 still works.
   */
  dialog?: CallDialog;
};

/** One reply in a conversational call. acknowledge: the callee took the incident. end: say this, then hang up. */
export type DialogTurn = { say: string; acknowledge?: boolean; end?: boolean };
export type CallDialog = { respond(utterance: string): DialogTurn };

/** Outbound phone calls (Vobiz, or its sandbox): paging on-call, and calling affected customers. */
export interface TelephonyPort extends AdapterMode {
  /** Places a call and returns at once; its progress arrives through onUpdate. */
  call(request: CallRequest): Promise<{ callId: string }>;
  /** The call as last known, or null for an unknown id. */
  status(callId: string): Promise<CallView | null>;
  /** Called on every state change of every call; returns a function that unsubscribes. */
  onUpdate(listener: (call: CallView) => void): () => void;
}

/** What one infrastructure source (a Kubernetes or cloud MCP server, or the sandbox) said, or why it couldn't. */
export type InfraCheck = { source: string; kind: "pods" | "alarms" | "cpu"; checked: boolean; detail: string };

/**
 * A service's infrastructure right now: its pods, its cloud alarms, and its
 * CPU. A part that no source could check is left out, and its check says so.
 */
export type InfraHealth = {
  service: string;
  pods?: { ready: number; total: number; restarts: number; crashLooping: number };
  alarms?: { name: string; since?: number; metric?: string }[];
  cpuPercent?: number;
  checks: InfraCheck[];
};

export interface InfraHealthPort extends AdapterMode {
  health(service: string, sinceMs: number): Promise<InfraHealth>;
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
  /** Files the record. The service routes it to its group; tags mark it as CrisisCrew's. */
  open(input: { incidentId: string; title: string; description: string; importance: ImportanceLevel; service?: string; tags?: string[] }): Promise<{ id: string; url?: string }>;
  note(recordId: string, text: string): Promise<void>;
  /** Raises (or lowers) the record's priority when the incident's importance changes after it was filed. */
  setImportance(recordId: string, importance: ImportanceLevel): Promise<void>;
  /** Requests a rollback as a change record, linked to this record. It's a request for a human to plan and approve, never an action. */
  requestChange(recordId: string, input: { title: string; description: string; importance: ImportanceLevel; service?: string }): Promise<{ id: string; url?: string }>;
  /** Opens a problem record for the post-incident review, linked to this record. */
  openProblem(recordId: string, input: { title: string; description: string; importance: ImportanceLevel; service?: string }): Promise<{ id: string; url?: string }>;
}

export type ServiceInfo = { name: string; surfaces: string[] };

export interface ServiceCatalog {
  servicesFor(surface: string): ServiceInfo[];
}

/* ---------- The Fix Agent's tools: the code host, a workspace, a headless coding agent, documents and team knowledge ---------- */

/** A service's repository, as the code host (GitHub, or the mock) describes it. */
export type RepoInfo = {
  service: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  defaultBranch: string;
  architecture: "microservice" | "monolith";
  /** Logins that own the code (CODEOWNERS): they review every change. */
  owners: string[];
  testCommand: string;
};

export type CodeUser = { login: string; name: string; email?: string };

export interface CodeHostPort extends AdapterMode {
  repoFor(service: string): Promise<RepoInfo | null>;
  /** What changed between two refs (a release's tag and the one before it). */
  compare(repo: RepoInfo, base: string, head: string): Promise<{ files: { path: string; additions: number; deletions: number; patch: string }[] }>;
  userByEmail(email: string): Promise<CodeUser | null>;
  users(logins: string[]): Promise<CodeUser[]>;
  /** Opens a pull request and asks for reviews. Never merges. */
  openPullRequest(repo: RepoInfo, input: { branch: string; title: string; body: string; reviewers: string[]; assignees: string[] }): Promise<{ number: number; url: string }>;
}

export type TestRun = { command: string; passed: number; failed: number; ok: boolean; output: string; durationMs: number };

/** A scratch checkout where the coding agent works. */
export interface WorkspacePort extends AdapterMode {
  /** Clones the repository into a fresh directory, on a new branch. */
  checkout(repo: RepoInfo, branch: string): Promise<{ dir: string }>;
  /** Runs the repository's tests. */
  test(dir: string, command: string): Promise<TestRun>;
  /** Everything changed in the workspace, as a unified diff (new files included). */
  diff(dir: string): Promise<string>;
  /** Commits everything on the branch and pushes it. */
  commitAndPush(dir: string, branch: string, message: string): Promise<{ sha: string; files: { path: string; additions: number; deletions: number }[]; patch: string }>;
}

export type CodingEvent =
  | { type: "text"; text: string; diagnosis?: boolean }
  | { type: "tool"; tool: string; title: string; detail?: string; ok?: boolean }
  | { type: "tests"; phase: "before" | "after"; run: TestRun }
  | { type: "done"; summary: string; title: string }
  | { type: "failed"; reason: string };

/** A headless coding agent (OpenCode, Claude Code, Codex) working in a workspace. */
export interface CodingAgentPort extends AdapterMode {
  readonly tool: string;
  readonly model: string;
  /** Starts a session and returns at once; its events arrive through onEvent. */
  start(input: { dir: string; prompt: string; testCommand: string }): Promise<{ sessionId: string }>;
  onEvent(listener: (sessionId: string, event: CodingEvent) => void): () => void;
}

export type DocBlock = { kind: "heading" | "subheading" | "paragraph"; text: string } | { kind: "bullets"; items: string[] } | { kind: "link"; text: string; url: string };

/** Shared documents (Google Docs, or the mock). */
export interface DocsPort extends AdapterMode {
  /** Creates the document and shares it; each person gets the provider's email notification. */
  publish(input: { title: string; blocks: DocBlock[]; shareWith: { email: string; role: "writer" | "commenter" }[]; message: string }): Promise<{ id: string; url: string }>;
}

export type KnowledgeHit = { source: "slack" | "runbook"; title: string; snippet: string; url?: string };

/** What the team already knows: chat threads and runbooks (Slack and Google Drive, or the mock). */
export interface KnowledgePort extends AdapterMode {
  search(query: string): Promise<KnowledgeHit[]>;
}

export type FixPorts = { codeHost: CodeHostPort; workspace: WorkspacePort; coding: CodingAgentPort; docs: DocsPort; knowledge: KnowledgePort };

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
  infra: InfraHealthPort;
  credits: CreditsPort;
  incidents: IncidentsPort;
  catalog: ServiceCatalog;
  /** The Fix Agent's tools; without them it never starts. */
  fix?: FixPorts;
};
