import { z } from "zod";

/**
 * Freshservice Alert Management (AMS): the alerts an ITOps monitoring tool
 * raises, and the alerts CrisisCrew raises back to ITOps.
 *
 * A monitoring tool posts a flat JSON object to its integration's endpoint:
 *
 *   POST https://<account>.alerts.freshservice.com/integrations/<id>/alerts?auth-key=<key>
 *   { "hostname", "resource", "severity", "message", "description", "additional_info" }
 *
 * Freshservice groups notifications with the same resource and metric into one
 * alert, and resolves an alert automatically when its severity becomes "ok".
 * The same shape is what this server accepts on its own inbound webhook, so a
 * Grafana/CloudWatch/Datadog webhook can point straight at CrisisCrew.
 */

/** The severities Freshservice Alert Management understands. */
export const AlertSeverity = z.enum(["critical", "warning", "ok"]);
export type AlertSeverity = z.infer<typeof AlertSeverity>;

/** Every spelling monitoring tools use for the three severities, mapped to ours. */
const SEVERITY_ALIASES: Record<string, AlertSeverity> = {
  critical: "critical",
  crit: "critical",
  severe: "critical",
  disaster: "critical",
  emerg: "critical",
  emergency: "critical",
  alert: "critical",
  alerting: "critical",
  error: "critical",
  err: "critical",
  high: "critical",
  fatal: "critical",
  page: "critical",
  p1: "critical",
  warning: "warning",
  warn: "warning",
  minor: "warning",
  degraded: "warning",
  medium: "warning",
  notice: "warning",
  p2: "warning",
  p3: "warning",
  ok: "ok",
  up: "ok",
  recovery: "ok",
  recovered: "ok",
  resolved: "ok",
  resolve: "ok",
  clear: "ok",
  cleared: "ok",
  normal: "ok",
  info: "ok",
  informational: "ok",
  low: "ok",
};

/** Accepts any of the spellings monitoring tools use, and answers with ours. */
export function normalizeSeverity(value: string | null | undefined): AlertSeverity {
  const key = (value ?? "").trim().toLowerCase();
  return SEVERITY_ALIASES[key] ?? "warning";
}

/** True when a severity means the alert is over. */
export const isResolved = (severity: AlertSeverity): boolean => severity === "ok";

/**
 * One alert, normalized. `at` is when the alert was raised (a monitoring tool
 * may send its own timestamp; otherwise it is when we received it).
 */
export type AlertView = {
  id: string;
  /** The integration it arrived through, e.g. "freshservice-ams" or the inbound webhook. */
  source: string;
  /** When CrisisCrew received it. Retention follows this, not the tool's own clock. */
  receivedAt: number;
  severity: AlertSeverity;
  /** The monitored thing, e.g. "checkout-service". The key Freshservice groups by. */
  resource: string;
  /** The host or instance the alert is about. */
  hostname: string;
  /** The metric or check that fired, when the tool sends one. */
  metric: string;
  /** One line, as the tool wrote it. */
  message: string;
  description: string;
  at: number;
  /** Everything else the tool sent, kept for the evidence trail. */
  attributes: Record<string, string>;
};

/**
 * The payload a monitoring tool posts. Only `severity` and `message` are
 * required by Freshservice; `hostname` and `resource` decide how alerts are
 * grouped, so they are strongly recommended. Unknown keys are kept verbatim
 * under `additional_info` and as top-level attributes.
 */
export const AlertPayload = z
  .object({
    hostname: z.string().max(300).optional(),
    resource: z.string().max(300).optional(),
    /** Some tools nest these under "alert" or "event"; accepted below. */
    severity: z.string().max(60).optional(),
    message: z.string().max(2000).optional(),
    description: z.string().max(4000).optional(),
    /** Also common: "metric", "metric_name", "check", "name", "title". */
    metric: z.string().max(300).optional(),
    /** Seconds or milliseconds since the epoch, or an ISO 8601 string. */
    timestamp: z.union([z.number(), z.string()]).optional(),
    additional_info: z.record(z.string(), z.unknown()).optional(),
    alert: z.record(z.string(), z.unknown()).optional(),
    event: z.record(z.string(), z.unknown()).optional(),
  })
  .catchall(z.unknown());
export type AlertPayload = z.infer<typeof AlertPayload>;

const pickString = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
};

/** Reads the first non-empty string among the given keys of a record. */
function field(records: Record<string, unknown>[], keys: string[]): string {
  for (const record of records) {
    for (const key of keys) {
      const value = pickString(record[key]);
      if (value) return value;
    }
  }
  return "";
}

/**
 * The window an epoch-**seconds** timestamp falls in: 1973 to 5138. A number
 * inside it is seconds and is multiplied up; anything else is already
 * milliseconds. Deciding by magnitude rather than by one cutoff means a small
 * number (a relative counter, a duration) is never read as 1970, and a real
 * millisecond timestamp is never multiplied into the year 50000.
 */
const EPOCH_SECONDS_MIN = 1e8;
const EPOCH_SECONDS_MAX = 1e11;

/**
 * A monitoring tool's timestamp: epoch seconds, epoch milliseconds or ISO 8601.
 * Falls back to `receivedAt` when it is missing or unparseable, so an alert is
 * never dropped over a clock format.
 */
export function alertTimestamp(value: unknown, receivedAt: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value >= EPOCH_SECONDS_MIN && value < EPOCH_SECONDS_MAX ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return alertTimestamp(asNumber, receivedAt);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return receivedAt;
}

const NESTED = ["additional_info", "alert", "event"] as const;

/**
 * Any monitoring tool's alert payload as one normalized alert. Payloads differ
 * between tools (Datadog, Grafana, CloudWatch and Catchpoint all name their
 * fields differently), so the well-known names are tried in order, and every
 * remaining scalar is kept as an attribute.
 */
export function toAlertView(payload: AlertPayload, options: { id: string; source: string; receivedAt: number }): AlertView {
  const nested = NESTED.map((key) => payload[key]).filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null);
  const records: Record<string, unknown>[] = [payload as Record<string, unknown>, ...nested];

  const message = field(records, ["message", "title", "subject", "summary", "text", "name"]);
  const rawSeverity = field(records, ["severity", "level", "status", "state", "priority", "alert_type"]);
  const resource = field(records, ["resource", "service", "metric_name", "metric", "check", "monitor", "integration_name"]);
  const hostname = field(records, ["hostname", "host", "instance", "node", "device", "server"]);
  const description = field(records, ["description", "details", "body", "reason"]);

  const attributes: Record<string, string> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (NESTED.includes(key as (typeof NESTED)[number])) continue;
      if (typeof value === "object" && value !== null) continue;
      const text = pickString(value);
      if (text && attributes[key] === undefined) attributes[key] = text;
    }
  }

  return {
    id: options.id,
    source: options.source,
    receivedAt: options.receivedAt,
    severity: normalizeSeverity(rawSeverity),
    resource: resource || hostname || "unknown",
    hostname: hostname || resource || "unknown",
    metric: field(records, ["metric", "metric_name", "check", "monitor"]) || message.slice(0, 120),
    message: message || description.slice(0, 200) || "alert with no message",
    description: description || message,
    at: alertTimestamp(field(records, ["timestamp", "created_at", "date", "time", "started_at"]) || payload.timestamp, options.receivedAt),
    attributes,
  };
}

/** True when an alert is about a service CrisisCrew tracks. */
export function alertMentionsService(alert: AlertView, service: string): boolean {
  const needle = service.toLowerCase();
  return [alert.resource, alert.hostname, alert.metric, alert.message, alert.description].some((field) => field.toLowerCase().includes(needle));
}
