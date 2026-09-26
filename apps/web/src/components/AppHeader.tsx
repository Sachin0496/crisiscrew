import type { CrisisState } from "@crisiscrew/contracts";
import { BellRing, ChevronRight, Inbox, PhoneCall, Play, Radio } from "lucide-react";
import type { Health, ScenarioSummary } from "../api";
import { ROUTES, type Route } from "../router";
import { currentIncident, sessionSummary } from "../view";
import { Badge } from "./ui";

type Props = {
  route: Route;
  /** The customer open on the Customers page, for the breadcrumb. */
  customerName?: string;
  state: CrisisState;
  scenarios: ScenarioSummary[];
  scenarioId: string;
  speed: number;
  busy: boolean;
  onScenario: (id: string) => void;
  onSpeed: (speed: number) => void;
  onRun: () => void;
  onLive: () => void;
  /** Real-mode demo triggers, shown only when the server has them. */
  demo?: Health["demo"];
  onFileTickets: () => void;
  onFireAlert: () => void;
  /** Calls the primary on-call engineer about the current incident. */
  onCallOnCall: (incidentId: string) => void;
};

export const SPEEDS = [1, 2, 4, 10, 30];

export function AppHeader({ route, customerName, state, scenarios, scenarioId, speed, busy, onScenario, onSpeed, onRun, onLive, demo, onFileTickets, onFireAlert, onCallOnCall }: Props) {
  const incident = currentIncident(state);
  const session = sessionSummary(state);
  const page = ROUTES.find((r) => r.id === route)?.label ?? "Incident";
  return (
    <header className="topbar">
      <nav className="crumbs" aria-label="Breadcrumb">
        {route === "incident" && incident ? (
          <>
            <span>{page}</span>
            <ChevronRight size={14} aria-hidden />
            <strong className="mono">{incident.id}</strong>
          </>
        ) : route === "customers" && customerName ? (
          <>
            <span>{page}</span>
            <ChevronRight size={14} aria-hidden />
            <strong>{customerName}</strong>
          </>
        ) : (
          <strong>{page}</strong>
        )}
      </nav>
      <Badge tone={session.tone} dot={session.tone !== "neutral"}>
        {session.label}
      </Badge>
      <div className="toolbar">
        <label className="sr-only" htmlFor="scenario">
          Scenario to replay
        </label>
        <select id="scenario" className="select" value={scenarioId} onChange={(e) => onScenario(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="speed">
          Replay speed
        </label>
        <select id="speed" className="select" value={speed} onChange={(e) => onSpeed(Number(e.target.value))}>
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button className="btn" type="button" onClick={onRun} disabled={busy || !scenarioId}>
          <Play size={14} aria-hidden />
          Run replay
        </button>
        <button className="btn" type="button" onClick={onLive} disabled={busy} title="Live mode: start a fresh session for typed tickets">
          <Radio size={14} aria-hidden />
          Live mode
        </button>
        {incident ? (
          <button
            className="btn btn-danger"
            type="button"
            onClick={() => onCallOnCall(incident.id)}
            disabled={busy || incident.paging?.attempts.at(-1)?.state === "calling"}
            title={`Phone the on-call engineer now; the call briefs them on ${incident.id}, and they can acknowledge by voice`}
          >
            <PhoneCall size={14} aria-hidden />
            {incident.paging?.attempts.at(-1)?.state === "calling" ? "Calling on-call…" : "Call on-call now"}
          </button>
        ) : null}
        {demo?.freshdeskTickets ? (
          <button className="btn btn-primary" type="button" onClick={onFileTickets} disabled={busy} title={`File ${demo.freshdeskTickets} customer tickets in your Freshdesk; CrisisCrew ingests and classifies them as they land`}>
            <Inbox size={14} aria-hidden />
            File {demo.freshdeskTickets} tickets in Freshdesk
          </button>
        ) : null}
        {demo?.freshserviceAlert ? (
          <button className="btn" type="button" onClick={onFireAlert} disabled={busy} title={`Post a critical ${demo.freshserviceAlert} 5xx alert to Freshservice Alert Management`}>
            <BellRing size={14} aria-hidden />
            Fire Freshservice alert
          </button>
        ) : null}
      </div>
    </header>
  );
}
