import type { AlertInput } from "@crisiscrew/contracts";
import { freshworksRequest, type FreshworksAuth } from "./http";

/** An alert as Freshservice Alert Management returns it (GET /api/v2/ams/alerts). */
export type FreshserviceAlert = {
  id: number;
  subject?: string | null;
  metric_name?: string | null;
  metric_value?: string | null;
  node?: string | null;
  resource?: string | null;
  /** ok=51, warning=101, error=151, critical=201 */
  severity: number;
  /** open=1, resolved=2, reopen=3 */
  state: number;
  tags?: string[] | null;
  occurrence_time?: string | null;
  updated_at?: string | null;
  additional_info?: Record<string, string> | null;
};

/** Which service an alert belongs to: a substring of its resource, node, subject or tags, mapped to a service name. */
export type AlertServiceRule = { match: string; service: string };

/**
 * Reads alerts from Freshservice Alert Management: one alert by id (for the
 * webhook), or every alert updated since a time (for the poll), oldest first.
 */
export class FreshserviceAlertsClient {
  constructor(private readonly auth: FreshworksAuth) {}

  async alert(id: number): Promise<FreshserviceAlert> {
    const res = await freshworksRequest<{ alert: FreshserviceAlert }>(this.auth, "GET", `/api/v2/ams/alerts/${id}`);
    return res.alert;
  }

  async updatedSince(since: Date): Promise<FreshserviceAlert[]> {
    const at = since.toISOString().replace(/\.\d{3}Z$/, "Z");
    const query = encodeURIComponent(`updated_at:>'${at}'`);
    const res = await freshworksRequest<{ alerts?: FreshserviceAlert[] }>(this.auth, "GET", `/api/v2/ams/alerts?query=${query}&order_by=updated_at&order_type=asc&per_page=100`);
    return res?.alerts ?? [];
  }
}

/**
 * A Freshservice alert as CrisisCrew's alert, or null when it can't be used:
 * an "ok" alert, or one no rule ties to a service. Critical (201) stays
 * critical; error (151) and warning (101) are warnings, which never open an
 * incident on their own. A resolved alert carries when it was resolved.
 *
 * The service comes from a "service:<name>" tag when the alert has one,
 * otherwise from the first rule whose text appears in its resource, node,
 * subject or tags.
 */
export function freshserviceAlertToInput(alert: FreshserviceAlert, rules: readonly AlertServiceRule[]): (AlertInput & { resolvedAt?: number }) | null {
  if (alert.severity < 101 && alert.state !== 2) return null;
  const tags = alert.tags ?? [];
  const tagged = tags.find((t) => /^service:/i.test(t))?.slice("service:".length).trim();
  const haystack = [alert.resource, alert.node, alert.subject, ...tags].filter(Boolean).join(" ").toLowerCase();
  const service = tagged || alert.additional_info?.service || rules.find((r) => haystack.includes(r.match.toLowerCase()))?.service;
  if (!service) return null;
  const firedAt = Date.parse(alert.occurrence_time ?? alert.updated_at ?? "");
  if (Number.isNaN(firedAt)) return null;
  const metric = alert.metric_name || "alert";
  const resolved = alert.state === 2 ? Date.parse(alert.updated_at ?? "") : Number.NaN;
  const threshold = alert.additional_info?.Threshold ?? alert.additional_info?.threshold;
  return {
    source: "freshservice",
    externalId: String(alert.id),
    service,
    metric,
    ...(alert.metric_value ? { value: alert.metric_value } : {}),
    ...(threshold ? { threshold } : {}),
    severity: alert.severity >= 201 ? "critical" : "warning",
    label: (alert.subject || `${metric} ${alert.metric_value ?? ""}`.trim()).replace(/\s+/g, " ").slice(0, 200),
    firedAt,
    ...(Number.isNaN(resolved) ? {} : { resolvedAt: resolved }),
  };
}
