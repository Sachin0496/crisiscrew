#!/usr/bin/env node
// Files a scenario's customer tickets in your real Freshdesk, paced like the
// scenario (compressed by --speed), so a CrisisCrew running with
// INTEGRATIONS=real ingests them the way it would real complaints.
//
//   node scripts/freshdesk-seed.mjs [scenario] [--speed 3] [--only-complaints] [--dry-run]
//
// Requesters use the scenario customers' emails (…@example.com, a reserved
// domain, so Freshdesk's notification emails go nowhere), which is how
// CrisisCrew matches each ticket to that customer's payments.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const scenarioId = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--speed") ?? process.env.LIVE_WORLD ?? "checkout-v4.21.7";
const speed = Math.max(0.1, Number(value("--speed", "3")));
const dryRun = flag("--dry-run");

const domain = (process.env.FRESHDESK_DOMAIN ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
const apiKey = process.env.FRESHDESK_API_KEY ?? "";
if (!dryRun && (!domain || !apiKey)) {
  console.error("Set FRESHDESK_DOMAIN and FRESHDESK_API_KEY in .env first.");
  process.exit(1);
}

const scenario = JSON.parse(readFileSync(join(root, "scenarios", `${scenarioId}.json`), "utf8"));
const customers = new Map(scenario.world.customers.map((c) => [c.ref, c]));
// Freshdesk sources: 1 email, 2 portal, 3 phone, 7 chat
const SOURCE = { email: 1, portal: 2, phone: 3, chat: 7 };
const seconds = (at) => Number(/^\+(\d+)s$/.exec(at)?.[1] ?? 0);

let tickets = scenario.tickets.map((t) => ({ ...t, customer: customers.get(t.customerRef) }));
// Background tickets ("b1"…) come from customers outside the world; they're the noise the Pattern Agent must ignore.
if (flag("--only-complaints")) tickets = tickets.filter((t) => t.customer);

function subjectOf(body) {
  const first = body.split(/(?<=[.!?])\s/)[0].replace(/[.!?]+$/, "");
  return first.length > 70 ? `${first.slice(0, 67)}…` : first;
}

async function create(ticket) {
  const n = ticket.customerRef.replace(/\D/g, "") || "0";
  const name = ticket.customer?.name ?? `Shopper ${n}`;
  // Background customers have a name but no email: give them a reserved-domain one.
  const requester = { name, email: ticket.customer?.email ?? `${name.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "")}@example.com` };
  const body = {
    name: requester.name,
    email: requester.email,
    subject: subjectOf(ticket.body),
    description: `<div>${ticket.body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</div>`,
    status: 2,
    priority: 2,
    source: SOURCE[ticket.channel] ?? 2,
    tags: ["crisiscrew-demo"],
  };
  if (dryRun) return { id: "dry-run", body };
  const res = await fetch(`https://${domain}/api/v2/tickets`, {
    method: "POST",
    headers: { authorization: `Basic ${Buffer.from(`${apiKey}:X`).toString("base64")}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Freshdesk ${res.status}: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`);
  return json;
}

console.log(`Filing ${tickets.length} tickets from "${scenarioId}" in ${dryRun ? "(dry run)" : domain}, ${speed}× faster than the scenario`);
const start = Date.now();
for (const ticket of tickets) {
  const due = start + (seconds(ticket.at) * 1000) / speed;
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
  try {
    const created = await create(ticket);
    const who = ticket.customer?.name ?? "walk-in";
    console.log(`  +${((Date.now() - start) / 1000).toFixed(0).padStart(3)}s  #${created.id}  ${ticket.channel.padEnd(6)} ${who.padEnd(12)} ${ticket.body}`);
  } catch (error) {
    console.error(`  failed: ${ticket.body}\n    ${error.message}`);
  }
}
console.log("Done. CrisisCrew picks them up on its next Freshdesk poll.");
