import type { AlertNotification } from "@crisiscrew/contracts";

export type { AlertNotification };

/**
 * Freshservice Alert Management (AMS) webhook.
 *
 * Every Freshservice account that has Alert Management exposes one endpoint
 * per monitoring-tool integration:
 *
 *   POST https://<account>.alerts.freshservice.com/integrations/<id>/alerts?auth-key=<key>
 *
 * The body is the flat alert object Freshservice documents (hostname,
 * resource, severity, message, description, additional_info). Freshservice
 * groups notifications that share a resource (and metric) into a single alert,
 * so pushing the same resource repeatedly keeps one alert open rather than
 * filling the queue. Sending `severity: "ok"` resolves it.
 *
 * Auth is the `auth-key` query parameter: the endpoint answers 401
 * {"code":"not_authorized","message":"You are not authorized to access AMS"}
 * when it is missing or stale. There is no API key and no rate limit beyond
 * Freshservice's own (x-ratelimit-* response headers).
 */

export type FreshserviceAlertsOptions = {
  /** Full endpoint URL from Admin > IT Operations Management > Monitoring tools, including ?auth-key=... */
  endpoint: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class FreshserviceAlertsError extends Error {
  override name = "FreshserviceAlertsError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AlertPushResult = { ok: true; status: number } | { ok: false; status: number; reason: string };

/** The endpoint with its credentials stripped, for logs and the wiring report. */
export function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.searchParams.has("auth-key")) url.searchParams.set("auth-key", "***");
    return url.toString();
  } catch {
    return endpoint.replace(/(auth-key=)[^&]+/i, "$1***");
  }
}

/** The integration id inside an AMS endpoint, e.g. 1000046806. */
export function integrationIdOf(endpoint: string): string | null {
  const match = /\/integrations\/(\d+)/.exec(endpoint);
  return match ? match[1]! : null;
}

/**
 * Pushes alerts to Freshservice Alert Management. Never throws for a transport
 * or HTTP failure: the caller gets a result it can record, because a monitoring
 * push that fails must not take an incident response down with it.
 */
export class FreshserviceAlertsClient {
  constructor(private readonly options: FreshserviceAlertsOptions) {}

  get endpoint(): string {
    return this.options.endpoint;
  }

  get redacted(): string {
    return redactEndpoint(this.options.endpoint);
  }

  async push(alert: AlertNotification): Promise<AlertPushResult> {
    const doFetch = this.options.fetch ?? fetch;
    let res: Response;
    try {
      res = await doFetch(this.options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(alert),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 4_000),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, status: 0, reason: `${redactEndpoint(this.options.endpoint)} did not answer: ${reason}` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, reason: `${redactEndpoint(this.options.endpoint)} failed with ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}` };
    }
    return { ok: true, status: res.status };
  }
}

// incidentAlert and recoveryAlert live in @crisiscrew/contracts, so core can
// compose an alert without depending on this adapter.
