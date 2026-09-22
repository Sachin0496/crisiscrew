import type { CrisisState } from "@crisiscrew/contracts";
import { pct } from "../format";
import { currentIncident } from "./Overview";

export function Investigation({ state }: { state: CrisisState }) {
  const incident = currentIncident(state);
  const hypotheses = incident?.hypotheses ?? [];
  return (
    <section className="card pad" id="investigation" aria-label="Root cause">
      <div className="cardhead">
        <h2>Investigator · root cause</h2>
        <span className="aside">prior × likelihood ratios, normalised</span>
      </div>
      {hypotheses.length === 0 ? (
        <div className="empty">
          {incident
            ? "Checking the payment gateway, recent releases and error rates…"
            : "Once an incident opens, the Investigator checks the payment gateway, recent releases and service error rates, then ranks every cause by its evidence."}
        </div>
      ) : (
        <>
          {incident?.narrative && <p className="narrative">{incident.narrative}</p>}
          {hypotheses.slice(0, 4).map((h, i) => (
            <div className={`hyp ${i === 0 && incident?.rootCause ? "top" : ""}`} key={h.id}>
              <div className="hyp-head">
                <span className="hyp-label">{h.label}</span>
                {i === 0 && incident?.rootCause && <span className="badge incident">root cause</span>}
                <span className="hyp-conf">{pct(h.confidence, 1)}</span>
              </div>
              <div className="bar">
                <span style={{ width: pct(h.confidence) }} />
              </div>
              <div className="evidence">
                <div className="ev faint">
                  <span className="lr">prior {h.prior.toFixed(2)}</span>
                  <span>{h.kind === "unknown" ? "Always kept, so nothing reaches 100% by elimination" : "Starting weight from policy"}</span>
                  <span />
                </div>
                {h.evidence.map((e, j) => (
                  <div className={`ev ${e.checked ? "" : "unchecked"}`} key={j}>
                    <span className={`lr ${e.lr > 1 ? "up" : e.lr < 1 ? "down" : ""}`}>×{e.lr.toFixed(e.lr >= 10 ? 0 : 2)}</span>
                    <span>{e.observation}</span>
                    <span className={`badge ${e.adapter === "sandbox" ? "sandbox" : e.adapter === "core" ? "off" : "live"}`}>{e.checked ? e.adapter : "not checked"}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          <p className="faint" style={{ fontSize: 12, margin: "4px 0 0" }}>
            The priors and likelihood ratios live in config/policy.json. They are uncalibrated defaults, stated openly; learning them from confirmed incidents is on the roadmap.
          </p>
        </>
      )}
    </section>
  );
}
