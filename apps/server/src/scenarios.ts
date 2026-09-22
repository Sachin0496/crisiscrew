import { parseOffset, parsePolicy, ScenarioSchema, TOOL_NAMES, type Policy, type Scenario, type Ticket } from "@crisiscrew/contracts";
import { readdirSync, readFileSync } from "node:fs";
import { POLICY_FILE, SCENARIO_DIR } from "./paths";

/** Loads and validates every scenario JSON file in the folder, keyed by scenario id. */
export function loadScenarios(dir: URL = SCENARIO_DIR): Map<string, Scenario> {
  const scenarios = new Map<string, Scenario>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const raw = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
    const parsed = ScenarioSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid scenario ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
    if (`${parsed.data.id}.json` !== file) throw new Error(`Scenario ${file} has id "${parsed.data.id}"; the id must match the file name`);
    scenarios.set(parsed.data.id, parsed.data);
  }
  return scenarios;
}

/** The scenario's tickets as engine tickets, with times relative to `t0`. */
export function scenarioTickets(scenario: Scenario, t0: number): Ticket[] {
  const names = new Map(scenario.world.customers.map((c) => [c.ref, c.name]));
  return scenario.tickets.map((t, i) => ({
    id: `t${i + 1}`,
    source: "sandbox",
    customerRef: t.customerRef,
    customerName: names.get(t.customerRef) ?? t.customerRef,
    channel: t.channel,
    subject: t.subject,
    body: t.body,
    receivedAt: t0 + parseOffset(t.at),
  }));
}

export function loadPolicy(file: URL = POLICY_FILE): Policy {
  return parsePolicy(JSON.parse(readFileSync(file, "utf8")), TOOL_NAMES);
}
