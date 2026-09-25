import { describe, expect, it, vi } from "vitest";
import { alertMentionsService, alertTimestamp, incidentAlert, normalizeSeverity, recoveryAlert, toAlertView } from "@crisiscrew/contracts";
import { createLiveAlerts } from "./alerts-live";
import { FreshserviceAlertsClient, integrationIdOf, redactEndpoint } from "./freshservice-alerts";

const ENDPOINT =
  "https://crisiscrew.alerts.freshservice.com/integrations/1000046806/alerts?auth-key=eyJhbGciOiJIUzI1NiJ9.payload.signature";

const jsonResponse = (status: number, body = ""): Response => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("the Freshservice Alert Management payload", () => {
  it("reads the documented flat alert object", () => {
    const alert = toAlertView(
      {
        hostname: "checkout-service-1",
        resource: "checkout-service",
        severity: "critical",
        message: "Error rate above 3%",
        description: "checkout-service 5xx rate 3.34% for 5 minutes",
        additional_info: { version: "4.21.7", author: "vikram-s" },
      },
      { id: "A1", source: "freshservice-ams", receivedAt: 1_000 },
    );
    expect(alert).toMatchObject({
      severity: "critical",
      resource: "checkout-service",
      hostname: "checkout-service-1",
      message: "Error rate above 3%",
      description: "checkout-service 5xx rate 3.34% for 5 minutes",
    });
    // additional_info is flattened into attributes for the evidence trail.
    expect(alert.attributes).toMatchObject({ version: "4.21.7", author: "vikram-s" });
  });

  it("understands the field names other monitoring tools use", () => {
    const grafana = toAlertView(
      { title: "High error rate", state: "alerting", service: "checkout-service", metric_name: "http_5xx", instance: "10.0.0.4" },
      { id: "A2", source: "webhook", receivedAt: 5_000 },
    );
    expect(grafana).toMatchObject({ severity: "critical", resource: "checkout-service", hostname: "10.0.0.4", message: "High error rate", metric: "http_5xx" });

    const cloudwatch = toAlertView({ alert: { message: "CPU high", severity: "Warning" }, host: "i-abc" }, { id: "A3", source: "webhook", receivedAt: 1 });
    expect(cloudwatch).toMatchObject({ severity: "warning", message: "CPU high", hostname: "i-abc", resource: "i-abc" });
  });

  it("maps every severity spelling onto the three Freshservice understands", () => {
    expect(normalizeSeverity("CRITICAL")).toBe("critical");
    expect(normalizeSeverity("P1")).toBe("critical");
    expect(normalizeSeverity("error")).toBe("critical");
    expect(normalizeSeverity("warn")).toBe("warning");
    expect(normalizeSeverity("degraded")).toBe("warning");
    expect(normalizeSeverity("recovery")).toBe("ok");
    expect(normalizeSeverity("RESOLVED")).toBe("ok");
    expect(normalizeSeverity("ok")).toBe("ok");
    // Anything unrecognized is treated as a warning rather than dropped.
    expect(normalizeSeverity("banana")).toBe("warning");
    expect(normalizeSeverity(undefined)).toBe("warning");
  });

  it("reads epoch seconds, epoch milliseconds and ISO timestamps", () => {
    expect(alertTimestamp(1_790_325_922, 0)).toBe(1_790_325_922_000);
    expect(alertTimestamp(1_790_325_922_126, 0)).toBe(1_790_325_922_126);
    expect(alertTimestamp("2026-09-25T08:45:22.126Z", 0)).toBe(Date.parse("2026-09-25T08:45:22.126Z"));
    expect(alertTimestamp("1790325922", 0)).toBe(1_790_325_922_000);
    // An unusable timestamp falls back to when we received it, so the alert still counts.
    expect(alertTimestamp("not a date", 4_242)).toBe(4_242);
    expect(alertTimestamp(undefined, 4_242)).toBe(4_242);
  });

  it("matches an alert against a service by any of its fields", () => {
    const alert = toAlertView({ resource: "checkout-service", message: "5xx spike" }, { id: "A4", source: "webhook", receivedAt: 0 });
    expect(alertMentionsService(alert, "checkout-service")).toBe(true);
    expect(alertMentionsService(alert, "auth-service")).toBe(false);
  });
});

