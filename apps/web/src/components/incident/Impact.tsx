import { recoveryCoverage, type IncidentView } from "@crisiscrew/contracts";
import { Radar, Users } from "lucide-react";
import { plural } from "../../format";
import { routeHref } from "../../router";
import { customerRows } from "../../view";
import { CustomerTable } from "../customers/CustomerTable";
import { Callout, Card, Empty } from "../ui";

/**
 * The Customer Impact Graph at a glance: who was harmed, who complained,
 * who stayed silent, and where each one's recovery stands. A row opens the
 * customer's evidence chain.
 */
export function Impact({ incident }: { incident?: IncidentView }) {
  const rows = customerRows(incident);
  const coverage = incident ? recoveryCoverage(incident) : undefined;
  const confirmed = coverage?.confirmed ?? 0;
  const silentShare = coverage && confirmed > 0 ? coverage.silent / confirmed : 0;
  return (
    <Card
      title="Customer impact"
      subtitle="Recovery Agent · who was harmed, and how CrisisCrew knows"
      actions={
        rows.length > 0 ? (
          <a className="link-btn" href={routeHref("customers")}>
            View all customers
          </a>
        ) : undefined
      }
      flush={rows.length > 0}
    >
      {!incident?.impact || !coverage ? (
        <Empty icon={<Users size={18} />} title="Found once an incident opens">
          The Recovery Agent checks payment attempts against the incident window, so it finds everyone who was harmed, including customers who never wrote in.
        </Empty>
      ) : (
        <>
          <div className="card-body impact-top">
            <div className="impact-counts">
              <div>
                <div className="impact-value">{confirmed}</div>
                <div className="similarity-caption">customers harmed</div>
              </div>
              <div>
                <div className="impact-value muted-value">{coverage.complained}</div>
                <div className="similarity-caption">complained</div>
              </div>
              <div>
                <div className="impact-value silent-value">{coverage.silent}</div>
                <div className="similarity-caption">stayed silent</div>
              </div>
              {coverage.unverified > 0 && (
                <div>
                  <div className="impact-value muted-value">{coverage.unverified}</div>
                  <div className="similarity-caption">not verified</div>
                </div>
              )}
            </div>
            <div className="split" role="img" aria-label={`${coverage.complained} complained, ${coverage.silent} silent`}>
              <span className="complained" style={{ width: `${(1 - silentShare) * 100}%` }} />
              <span className="silent" style={{ width: `${silentShare * 100}%` }} />
            </div>
            {coverage.silent > 0 ? (
              <Callout tone="accent" icon={<Radar size={16} aria-hidden />}>
                <strong>
                  {plural(coverage.complained, "customer")} complained. CrisisCrew found {coverage.silent} more
                </strong>{" "}
                whose payments failed in the same window but who never contacted support.
              </Callout>
            ) : (
              <Callout icon={<Users size={16} aria-hidden />}>Every affected customer has contacted support.</Callout>
            )}
          </div>
          <CustomerTable rows={rows} className="impact-table" />
        </>
      )}
    </Card>
  );
}
