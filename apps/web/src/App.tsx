import type { WiringReport } from "@crisiscrew/contracts";
import { CircleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type DirectoryEntry, type PolicyView, type ScenarioSummary } from "./api";
import { AppHeader, SPEEDS } from "./components/AppHeader";
import { Sidebar } from "./components/Sidebar";
import { STATUS_LABELS } from "./format";
import { CustomersPage } from "./pages/CustomersPage";
import { GovernancePage } from "./pages/GovernancePage";
import { IncidentPage } from "./pages/IncidentPage";
import { TicketsPage } from "./pages/TicketsPage";
import { TracesPage } from "./pages/TracesPage";
import { parseCustomer, parseRoute, parseTrace, ROUTES, routeHref, type Route } from "./router";
import { applyTheme, storedTheme, type Theme } from "./theme";
import { useCrisis } from "./useCrisis";
import { currentIncident } from "./view";

export function App() {
  const { state, connected } = useCrisis();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [customerRef, setCustomerRef] = useState<string | undefined>(() => parseCustomer(window.location.hash));
  const [traceId, setTraceId] = useState<string | undefined>(() => parseTrace(window.location.hash));
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [theme, setTheme] = useState<Theme>(storedTheme);
  const [wiring, setWiring] = useState<WiringReport | null>(null);
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [scenarioId, setScenarioId] = useState("checkout-v4.21.7");
  const [speed, setSpeed] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => {
      const next = parseRoute(window.location.hash);
      // Picking another customer or trace keeps the page where it is.
      setRoute((previous) => {
        if (previous !== next || (next !== "customers" && next !== "traces")) window.scrollTo({ top: 0 });
        return next;
      });
      setCustomerRef(parseCustomer(window.location.hash));
      setTraceId(parseTrace(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    api.wiring().then(setWiring, () => undefined);
    api.scenarios().then(setScenarios, () => undefined);
    api.policy().then(setPolicy, () => undefined);
  }, []);

  // A replay started anywhere (this tab, another tab, the API) shows as the chosen scenario.
  const { id: sessionId, mode, scenarioId: replaying, speed: replaySpeed } = state.session;
  useEffect(() => {
    if (mode !== "replay" || !replaying) return;
    setScenarioId(replaying);
    if (replaySpeed !== undefined && SPEEDS.includes(replaySpeed)) setSpeed(replaySpeed);
  }, [sessionId, mode, replaying, replaySpeed]);

  // The customers of the session's world, so a typed complaint can come from a known customer.
  useEffect(() => {
    if (!sessionId) return;
    api.customers().then(setDirectory, () => undefined);
  }, [sessionId]);

  const incident = currentIncident(state);
  useEffect(() => {
    const page = ROUTES.find((r) => r.id === route)?.label ?? "Incident";
    document.title = incident && route === "incident" ? `${incident.id} · ${STATUS_LABELS[incident.status]} · CrisisCrew` : `${page} · CrisisCrew`;
  }, [route, incident?.id, incident?.status]);

  const customerNames = directory.map((c) => c.name);

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      if (route !== "incident") window.location.hash = routeHref("incident");
      else window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const chooseScenario = (id: string) => {
    setScenarioId(id);
    const chosen = scenarios.find((s) => s.id === id);
    if (chosen) setSpeed(Math.min(30, Math.max(1, chosen.speed)));
  };

  const scenario = scenarios.find((s) => s.id === (state.session.mode === "replay" ? state.session.scenarioId : scenarioId));

  return (
    <div className="shell">
      <Sidebar
        route={route}
        state={state}
        connected={connected}
        wiring={wiring}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
      />
      <div className="main">
        <AppHeader
          route={route}
          customerName={route === "customers" && customerRef ? incident?.impact?.customers.find((c) => c.ref === customerRef)?.name : undefined}
          state={state}
          scenarios={scenarios}
          scenarioId={scenarioId}
          speed={speed}
          busy={busy}
          onScenario={chooseScenario}
          onSpeed={setSpeed}
          onRun={() => run(() => api.replay(scenarioId, speed))}
          onLive={() => run(() => api.live())}
        />
        <main id="content">
          {route === "incident" && <IncidentPage state={state} scenario={scenario} customerNames={customerNames} />}
          {route === "customers" && <CustomersPage state={state} selected={customerRef} />}
          {route === "tickets" && <TicketsPage state={state} customerNames={customerNames} />}
          {route === "traces" && <TracesPage state={state} wiring={wiring} traceId={traceId} />}
          {route === "governance" && <GovernancePage state={state} policy={policy} wiring={wiring} />}
        </main>
      </div>
      {error && (
        <div className="toast callout callout-danger" role="alert">
          <CircleAlert size={16} aria-hidden />
          <div>{error}</div>
          <button className="link-btn" type="button" onClick={() => setError(null)} aria-label="Dismiss">
            <X size={15} aria-hidden />
          </button>
        </div>
      )}
    </div>
  );
}
