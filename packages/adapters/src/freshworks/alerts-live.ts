import { toAlertView, type AlertPayload, type AlertView } from "@crisiscrew/contracts";
import type { AlertsPort } from "@crisiscrew/core";
import { FreshserviceAlertsClient, type AlertNotification } from "./freshservice-alerts";

/**
 * The two directions between CrisisCrew and Freshservice Alert Management.
 *
 * Out: every incident CrisisCrew opens is pushed to the integration endpoint,
 * and its alert is resolved when every affected customer has been recovered.
 *
 * In: alerts that arrive on CrisisCrew's own webhook are held here, so the
 * investigator reads the same alert feed an ITOps engineer sees. Alerts pushed
 * by CrisisCrew itself are not fed back, or an incident would verify itself.
 */

export type LiveAlertsOptions = {
  /** The AMS integration endpoint, with its auth-key. */
  endpoint: string;
  /** How long an alert stays in the active feed. */
  retentionMs?: number;
  fetch?: typeof fetch;
};

/** Where a pushed alert went, for the audit trail and the events feed. */
export type AlertPushRecord = { at: number; resource: string; severity: string; message: string; incidentId?: string; ok: boolean; reason?: string };

export type LiveAlerts = AlertsPort & {
  /** Records an alert that arrived on the inbound webhook. */
  ingest(payload: AlertPayload, receivedAt: number): AlertView;
  /** Pushed alerts, newest first. */
  pushed(): AlertPushRecord[];
  /** Remembers which resource an incident was pushed as, so its alert can be resolved later. */
  remember(incidentId: string, resource: string): void;
  /** The resource an incident's alert was raised on, if it was pushed. */
  resourceFor(incidentId: string): string | null;
  /** Alerts received on the inbound webhook, newest first. */
  received(): AlertView[];
};

const DEFAULT_RETENTION_MS = 6 * 60 * 60_000;

export function createLiveAlerts(options: LiveAlertsOptions): LiveAlerts {
  const client = new FreshserviceAlertsClient({ endpoint: options.endpoint, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS;
  const inbound: AlertView[] = [];
  const outbound: AlertPushRecord[] = [];
  const resources = new Map<string, string>();
  let received = 0;

  /**
   * Drops alerts older than the retention window by when we received them, not
   * by the clock the monitoring tool reported: a tool with clock skew would
   * otherwise have its alerts thrown away the moment they arrived.
   */
  const prune = (now: number) => {
    for (let i = inbound.length - 1; i >= 0; i -= 1) {
      if (inbound[i]!.receivedAt < now - retentionMs) inbound.splice(i, 1);
    }
  };

  return {
    mode: "live",
    adapter: "freshservice-ams",

    async active(sinceMs, opts) {
      // Retention is applied when an alert arrives; a read must not consult a
      // second clock, or an alert read on the engine's clock is judged against
      // the wall clock and disappears.
      return inbound.filter((a) => a.at >= sinceMs && (opts?.includeResolved || a.severity !== "ok"));
    },

    async push(alert: AlertNotification) {
      const result = await client.push(alert);
      outbound.unshift({
        at: Date.now(),
        resource: alert.resource,
        severity: alert.severity,
        message: alert.message,
        ...(alert.additional_info?.crisiscrew_incident ? { incidentId: alert.additional_info.crisiscrew_incident } : {}),
        ok: result.ok,
        ...(result.ok ? {} : { reason: result.reason }),
      });
      if (outbound.length > 200) outbound.length = 200;
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },

    ingest(payload, receivedAt) {
      const view = toAlertView(payload, { id: `AMS-IN-${++received}`, source: "freshservice-ams", receivedAt });
      // A resolved notification closes the matching open alerts instead of piling up.
      if (view.severity === "ok") {
        for (const existing of inbound) {
          if (existing.resource === view.resource && existing.severity !== "ok") existing.severity = "ok";
        }
      }
      inbound.push(view);
      // Newest first, by when the monitoring tool says it fired.
      inbound.sort((a, b) => b.at - a.at);
      prune(receivedAt);
      return view;
    },

    pushed: () => [...outbound],
    received: () => [...inbound],
    remember: (incidentId, resource) => void resources.set(incidentId, resource),
    resourceFor: (incidentId) => resources.get(incidentId) ?? null,
  };
}
