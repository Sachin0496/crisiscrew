#!/usr/bin/env node
// Plays the monitoring tool: posts one alert to your Freshservice Alert
// Management webhook integration (Admin > IT Operations Management >
// Monitoring tools > Add > Webhook). CrisisCrew, with ALERTS=freshservice,
// reads it back from Alert Management; a critical alert on checkout-service
// opens an incident and pages on-call.
//
//   node scripts/fire-freshservice-alert.mjs [--severity critical|warning|resolved] [--service checkout-service] [--print-sample]
//
// Needs FRESHSERVICE_ALERT_WEBHOOK_URL and FRESHSERVICE_ALERT_WEBHOOK_KEY (the
// endpoint URL and authentication key the integration shows; the key is sent
// as "Authorization: auth-key <key>"). The UI's "Fire Freshservice alert"
// button does the same from the server. Run with
// --print-sample to get the payload to paste when you create the integration.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const severity = value("--severity", "critical");
const service = value("--service", "checkout-service");

const alert = {
  resource: service,
  node: `${service}-prod`,
  metric_name: "http_5xx_rate",
  metric_value: severity === "resolved" ? "0.4%" : "3.4%",
  severity,
  message: `${service} 5xx error rate ${severity === "resolved" ? "back to 0.4%" : "at 3.4%, above the 1% threshold"}`,
  description: `Payment API errors on ${service} jumped after the last release. Source: CrisisCrew demo monitor.`,
  timestamp: new Date().toISOString(),
  tags: [`service:${service}`],
};

if (args.includes("--print-sample")) {
  console.log(JSON.stringify(alert, null, 2));
  process.exit(0);
}

const url = process.env.FRESHSERVICE_ALERT_WEBHOOK_URL;
const key = process.env.FRESHSERVICE_ALERT_WEBHOOK_KEY;
if (!url || !key) {
  console.error("Set FRESHSERVICE_ALERT_WEBHOOK_URL and FRESHSERVICE_ALERT_WEBHOOK_KEY in .env (from the webhook integration's API contract).");
  process.exit(1);
}

const res = await fetch(url, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `auth-key ${key.replace(/^auth-key\s+/i, "")}` },
  body: JSON.stringify(alert),
  signal: AbortSignal.timeout(15_000),
});
const text = await res.text();
console.log(`${res.ok ? "Sent" : "Failed"}: ${res.status} ${text.slice(0, 300)}`);
console.log(`  ${alert.severity.toUpperCase()}  ${alert.message}`);
if (!res.ok) process.exit(1);
