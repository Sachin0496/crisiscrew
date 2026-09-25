import type { InfraCheck, InfraHealth, InfraHealthPort } from "@crisiscrew/core";
import type { McpToolClient } from "./mcp-client";
import { parseAlarms, parsePods } from "./parse";

const why = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 160);

/**
 * Infrastructure health from MCP servers: pods from each Kubernetes server
 * (pods_list_in_namespace, by label selector), active alarms from each
 * CloudWatch server (get_active_alarms). Servers are asked in parallel;
 * one that fails or answers in a shape CrisisCrew can't read adds a check
 * that says so, and its part stays out of the result.
 */
export function mcpInfraHealth(servers: readonly McpToolClient[]): InfraHealthPort {
  const kube = servers.filter((s) => s.config.kind === "kubernetes");
  const cloud = servers.filter((s) => s.config.kind === "cloudwatch");
  return {
    mode: "live",
    adapter: `mcp:${servers.map((s) => s.config.name).join("+")}`,
    async health(service) {
      const checks: InfraCheck[] = [];
      const pods = await Promise.all(
        kube.map(async (server) => {
          const source = `mcp:${server.config.name}`;
          try {
            const selector = (server.config.labelSelector ?? "app={service}").replaceAll("{service}", service);
            const text = await server.call("pods_list_in_namespace", { namespace: server.config.namespace ?? "default", labelSelector: selector });
            const parsed = parsePods(text);
            checks.push({ source, kind: "pods", checked: parsed !== null, detail: parsed ? `${parsed.ready}/${parsed.total} ready` : "pods returned in a format CrisisCrew can't read" });
            return parsed;
          } catch (error) {
            checks.push({ source, kind: "pods", checked: false, detail: `${server.config.name} unreachable: ${why(error)}` });
            return null;
          }
        }),
      );
      const alarms = await Promise.all(
        cloud.map(async (server) => {
          const source = `mcp:${server.config.name}`;
          try {
            const parsed = parseAlarms(await server.call("get_active_alarms", {}), service);
            checks.push({ source, kind: "alarms", checked: parsed !== null, detail: parsed ? `${parsed.length} active` : "alarms returned in a format CrisisCrew can't read" });
            return parsed;
          } catch (error) {
            checks.push({ source, kind: "alarms", checked: false, detail: `${server.config.name} unreachable: ${why(error)}` });
            return null;
          }
        }),
      );
      const podParts = pods.filter((p) => p !== null);
      const alarmParts = alarms.filter((a) => a !== null);
      const health: InfraHealth = { service, checks };
      if (podParts.length > 0) {
        health.pods = podParts.reduce((sum, p) => ({
          ready: sum.ready + p.ready,
          total: sum.total + p.total,
          restarts: sum.restarts + p.restarts,
          crashLooping: sum.crashLooping + p.crashLooping,
        }));
      }
      // An alarm that's active now counts however long ago it started: the service is unwell either way.
      if (alarmParts.length > 0) health.alarms = alarmParts.flat();
      return health;
    },
  };
}
