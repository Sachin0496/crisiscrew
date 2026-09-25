/**
 * Reading what infrastructure MCP servers return. Their output formats
 * aren't a contract (a table in one version, JSON in another), so these
 * parsers accept the common shapes and return null for anything else,
 * which the Investigator shows as "not checked" rather than guessing.
 */

export type PodSummary = { ready: number; total: number; restarts: number; crashLooping: number };

type ContainerStatus = { ready?: boolean; restartCount?: number; state?: { waiting?: { reason?: string } } };
type PodJson = { status?: { phase?: string; containerStatuses?: ContainerStatus[] } };

function fromJson(pods: PodJson[]): PodSummary {
  let ready = 0;
  let restarts = 0;
  let crashLooping = 0;
  for (const pod of pods) {
    const containers = pod.status?.containerStatuses ?? [];
    if (containers.length > 0 && containers.every((c) => c.ready)) ready += 1;
    restarts += containers.reduce((sum, c) => sum + (c.restartCount ?? 0), 0);
    if (containers.some((c) => c.state?.waiting?.reason === "CrashLoopBackOff")) crashLooping += 1;
  }
  return { ready, total: pods.length, restarts, crashLooping };
}

/** A kubectl-style table: a header row with READY, STATUS and RESTARTS, one pod per row. */
function fromTable(text: string): PodSummary | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const headerIndex = lines.findIndex((l) => /\bREADY\b/.test(l) && /\bSTATUS\b/.test(l) && /\bRESTARTS\b/.test(l));
  if (headerIndex < 0) return null;
  const header = lines[headerIndex]!.trim().split(/\s{2,}|\t/);
  const col = (name: string) => header.indexOf(name);
  const [readyCol, statusCol, restartsCol] = [col("READY"), col("STATUS"), col("RESTARTS")];
  if (readyCol < 0 || statusCol < 0 || restartsCol < 0) return null;
  const summary: PodSummary = { ready: 0, total: 0, restarts: 0, crashLooping: 0 };
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.trim().split(/\s{2,}|\t/);
    const readyCell = cells[readyCol] ?? "";
    const match = /^(\d+)\/(\d+)$/.exec(readyCell);
    if (!match) continue;
    summary.total += 1;
    if (match[1] === match[2] && Number(match[2]) > 0) summary.ready += 1;
    summary.restarts += Number.parseInt(cells[restartsCol] ?? "0", 10) || 0;
    if ((cells[statusCol] ?? "").includes("CrashLoopBackOff")) summary.crashLooping += 1;
  }
  return summary;
}

/** Pods from a JSON PodList, a JSON array of pods, or a kubectl-style table. */
export function parsePods(text: string): PodSummary | null {
  try {
    const json = JSON.parse(text) as unknown;
    const items = Array.isArray(json) ? json : (json as { items?: unknown }).items;
    if (Array.isArray(items)) return fromJson(items as PodJson[]);
  } catch {
    // not JSON: try a table
  }
  return fromTable(text);
}

export type AlarmSummary = { name: string; since?: number; metric?: string };

/**
 * Active alarms that mention a service, from any JSON the cloud server
 * returns: every object with an alarm-name field, whose contents name the
 * service (in the alarm's name, dimensions or description).
 */
export function parseAlarms(text: string, service: string): AlarmSummary[] | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const found: AlarmSummary[] = [];
  const needle = service.toLowerCase();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== "object") return;
    const entries = Object.entries(node as Record<string, unknown>);
    const nameEntry = entries.find(([k, v]) => /^alarm_?name$/i.test(k) && typeof v === "string");
    if (nameEntry) {
      if (JSON.stringify(node).toLowerCase().includes(needle)) {
        const at = entries.find(([k, v]) => /state_?updated|timestamp/i.test(k) && typeof v === "string")?.[1] as string | undefined;
        const metric = entries.find(([k, v]) => /^metric_?name$/i.test(k) && typeof v === "string")?.[1] as string | undefined;
        const since = at ? Date.parse(at) : Number.NaN;
        found.push({ name: nameEntry[1] as string, ...(Number.isNaN(since) ? {} : { since }), ...(metric ? { metric } : {}) });
      }
      return;
    }
    entries.forEach(([, v]) => visit(v));
  };
  visit(json);
  return found;
}
