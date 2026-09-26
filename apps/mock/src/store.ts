import { MOCK } from "@crisiscrew/contracts";

export type Product = "freshdesk" | "freshservice" | "vobiz" | "github" | "google" | "slack" | "mock";

export type Contact = { id: number; name: string; email: string; phone: string | null; mobile: string | null };

export type Conversation = {
  id: number;
  body: string;
  body_text: string;
  private: boolean;
  incoming: boolean;
  /** note or reply, as the agent sees it. */
  kind: "note" | "reply";
  created_at: string;
};

export type DeskTicket = {
  id: number;
  subject: string;
  description: string;
  description_text: string;
  source: number;
  status: number;
  priority: number;
  requester_id: number;
  created_at: string;
  updated_at: string;
  conversations: Conversation[];
};

export type ServiceTicket = {
  id: number;
  subject: string;
  description: string;
  description_text: string;
  priority: number;
  urgency: number;
  impact: number;
  status: number;
  group_id: number | null;
  tags: string[];
  requester_email: string;
  created_at: string;
  updated_at: string;
  change_id: number | null;
  problem_id: number | null;
  notes: Conversation[];
  acknowledged: { by: string; at: string } | null;
};

export type ServiceRecord = {
  id: number;
  kind: "change" | "problem";
  subject: string;
  description: string;
  description_text: string;
  priority: number;
  impact: number;
  status: number;
  created_at: string;
  /** The incident this record was raised from, once CrisisCrew links it. */
  ticket_id: number | null;
};

export type Alert = {
  id: number;
  subject: string;
  metric_name: string;
  metric_value: string | null;
  resource: string;
  node: string | null;
  severity: number;
  state: number;
  tags: string[];
  occurrence_time: string;
  updated_at: string;
  additional_info: Record<string, string>;
};

export type CallState = "queued" | "ringing" | "answered" | "completed" | "no_answer" | "busy" | "failed";

export type Call = {
  uuid: string;
  requestUuid: string;
  from: string;
  to: string;
  state: CallState;
  answerUrl: string;
  ringUrl: string | null;
  hangupUrl: string | null;
  ringTimeoutSec: number;
  /** The conversation, in order: what CrisisCrew said, and what the person said or pressed. */
  lines: { who: "agent" | "callee"; text: string; at: string }[];
  /** The open question: where the next key press or answer goes. speech: the person can answer in words. */
  gather: { action: string; prompt: string; speech: boolean } | null;
  digits: string | null;
  cause: string | null;
  created_at: string;
  answer_time: string | null;
  end_time: string | null;
  /** manual: waiting for someone to click; autopilot: following the scenario. */
  driver: "autopilot" | "manual";
};

/** Something that lands on someone's phone: a Google Docs share, a GitHub assignment or review request. */
export type Notification = { id: number; at: string; to: string; app: "Google Docs" | "GitHub" | "CrisisCrew"; title: string; body: string; url: string };

export type LogEntry = { id: number; at: string; product: Product; direction: "in" | "out"; text: string; ok: boolean };

export type Webhooks = {
  /** CrisisCrew's origin, e.g. http://localhost:8787 */
  url: string;
  fetch: typeof fetch;
};

export const iso = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const textToHtml = (text: string) => text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!).split(/\r?\n/).join("<br>");
export const htmlToText = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();

/** Everything the mock services hold, in memory, shared by the three APIs and the UI. */
export class Store {
  contacts: Contact[] = [];
  deskTickets: DeskTicket[] = [];
  serviceTickets: ServiceTicket[] = [];
  records: ServiceRecord[] = [];
  alerts: Alert[] = [];
  calls: Call[] = [];
  log: LogEntry[] = [];
  notifications: Notification[] = [];
  autopilot = true;
  /** Bumped on every change, so the UI knows when to redraw. */
  version = 0;
  private ids = { contact: 7000, desk: 1000, service: 300, conversation: 50_000, record: 20, alert: 9100, log: 0, notification: 0 };

  constructor(private readonly webhooks: Webhooks) {}

  touch(): void {
    this.version += 1;
  }

  next(kind: keyof Store["ids"]): number {
    this.ids[kind] += 1;
    return this.ids[kind];
  }

  record(product: Product, direction: "in" | "out", text: string, ok = true): void {
    this.log.push({ id: this.next("log"), at: iso(), product, direction, text, ok });
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.touch();
  }

  notify(input: Omit<Notification, "id" | "at">): void {
    this.notifications.push({ ...input, id: this.next("notification"), at: iso() });
    this.touch();
  }

  contactFor(email: string, name?: string, phone?: string): Contact {
    const known = this.contacts.find((c) => c.email.toLowerCase() === email.toLowerCase());
    if (known) return known;
    const contact: Contact = { id: this.next("contact"), name: name || email.split("@")[0]!, email, phone: null, mobile: phone ?? null };
    this.contacts.push(contact);
    return contact;
  }

  conversation(body: string, kind: "note" | "reply", incoming = false): Conversation {
    return { id: this.next("conversation"), body, body_text: htmlToText(body), private: kind === "note", incoming, kind, created_at: iso() };
  }

  /** Tells CrisisCrew, the way a Freshdesk automation rule or Freshservice workflow would. Never throws: a failure is logged. */
  async webhook(product: Product, path: string, payload: unknown): Promise<boolean> {
    const url = `${this.webhooks.url}${path}`;
    try {
      const res = await this.webhooks.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-crisiscrew-secret": MOCK.webhookSecret },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(4_000),
      });
      const ok = res.ok;
      this.record(product, "out", `webhook POST ${path} → ${res.status}${ok ? "" : `: ${(await res.text().catch(() => "")).slice(0, 160)}`}`, ok);
      return ok;
    } catch (error) {
      this.record(product, "out", `webhook POST ${path} failed: ${error instanceof Error ? error.message : String(error)}. Is CrisisCrew running with INTEGRATIONS=mock at ${this.webhooks.url}?`, false);
      return false;
    }
  }

  reset(): void {
    this.contacts = [];
    this.deskTickets = [];
    this.serviceTickets = [];
    this.records = [];
    this.alerts = [];
    this.calls = [];
    this.log = [];
    this.notifications = [];
    this.touch();
  }
}
