import type { WiringReport } from "@crisiscrew/contracts";
import { useEffect, useState } from "react";
import { api, type PolicyView, type ScenarioSummary } from "./api";
import { Agents } from "./components/Agents";
import { Correlation } from "./components/Correlation";
import { Governance } from "./components/Governance";
import { Investigation } from "./components/Investigation";
import { Brief, Flow, Metrics } from "./components/Overview";
import { Approval, Recovery } from "./components/Recovery";
import { Signals } from "./components/Signals";
import { Topbar } from "./components/Topbar";
import { useCrisis } from "./useCrisis";

const NAV = [
  { href: "#overview", label: "Overview", d: "M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" },
  { href: "#signals", label: "Tickets", d: "M4 16v-3m4 6V8m4 8V5m4 14v-8m4 5V9" },
  { href: "#agents", label: "Agents", d: "M12 4a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM6 15a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zm12 0a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM10 9.5 7.5 14M14 9.5l2.5 4.5" },
  { href: "#recovery", label: "Recovery", d: "M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5" },
  { href: "#governance", label: "Governance", d: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" },
];

export function App() {
  const { state, connected } = useCrisis();
  const [wiring, setWiring] = useState<WiringReport | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [scenarioId, setScenarioId] = useState("checkout-v4.21.7");
  const [speed, setSpeed] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.wiring().then(setWiring, () => undefined);
    api.scenarios().then(setScenarios, () => undefined);
    api.policy().then(setPolicy, () => undefined);
  }, []);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseScenario = (id: string) => {
    setScenarioId(id);
    const s = scenarios.find((x) => x.id === id);
    if (s) setSpeed(Math.min(30, Math.max(1, s.speed)));
  };

  const scenario = scenarios.find((s) => s.id === (state.session.mode === "replay" ? state.session.scenarioId : scenarioId));

  return (
    <div className="app">
      <nav className="rail" aria-label="Sections">
        <div className="logo" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 28 28" fill="none">
            <path d="M6 17.5c0-5 3.4-9 8-9s8 4 8 9" stroke="#92ecff" strokeWidth="2.2" strokeLinecap="round" />
            <circle cx="14" cy="16.8" r="3.2" fill="#6D8CFF" />
            <path d="M14 4v2M4.8 8.2l1.7 1M23.2 8.2l-1.7 1" stroke="#fff" strokeOpacity=".75" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </div>
        {NAV.map((n) => (
          <a className="navbtn" href={n.href} title={n.label} aria-label={n.label} key={n.href}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d={n.d} stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        ))}
      </nav>
      <main className="main">
        <Topbar
          state={state}
          connected={connected}
          wiring={wiring}
          scenarios={scenarios}
          scenarioId={scenarioId}
          speed={speed}
          busy={busy}
          onScenario={chooseScenario}
          onSpeed={setSpeed}
          onRun={() => run(() => api.replay(scenarioId, speed))}
          onLive={() => run(() => api.live())}
        />
        {error && (
          <div className="verdict hold" role="alert" style={{ marginBottom: 14 }}>
            {error}
          </div>
        )}
        <Brief state={state} scenario={scenario} />
        <Metrics state={state} />
        <Flow state={state} />
        <div className="grid2">
          <Signals state={state} />
          <Correlation state={state} />
        </div>
        <div style={{ marginBottom: 18 }}>
          <Agents state={state} />
        </div>
        <div className="grid2 even">
          <Investigation state={state} />
          <Approval state={state} />
        </div>
        <div className="grid2 even">
          <Recovery state={state} />
          <Governance state={state} policy={policy} />
        </div>
        <footer className="footer">
          <span>
            Every number on this page is computed by the engine from ticket text and the scenario's data. Ports marked <b>sandbox</b> use a simulated world;
            the wiring badge shows exactly which.
          </span>
          <span>CrisisCrew · Stage 2 · MIT licensed</span>
        </footer>
      </main>
    </div>
  );
}