describe("the incident alert CrisisCrew raises", () => {
  it("carries the customer harm alongside the engineering signal", () => {
    const alert = incidentAlert({
      service: "checkout-service",
      title: "Checkout and payment failures",
      summary: "23 customers affected, 15 never wrote in",
      severity: "high",
      incidentId: "INC-2026-001",
      affected: 23,
      silent: 15,
      recovered: 21,
      confirmed: 23,
      status: "recovering",
    });
    expect(alert).toMatchObject({ resource: "checkout-service", hostname: "checkout-service", severity: "critical", message: "Checkout and payment failures" });
    expect(alert.additional_info).toMatchObject({
      crisiscrew_incident: "INC-2026-001",
      affected_customers: "23",
      silent_customers: "15",
      recovery_coverage: "21/23",
    });
  });

  it("uses warning for a medium incident and ok to resolve", () => {
    const medium = incidentAlert({ service: "auth-service", title: "t", summary: "s", severity: "medium", incidentId: "I", affected: 0, silent: 0, recovered: 0, confirmed: 0, status: "detected" });
    expect(medium.severity).toBe("warning");
    const resolved = recoveryAlert({ service: "auth-service", incidentId: "I", summary: "all recovered", confirmed: 4 });
    expect(resolved.severity).toBe("ok");
    expect(resolved.resource).toBe("auth-service");
  });
});

describe("the Freshservice alerts client", () => {
  it("posts the alert as JSON and reports success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, "{}"));
    const client = new FreshserviceAlertsClient({ endpoint: ENDPOINT, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.push({ hostname: "h", resource: "checkout-service", severity: "critical", message: "m" });
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({ resource: "checkout-service", severity: "critical" });
  });

  it("answers with a reason instead of throwing when the endpoint refuses", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, JSON.stringify({ code: "not_authorized", message: "You are not authorized to access AMS" })));
    const client = new FreshserviceAlertsClient({ endpoint: ENDPOINT, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.push({ hostname: "h", resource: "r", severity: "warning", message: "m" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.reason).toContain("not authorized");
      // The auth key is never repeated into a log or an audit entry.
      expect(result.reason).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    }
  });

  it("survives a transport failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    });
    const client = new FreshserviceAlertsClient({ endpoint: ENDPOINT, fetch: fetchMock as unknown as typeof fetch });
    const result = await client.push({ hostname: "h", resource: "r", severity: "warning", message: "m" });
    expect(result).toEqual(expect.objectContaining({ ok: false, status: 0 }));
  });

  it("reads the integration id and masks the auth key", () => {
    expect(integrationIdOf(ENDPOINT)).toBe("1000046806");
    expect(integrationIdOf("https://example.com/other")).toBeNull();
    expect(redactEndpoint(ENDPOINT)).toContain("auth-key=***");
    expect(redactEndpoint(ENDPOINT)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("the live alerts port", () => {
  it("holds alerts that arrive and closes them when a recovery notification lands", async () => {
    const live = createLiveAlerts({ endpoint: ENDPOINT, fetch: (async () => jsonResponse(200)) as unknown as typeof fetch });
    live.ingest({ resource: "checkout-service", severity: "critical", message: "5xx spike" }, 1_000);
    live.ingest({ resource: "auth-service", severity: "critical", message: "otp failures" }, 1_000);
    expect(await live.active(0)).toHaveLength(2);
    expect(await live.active(0, { includeResolved: true })).toHaveLength(2);

    // "ok" closes the matching alert rather than adding another one.
    live.ingest({ resource: "checkout-service", severity: "ok", message: "recovered" }, 2_000);
    const open = await live.active(0);
    expect(open.map((a) => a.resource)).toEqual(["auth-service"]);
    expect((await live.active(0, { includeResolved: true })).find((a) => a.resource === "checkout-service")?.severity).toBe("ok");
  });

  it("filters by time and records what was pushed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));
    const live = createLiveAlerts({ endpoint: ENDPOINT, fetch: fetchMock as unknown as typeof fetch });
    live.ingest({ resource: "checkout-service", severity: "critical", message: "old", timestamp: 1_000 }, 1_000);
    live.ingest({ resource: "checkout-service", severity: "critical", message: "new", timestamp: 9_000 }, 9_000);
    expect((await live.active(5_000)).map((a) => a.message)).toEqual(["new"]);

    const pushed = await live.push({ hostname: "h", resource: "checkout-service", severity: "critical", message: "raised", additional_info: { crisiscrew_incident: "INC-2026-001" } });
    expect(pushed.ok).toBe(true);
    expect(live.pushed()[0]).toMatchObject({ resource: "checkout-service", incidentId: "INC-2026-001", ok: true });
  });

  it("records a failed push without throwing", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, "not_authorized"));
    const live = createLiveAlerts({ endpoint: ENDPOINT, fetch: fetchMock as unknown as typeof fetch });
    const result = await live.push({ hostname: "h", resource: "r", severity: "ok", message: "m" });
    expect(result.ok).toBe(false);
    expect(live.pushed()[0]).toMatchObject({ ok: false });
  });
});
