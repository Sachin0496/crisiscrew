import type { CrisisState } from "@crisiscrew/contracts";
import type { ScenarioSummary } from "../api";
import { Recovery } from "../components/incident/Coverage";
import { Decisions } from "../components/incident/Decision";
import { Detection } from "../components/incident/Detection";
import { RecentTickets } from "../components/incident/Feeds";
import { Impact } from "../components/incident/Impact";
import { RootCause } from "../components/incident/RootCause";
import { IncidentSummary, Stats, Stepper } from "../components/incident/Summary";
import { currentIncident } from "../view";

/**
 * The stage screen, one story from top to bottom: what happened and how far
 * along it is, the four numbers, who was harmed (including the silent), then
 * why it happened. The right column is what needs a person: decisions,
 * recovery and incoming tickets. Step-by-step agent detail lives on Traces.
 * With no incident open, detection leads: what it refused, and why.
 */
export function IncidentPage({ state, scenario, customerNames }: { state: CrisisState; scenario?: ScenarioSummary; customerNames: string[] }) {
  const incident = currentIncident(state);
  const start = state.session.startedAt;
  return (
    <div className="page">
      <IncidentSummary incident={incident} scenario={state.session.mode === "replay" ? scenario : undefined} finished={state.replayFinished} />
      {incident && <Stepper incident={incident} start={start} />}
      <Stats state={state} incident={incident} />
      <div className="incident-grid">
        <div className="col">
          {!incident && <Detection state={state} />}
          <Impact incident={incident} />
          <RootCause incident={incident} />
          {incident && <Detection state={state} compact />}
        </div>
        <div className="col">
          <Decisions state={state} incident={incident} />
          <Recovery state={state} incident={incident} />
          <RecentTickets state={state} customerNames={customerNames} />
        </div>
      </div>
    </div>
  );
}
