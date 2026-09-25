import type { AlertSeverity } from "./alerts";

/**
 * The alert object Freshservice Alert Management accepts, and the two
 * CrisisCrew-specific builders for it.
 *
 * This lives in contracts rather than in the Freshservice adapter because the
 * Incident Commander (in core) composes the alert and the adapter only
 * delivers it: core must not depend on any adapter.
 */

export type AlertNotification = {
  /** The host or instance the alert is about. */
  hostname: string;
  /** The monitored thing; Freshservice groups alerts by this. */
  resource: string;
  severity: AlertSeverity;
  message: string;
  description?: string;
  additional_info?: Record<string, string>;
};

/**
 * CrisisCrew incident -> Freshservice alert. The resource is the service that
 * broke, so repeated incidents on one service group into one alert instead of
 * filling the queue; the customer impact rides along in additional_info, so an
 * ITOps engineer sees who was harmed without opening the support tool.
 */
export function incidentAlert(input: {
  service: string;
  hostname?: string;
  title: string;
  summary: string;
  severity: "high" | "medium";
  incidentId: string;
  affected: number;
  silent: number;
  recovered: number;
  confirmed: number;
  status: string;
}): AlertNotification {
  return {
    hostname: input.hostname ?? input.service,
    resource: input.service,
    severity: input.severity === "high" ? "critical" : "warning",
    message: input.title,
    description: input.summary,
    additional_info: {
      crisiscrew_incident: input.incidentId,
      affected_customers: String(input.affected),
      silent_customers: String(input.silent),
      recovery_coverage: `${input.recovered}/${input.confirmed}`,
      crisiscrew_status: input.status,
    },
  };
}

/** The alert that closes a service's alert once every affected customer has recovered. */
export function recoveryAlert(input: { service: string; hostname?: string; incidentId: string; summary: string; confirmed: number }): AlertNotification {
  return {
    hostname: input.hostname ?? input.service,
    resource: input.service,
    severity: "ok",
    message: `Recovered: ${input.incidentId}`,
    description: input.summary,
    additional_info: {
      crisiscrew_incident: input.incidentId,
      affected_customers: String(input.confirmed),
      recovery_coverage: `${input.confirmed}/${input.confirmed}`,
      crisiscrew_status: "recovered",
    },
  };
}
