/** The console's pages, addressed by the URL hash so a reload keeps the page. */
export type Route = "incident" | "customers" | "tickets" | "traces" | "governance";

export const ROUTES: { id: Route; label: string }[] = [
  { id: "incident", label: "Incident" },
  { id: "customers", label: "Customers" },
  { id: "tickets", label: "Tickets" },
  { id: "traces", label: "Traces" },
  { id: "governance", label: "Governance" },
];

/** Old links to the Agents page open Traces, which replaced it. */
const ALIASES: Record<string, Route> = { agents: "traces" };

function parts(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export function parseRoute(hash: string): Route {
  const [name] = parts(hash);
  return ROUTES.find((r) => r.id === name)?.id ?? (name ? ALIASES[name] : undefined) ?? "incident";
}

/** The trace a Traces link points at, e.g. #/traces/5f0c…. */
export function parseTrace(hash: string): string | undefined {
  const [name, id] = parts(hash);
  return name === "traces" && id ? decodeURIComponent(id) : undefined;
}

export const traceHref = (id: string) => `#/traces/${encodeURIComponent(id)}`;

/** The customer a Customers link points at, e.g. #/customers/s03. */
export function parseCustomer(hash: string): string | undefined {
  const [name, ref] = parts(hash);
  return name === "customers" && ref ? decodeURIComponent(ref) : undefined;
}

export const routeHref = (route: Route, customerRef?: string) =>
  route === "customers" && customerRef ? `#/customers/${encodeURIComponent(customerRef)}` : `#/${route}`;
