/** The console's pages, addressed by the URL hash so a reload keeps the page. */
export type Route = "incident" | "customers" | "tickets" | "agents" | "governance";

export const ROUTES: { id: Route; label: string }[] = [
  { id: "incident", label: "Incident" },
  { id: "customers", label: "Customers" },
  { id: "tickets", label: "Tickets" },
  { id: "agents", label: "Agents" },
  { id: "governance", label: "Governance" },
];

function parts(hash: string): string[] {
  return hash.replace(/^#\/?/, "").split("/").filter(Boolean);
}

export function parseRoute(hash: string): Route {
  const [name] = parts(hash);
  return ROUTES.find((r) => r.id === name)?.id ?? "incident";
}

/** The customer a Customers link points at, e.g. #/customers/s03. */
export function parseCustomer(hash: string): string | undefined {
  const [name, ref] = parts(hash);
  return name === "customers" && ref ? decodeURIComponent(ref) : undefined;
}

export const routeHref = (route: Route, customerRef?: string) =>
  route === "customers" && customerRef ? `#/customers/${encodeURIComponent(customerRef)}` : `#/${route}`;
