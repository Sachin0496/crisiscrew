/** The console's pages, addressed by the URL hash so a reload keeps the page. */
export type Route = "incident" | "tickets" | "agents" | "governance";

export const ROUTES: { id: Route; label: string }[] = [
  { id: "incident", label: "Incident" },
  { id: "tickets", label: "Tickets" },
  { id: "agents", label: "Agents" },
  { id: "governance", label: "Governance" },
];

export function parseRoute(hash: string): Route {
  const name = hash.replace(/^#\/?/, "");
  return ROUTES.find((r) => r.id === name)?.id ?? "incident";
}

export const routeHref = (route: Route) => `#/${route}`;
