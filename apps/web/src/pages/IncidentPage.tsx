import type { CrisisState } from "@crisiscrew/contracts";
import type { ScenarioSummary } from "../api";
import { Decision } from "../components/incident/Decision";
import { Detection } from "../components/incident/Detection";
import { Activity, IncidentTimeline, RecentTickets } from "../components/incident/Feeds";
import { Impact } from "../components/incident/Impact";
import { RootCause } from "../components/incident/RootCause";
import { IncidentSummary, ScenarioNote, Stats, Stepper } from "../components/incident/Summary";
import { currentIncident } from "../view";

/**
 * Everything the stage demo needs on one screen: detection, root cause,
 * customer impact and the human decision, with tickets and agent activity
 * alongside.
 */
export function IncidentPage({ state, scenario }: { state: CrisisState; scenario?: ScenarioSummary }) {
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
          <Detection state={state} />
          <RootCause incident={incident} />
          <Impact incident={incident} />
        </div>
        <div className="col">
          <Decision key={incident?.approvalId ?? incident?.id ?? "none"} state={state} incident={incident} />
          <RecentTickets state={state} />
          {incident && <IncidentTimeline incident={incident} start={start} />}
          <Activity state={state} />
        </div>
      </div>
    </div>
  );
}
