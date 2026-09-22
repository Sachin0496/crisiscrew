import type { CrisisState, WiringReport } from "@crisiscrew/contracts";
import { useEffect, useRef, useState } from "react";
import type { ScenarioSummary } from "../api";

type Props = {
  state: CrisisState;
  connected: boolean;
  wiring: WiringReport | null;
  scenarios: ScenarioSummary[];
  scenarioId: string;
  speed: number;
  busy: boolean;
  onScenario: (id: string) => void;
  onSpeed: (speed: number) => void;
  onRun: () => void;
  onLive: () => void;
};

function Wiring({ wiring }: { wiring: WiringReport }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const sandbox = wiring.ports.filter((p) => p.mode === "sandbox").length;
  const off = wiring.ports.filter((p) => p.mode === "off").length;
  return (
    <div className="popover-wrap" ref={ref}>
      <button className="pill" onClick={() => setOpen(!open)} aria-expanded={open} title="What is live and what is sandbox">
        <span className="dot amber" />
        {wiring.liveCount} live · {sandbox} sandbox · {off} off
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Wiring">
          <h3>What's real right now</h3>
          <p>
            Every number is computed by the engine. <b>Sandbox</b> ports use the scenario's simulated world; <b>live</b> means real computation
            or a real service. Live adapters for external APIs are designed and listed in <span className="mono">.env.example</span>, but not wired yet.
          </p>
          {wiring.ports.map((p) => (
            <div className="wiring-row" key={p.port}>
              <span className="port">{p.port}</span>
              <span>
                <span className={`badge ${p.mode}`}>{p.mode}</span>
              </span>
              <span>
                {p.detail}
                {p.planned.length > 0 && <div className="planned">Planned: {p.planned.join(", ")}</div>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Topbar(props: Props) {
  const { state, connected, wiring, scenarios, scenarioId, speed, busy } = props;
  const session = state.session;
  const replaying = session.mode === "replay" && !state.replayFinished;
  const label =
    session.mode === "replay"
      ? `${state.replayFinished ? "Replay finished" : "Replaying"}: ${session.scenarioTitle} · ${session.speed}×`
      : session.mode === "live"
        ? "Live: type a complaint below (sandbox world)"
        : "Connecting…";
  return (
    <header className="topbar">
      <span className="wordmark">CrisisCrew</span>
      <span className="pill" aria-live="polite">
        <span className={`dot ${connected ? (replaying ? "" : "grey") : "red"}`} />
        {connected ? label : "Reconnecting to the engine…"}
      </span>
      {wiring && <Wiring wiring={wiring} />}
      <div className="top-actions">
        <label className="sr-only" htmlFor="scenario">
          Scenario
        </label>
        <select id="scenario" className="select" value={scenarioId} onChange={(e) => props.onScenario(e.target.value)}>
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="speed">
          Speed
        </label>
        <select id="speed" className="select" value={speed} onChange={(e) => props.onSpeed(Number(e.target.value))}>
          {[1, 2, 4, 10, 30].map((s) => (
            <option key={s} value={s}>
              {s}× speed
            </option>
          ))}
        </select>
        <button className="btn primary" onClick={props.onRun} disabled={busy || !scenarioId}>
          ▶ Run replay
        </button>
        <button className="btn" onClick={props.onLive} disabled={busy} title="Clear and go back to a live session">
          Live mode
        </button>
      </div>
    </header>
  );
}
