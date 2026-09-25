import type { IncidentView } from "@crisiscrew/contracts";
import { plural, TRACK_LABELS } from "../../format";
import type { CustomerFilter } from "../../view";
import { outreachByTrack } from "../../view";
import { Badge, Card } from "../ui";

const FILTER: Record<string, CustomerFilter> = { complained: "complained", not_complained: "silent", unverified: "unverified" };

/**
 * The Handoff Agent's outreach, one column per track: who's on it, and
 * where their messages stand. Choosing a track filters the table below.
 */
export function OutreachTracks({ incident, filter, onFilter }: { incident: IncidentView; filter: CustomerFilter; onFilter: (f: CustomerFilter) => void }) {
  const tracks = outreachByTrack(incident);
  if (tracks.length === 0) return null;
  return (
    <Card title="Outreach" subtitle="The Handoff Agent sends every customer message, in a track for each kind of customer">
      <div className="tracks">
        {tracks.map((t) => {
          const f = FILTER[t.track]!;
          const { total, sent, prepared, queued, failed } = t.messages;
          return (
            <button key={t.track} type="button" className="track" aria-pressed={filter === f} onClick={() => onFilter(filter === f ? "all" : f)}>
              <span className="track-head">
                <strong>{TRACK_LABELS[t.track].label}</strong>
                <span className="muted">{plural(t.customers, "customer")}</span>
              </span>
              <span className="track-lede">{TRACK_LABELS[t.track].lede}</span>
              <span className="track-stats">
                <Badge tone={queued || failed ? "accent" : "success"}>
                  {sent + prepared} of {total} {total === 1 ? "message" : "messages"} sent
                </Badge>
                {t.calls > 0 && <Badge>{plural(t.calls, "call")}</Badge>}
                {t.notesOnly > 0 && <Badge>{t.notesOnly} opted out: account note</Badge>}
                {failed > 0 && <Badge tone="danger">{failed} failed</Badge>}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
