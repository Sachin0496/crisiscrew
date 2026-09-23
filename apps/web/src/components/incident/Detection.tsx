import type { CrisisState } from "@crisiscrew/contracts";
import { CircleAlert, CircleCheck, Link2, Radar, ShieldCheck, Siren } from "lucide-react";
import { GATE_LABELS, pct, plural, sentence, surface } from "../../format";
import { groupVerdict } from "../../view";
import { Badge, Callout, Card, Empty } from "../ui";

const VERDICT = {
  opened: { tone: "danger", icon: <Siren size={16} aria-hidden /> },
  joined: { tone: "accent", icon: <Link2 size={16} aria-hidden /> },
  refused: { tone: "neutral", icon: <ShieldCheck size={16} aria-hidden /> },
} as const;

/** The Pattern Agent's view of the latest ticket's group: similarity, the four gates, and the decision. */
export function Detection({ state }: { state: CrisisState }) {
  const group = state.candidate;
  if (!group) {
    return (
      <Card title="Detection" subtitle="Pattern Agent">
        <Empty icon={<Radar size={18} />} title="Waiting for tickets">
          Each new ticket is compared with everything from the last 15 minutes. Similarity is half meaning, from sentence embeddings computed on this machine,
          and half product area.
        </Empty>
      </Card>
    );
  }
  const threshold = group.gates.find((g) => g.name === "cohesion")?.threshold ?? 0;
  const verdict = groupVerdict(group, state.incidents);
  const style = VERDICT[verdict.tone];
  return (
    <Card
      title="Detection"
      subtitle="Pattern Agent · the latest ticket and the tickets that match it"
      actions={<Badge>{plural(group.memberTicketIds.length, "ticket")} in group</Badge>}
    >
      <div className="similarity">
        <div>
          <div className="similarity-caption">Similarity inside the group</div>
          <div className="similarity-value">{pct(group.cohesion)}</div>
        </div>
        <div className="similarity-caption">
          {surface(group.dominantSurface)} · {plural(group.failureCount, "failure report")}
        </div>
      </div>
      <div
        className={group.cohesion < threshold ? "meter below" : "meter"}
        role="img"
        aria-label={`Similarity ${pct(group.cohesion)}, threshold ${pct(threshold)}`}
      >
        <div className="meter-fill" style={{ width: pct(Math.max(0, Math.min(1, group.cohesion))) }} />
        <span className="meter-mark" style={{ left: pct(threshold) }} title={`Threshold ${pct(threshold)}`} />
      </div>
      <div className="parts">
        <span>
          Meaning <strong>{group.cohesionParts.meaning.toFixed(2)}</strong>
        </span>
        <span>
          Product area <strong>{group.cohesionParts.area.toFixed(2)}</strong>
        </span>
        <span>
          Threshold <strong>{pct(threshold)}</strong>
        </span>
        <span>Similarity is half meaning and half product area</span>
      </div>
      <div className="gates" role="list" aria-label="Detection gates">
        {group.gates.map((g) => (
          <div className={g.pass ? "gate pass" : "gate fail"} key={g.name} role="listitem">
            {g.pass ? <CircleCheck size={16} aria-label="Passed" /> : <CircleAlert size={16} aria-label="Not met" />}
            <span className="gate-name">{GATE_LABELS[g.name]}</span>
            <span className="gate-reason">{sentence(g.reason)}</span>
          </div>
        ))}
      </div>
      <Callout tone={style.tone} icon={style.icon}>
        {verdict.text}
      </Callout>
    </Card>
  );
}
