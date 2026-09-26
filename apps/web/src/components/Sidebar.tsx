import { recoveryCoverage, type CrisisState, type WiringReport } from "@crisiscrew/contracts";
import { Activity, Box, ChevronUp, Inbox, Moon, ShieldCheck, Siren, Sun, Users, Waypoints } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { MODE, PORT_LABELS } from "../format";
import { ROUTES, routeHref, type Route } from "../router";
import type { Theme } from "../theme";
import { currentIncident } from "../view";
import { Badge } from "./ui";

const ICONS = { incident: Siren, customers: Users, tickets: Inbox, traces: Waypoints, governance: ShieldCheck } as const;

type Props = {
  route: Route;
  state: CrisisState;
  connected: boolean;
  wiring: WiringReport | null;
  theme: Theme;
  onToggleTheme: () => void;
};

export function Sidebar({ route, state, connected, wiring, theme, onToggleTheme }: Props) {
  const incident = currentIncident(state);
  const open = incident !== undefined && !["recovered", "resolved", "dismissed"].includes(incident.status);
  const attention = state.traces.filter((t) => t.status === "attention" || t.status === "error").length;
  const flagged = state.guardFlags.length;
  const coverage = incident?.impact ? recoveryCoverage(incident) : undefined;
  const meta: Record<Route, ReactNode> = {
    incident: open ? <span className="nav-alert" title="An incident is open" /> : null,
    customers:
      coverage && coverage.needsHuman > 0 ? (
        <span className="nav-meta nav-warn" title={`${coverage.needsHuman} waiting for a human decision`}>
          {coverage.needsHuman} waiting
        </span>
      ) : coverage && coverage.confirmed > 0 ? (
        <span className="nav-meta" title="Recovery coverage">
          {coverage.recovered}/{coverage.confirmed}
        </span>
      ) : null,
    tickets: <span className="nav-meta">{state.ticketOrder.length}</span>,
    traces:
      attention > 0 ? (
        <span className="nav-meta nav-warn" title={`${attention} runs need attention`}>
          {attention} to check
        </span>
      ) : (
        <span className="nav-meta">{state.traces.length}</span>
      ),
    governance:
      flagged > 0 ? (
        <span className="nav-meta nav-warn" title={`${flagged} inputs flagged by the prompt guard`}>
          {flagged} flagged
        </span>
      ) : (
        <span className="nav-meta">{state.toolCalls.length}</span>
      ),
  };
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          <Activity size={17} strokeWidth={2.25} />
        </span>
        <span className="brand-text">
          <span className="brand-name">CrisisCrew</span>
          <span className="brand-sub">Customer harm response</span>
        </span>
      </div>
      <nav className="nav" aria-label="Pages">
        {ROUTES.map((r) => {
          const Icon = ICONS[r.id];
          return (
            <a key={r.id} className="nav-item" href={routeHref(r.id)} aria-current={route === r.id ? "page" : undefined} title={r.label}>
              <Icon size={17} aria-hidden />
              <span>{r.label}</span>
              {meta[r.id]}
            </a>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        {wiring && <Environment wiring={wiring} />}
        <div className="side-row" role="status" title={connected ? "Receiving live events from the engine" : "Trying to reconnect to the engine"}>
          <span className={connected ? "dot" : "dot bad"} aria-hidden />
          <span>{connected ? "Connected" : "Reconnecting…"}</span>
        </div>
        <button className="side-row" type="button" onClick={onToggleTheme} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
          <span>{theme === "dark" ? "Light mode" : "Dark mode"}</span>
        </button>
      </div>
    </aside>
  );
}

/** What's live and what's sandbox, from GET /api/wiring. */
function Environment({ wiring }: { wiring: WiringReport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const sandbox = wiring.ports.filter((p) => p.mode === "sandbox").length;
  const mock = wiring.ports.filter((p) => p.mode === "mock").length;
  const off = wiring.ports.filter((p) => p.mode === "off").length;
  return (
    <div className="env" ref={ref}>
      <button className="env-button" type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="dialog" title="What's live and what's sandbox">
        <span className="env-title">
          <Box size={14} aria-hidden />
          <span>{mock > 0 ? "Mock environment" : sandbox > 0 ? "Sandbox environment" : "Live environment"}</span>
          <ChevronUp size={14} aria-hidden />
        </span>
        <span className="env-sub">
          {wiring.liveCount} live · {mock > 0 ? `${mock} mock · ` : ""}{sandbox} sandbox · {off} off
        </span>
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Integrations">
          <div className="popover-head">
            <h3>Integrations</h3>
            <p>
              Every number is computed by the engine. Live means real computation or a real service; mock means the real adapter talking to the local mock
              services (INTEGRATIONS=mock); sandbox ports read the scenario's simulated world. Freshdesk,
              Freshservice, Laya, Lakera and LangSmith are wired and switch on with their keys in .env; the other external APIs are designed but not wired yet.
            </p>
          </div>
          <div className="popover-body">
            <table className="table">
              <thead>
                <tr>
                  <th>Port</th>
                  <th>Mode</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {wiring.ports.map((p) => (
                  <tr key={p.port}>
                    <td className="primary nowrap">{PORT_LABELS[p.port]}</td>
                    <td>
                      <Badge tone={MODE[p.mode].tone} dot={p.mode === "live"}>
                        {MODE[p.mode].label}
                      </Badge>
                    </td>
                    <td>
                      {p.detail}
                      {p.available.length > 0 && (
                        <div className="muted">
                          Available: {p.available.join(", ")} (set {p.env})
                        </div>
                      )}
                      {p.planned.length > 0 && <div className="muted">Planned: {p.planned.join(", ")}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
