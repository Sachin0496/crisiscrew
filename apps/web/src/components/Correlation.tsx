import type { CrisisState } from "@crisiscrew/contracts";
import { GATE_LABELS, pct, since, STATUS_LABELS, surface } from "../format";
import { currentIncident } from "./Overview";

export function Correlation({ state }: { state: CrisisState }) {
  const c = state.candidate;
  const cohesionGate = c?.gates.find((g) => g.name === "cohesion");
  // A cluster that has grown past the tickets that opened its incident means a later complaint joined it.
  const opener = c?.incidentId ? state.incidents[c.incidentId] : undefined;
  const joined = Boolean(opener && c && c.memberTicketIds.length > opener.ticketIds.length);
  return (
    <section className="card pad" id="correlation" aria-label="Pattern Agent correlation">
      <div className="cardhead">
        <h2>Pattern Agent · correlation</h2>
        <span className="aside">{c ? `latest ticket's group: ${c.memberTicketIds.length} tickets` : "waiting for tickets"}</span>
      </div>
      {!c ? (
        <div className="empty">
          Each new ticket is compared with everything from the last 15 minutes. Similarity is half <b>meaning</b> (sentence embeddings computed on this
          machine) and half <b>product area</b>, so complaints in completely different words can still match.
        </div>
      ) : (
        <div className={`corr ${c.incidentId ? "fired" : ""}`}>
          <div className="corr-top">
            <div>
              <div className="corr-label">Similarity inside the group</div>
              <div className="corr-value">{pct(c.cohesion)}</div>
            </div>
            <div className="corr-label" style={{ textAlign: "right" }}>
              {surface(c.dominantSurface)}
              <br />
              {c.failureCount} failure reports
            </div>
          </div>
          <div className="progress" role="img" aria-label={`similarity ${pct(c.cohesion)}, threshold ${pct(cohesionGate?.threshold ?? 0)}`}>
            <span style={{ width: pct(Math.max(0, Math.min(1, c.cohesion))) }} />
            {cohesionGate && <i className="mark" style={{ left: pct(cohesionGate.threshold) }} title={`threshold ${pct(cohesionGate.threshold)}`} />}
          </div>
          <div className="parts">
            <span>meaning {c.cohesionParts.meaning.toFixed(2)}</span>
            <span>product area {c.cohesionParts.area.toFixed(2)}</span>
            <span className="faint">= ½ meaning + ½ area</span>
          </div>
          <div className="gates">
            {c.gates.map((g) => (
              <div className={`gate ${g.pass ? "pass" : "fail"}`} key={g.name}>
                <span className="icon" aria-hidden>
                  {g.pass ? "✓" : "✗"}
                </span>
                <span className="name">{GATE_LABELS[g.name]}</span>
                <span className="why">{g.reason}</span>
              </div>
            ))}
          </div>
          <div className={`verdict ${c.incidentId ? "fire" : "hold"}`} role="status">
            {c.incidentId
              ? joined
                ? `The latest complaint matches ${c.incidentId}, which now has ${c.memberTicketIds.length} tickets.`
                : `All four gates passed: ${c.incidentId} opened.`
              : `No incident: ${c.gates.find((g) => !g.pass)?.reason ?? "gates not met"}.`}
          </div>
        </div>
      )}
      <Incident state={state} />
    </section>
  );
}

function Incident({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  if (!incident) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div className="incident-head">
        <span className="dot red" />
        <span className="incident-id">{incident.id}</span>
        <span className="pill">{STATUS_LABELS[incident.status]}</span>
        <span className="pill">severity {incident.severity}</span>
      </div>
      <div className="timeline">
        {incident.timeline.map((t, i) => (
          <div className={`tl ${i === incident.timeline.length - 1 ? "current" : ""}`} key={`${t.at}-${i}`}>
            <div className="when">{since(t.at, state.session.startedAt)}</div>
            <div className="what">{STATUS_LABELS[t.status]}</div>
            <div className="note">{t.note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
