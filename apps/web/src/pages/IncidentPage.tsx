import type { CrisisState } from "@crisiscrew/contracts";
import type { ScenarioSummary } from "../api";
import { Coverage } from "../components/incident/Coverage";
import { Decisions } from "../components/incident/Decision";
import { Detection } from "../components/incident/Detection";
import { Activity, IncidentTimeline, RecentTickets } from "../components/incident/Feeds";
import { Impact } from "../components/incident/Impact";
import { RootCause } from "../components/incident/RootCause";
import { IncidentSummary, ScenarioNote, Stats, Stepper } from "../components/incident/Summary";
import { currentIncident } from "../view";

/**
 * Everything the stage demo needs on one screen, customer impact first:
 * who was harmed and who stayed silent, recovery coverage, the human
 * decisions, then the root cause and the detection that triggered it.
 */
export function IncidentPage({ state, scenario, customerNames }: { state: CrisisState; scenario?: ScenarioSummary; customerNames: string[] }) {
  const incident = currentIncident(state);
  const start = state.session.startedAt;
  return (
    <div className="page">
      {state.session.mode === "replay" && scenario && <ScenarioNote scenario={scenario} finished={state.replayFinished} />}
      <IncidentSummary incident={incident} />
      {incident && <Stepper incident={incident} start={start} />}
      <Stats state={state} incident={incident} />
      <div className="incident-grid">
        <div className="col">
          <Impact incident={incident} />
          <Coverage state={state} incident={incident} />
          <RootCause incident={incident} />
          <Detection state={state} />
        </div>
        <div className="col">
          <Decisions state={state} incident={incident} />
          <RecentTickets state={state} customerNames={customerNames} />
          {incident && <IncidentTimeline incident={incident} start={start} />}
          <Activity state={state} />
        </div>
      </div>
    </div>
  );
}
