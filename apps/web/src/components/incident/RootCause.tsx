import type { IncidentView } from "@crisiscrew/contracts";
import { Search } from "lucide-react";
import { pct, sentence } from "../../format";
import { Badge, Card, Empty } from "../ui";

const SOURCE: Record<string, string> = { sandbox: "Sandbox", core: "Engine", live: "Live" };

/** Who answered a check: the sandbox, the engine, or the MCP servers by name ("mcp:k8s-prod, mcp:cloudwatch" → "MCP · k8s-prod, cloudwatch"). */
export function sourceLabel(adapter: string): string {
  if (SOURCE[adapter]) return SOURCE[adapter]!;
  if (adapter.startsWith("mcp:")) return `MCP · ${adapter.split(/,\s*|\+/).map((a) => a.replace(/^mcp:/, "")).join(", ")}`;
  return "Live";
}

/** The Investigator's ranking: each cause's prior times the likelihood ratios of its evidence. */
export function RootCause({ incident }: { incident?: IncidentView }) {
  const hypotheses = incident?.hypotheses ?? [];
  return (
    <Card
      title="Root cause"
      subtitle="Investigator · prior × likelihood ratios, normalised across causes"
      footer={
        hypotheses.length > 0
          ? "Priors and likelihood ratios come from config/policy.json. They're stated assumptions, not values learned from past incidents."
          : undefined
      }
    >
      {!incident ? (
        <Empty icon={<Search size={18} />} title="Starts when an incident opens">
          The Investigator checks the payment gateway, recent releases, service error rates and infrastructure, then ranks every possible cause by its evidence.
        </Empty>
      ) : hypotheses.length === 0 ? (
        <Empty icon={<Search size={18} />} title="Investigating">
          Checking the payment gateway, recent releases and error rates…
        </Empty>
      ) : (
        <>
          {incident.narrative && <p className="narrative">{incident.narrative}</p>}
          {hypotheses.slice(0, 4).map((h, i) => {
            const top = i === 0 && incident.rootCause !== undefined;
            return (
              <div className={top ? "hyp top" : "hyp"} key={h.id}>
                <div className="hyp-row">
                  <div className="hyp-name">
                    <span>{h.label}</span>
                    {top && <Badge tone="danger">Likely cause</Badge>}
                  </div>
                  <div className="hyp-bar" aria-hidden>
                    <span style={{ width: pct(h.confidence) }} />
                  </div>
                  <div className="hyp-pct">{pct(h.confidence, 1)}</div>
                </div>
                <div className="evidence">
                  <div className="ev">
                    <span className="ev-lr">prior {h.prior.toFixed(2)}</span>
                    <span>{h.kind === "unknown" ? "Always kept, so no cause reaches 100% by elimination" : "Starting weight from policy"}</span>
                    <span />
                  </div>
                  {h.evidence.map((e, j) => (
                    <div className={e.checked ? "ev" : "ev unchecked"} key={j}>
                      <span className={`ev-lr${e.lr > 1 ? " up" : e.lr < 1 ? " down" : ""}`}>×{e.lr.toFixed(e.lr >= 10 ? 0 : 2)}</span>
                      <span>{sentence(e.observation)}</span>
                      <Badge tone={e.checked && SOURCE[e.adapter] === undefined ? "success" : "neutral"}>
                        {e.checked ? sourceLabel(e.adapter) : "Not checked"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </>
      )}
    </Card>
  );
}
