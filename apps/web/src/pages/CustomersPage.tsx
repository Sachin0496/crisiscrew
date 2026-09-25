import { recoveryCoverage, type CrisisState } from "@crisiscrew/contracts";
import { Users } from "lucide-react";
import { useState } from "react";
import { CustomerTable } from "../components/customers/CustomerTable";
import { EvidenceChain, RecoveryPlan } from "../components/customers/Evidence";
import { DecisionControl, decisionOutcome } from "../components/incident/Decision";
import { Badge, Callout, Card, Empty, Segmented } from "../components/ui";
import { CUSTOMER_STATE, pct, plural } from "../format";
import { currentIncident, customerRows, matchesFilter, type CustomerFilter } from "../view";

/**
 * The Customer Impact Graph, customer by customer: everyone the incident
 * harmed, whether they complained or stayed silent, the evidence that ties
 * them to the incident, and each step of their recovery.
 */
export function CustomersPage({ state, selected }: { state: CrisisState; selected?: string }) {
  const [filter, setFilter] = useState<CustomerFilter>("all");
  const incident = currentIncident(state);
  const rows = customerRows(incident);
  const coverage = incident ? recoveryCoverage(incident) : undefined;
  const shown = rows.filter((r) => matchesFilter(r, filter));
  const active = rows.find((r) => r.customer.ref === selected) ?? shown[0];
  const count = (f: CustomerFilter) => rows.filter((r) => matchesFilter(r, f)).length;
  const approval = active
    ? Object.values(state.approvals).find((a) => a.incidentId === incident?.id && a.customerRef === active.customer.ref)
    : undefined;
  const credit = approval ? state.credits.find((c) => c.approvalId === approval.id) : undefined;

  return (
    <div className="page">
      <div className="page-header">
        <div className="page-title-row">
          <h1 className="page-title">Customers</h1>
          {coverage && coverage.confirmed > 0 && (
            <Badge tone={coverage.complete ? "success" : coverage.needsHuman > 0 ? "warning" : "accent"} dot>
              Recovery coverage {coverage.recovered}/{coverage.confirmed} ({pct(coverage.ratio ?? 0)})
            </Badge>
          )}
        </div>
        <p className="page-lede">
          The Customer Impact Graph: every customer the incident harmed, whether they complained or stayed silent, the evidence that ties them to it, and each step of
          their recovery with the reason the policy chose it. A complaint alone never counts as harm: it takes a failed payment inside the incident window.
        </p>
      </div>
      {!incident?.impact ? (
        <Card title="Affected customers" subtitle="Built by the Recovery Agent once an incident opens">
          <Empty icon={<Users size={18} />} title="No incident yet">
            Run a replay, or send a few complaints from the ticket box, and the affected customers appear here with their evidence.
          </Empty>
        </Card>
      ) : (
        <div className="customers-grid">
          <Card
            title="Affected customers"
            subtitle={`${incident.id} · ${plural(coverage!.confirmed, "customer")} harmed since the incident window opened`}
            actions={
              <Segmented
                label="Show"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: `All ${count("all")}` },
                  { value: "complained", label: `Complained ${count("complained")}` },
                  { value: "silent", label: `Silent ${count("silent")}` },
                  { value: "needs_human", label: `Needs a human ${count("needs_human")}` },
                  ...(count("unverified") > 0 ? [{ value: "unverified" as const, label: `Not verified ${count("unverified")}` }] : []),
                ]}
              />
            }
            flush
          >
            {shown.length === 0 ? (
              <Empty icon={<Users size={18} />} title="No customers match this filter" />
            ) : (
              <CustomerTable rows={shown} selected={active?.customer.ref} className="tall" showRecovery={false} />
            )}
          </Card>
          {active && (
            <div className="detail-col">
              <Card
                className={active.state === "needs_human" ? "card-attention" : undefined}
                title={active.customer.name}
                subtitle={[
                  active.customer.tier === "priority" ? "Priority customer" : "Customer",
                  active.customer.email,
                  active.customer.ticketIds.length ? plural(active.customer.ticketIds.length, "ticket") : "no tickets",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                actions={
                  <Badge tone={CUSTOMER_STATE[active.state].tone} dot={active.state === "needs_human"}>
                    {CUSTOMER_STATE[active.state].label}
                  </Badge>
                }
              >
                <h3 className="section-title">Why CrisisCrew thinks they were affected</h3>
                <EvidenceChain customer={active.customer} />
                <h3 className="section-title">Recovery</h3>
                <RecoveryPlan actions={active.actions} />
                {approval?.status === "pending" && (
                  <div className="detail-decision">
                    <h3 className="section-title">Your decision</h3>
                    <DecisionControl key={approval.id} approval={approval} />
                  </div>
                )}
                {approval && approval.status !== "pending" && (
                  <div className="detail-decision">
                    <Callout tone={approval.status === "rejected" ? "neutral" : "success"}>{decisionOutcome(approval, credit?.id)}</Callout>
                  </div>
                )}
              </Card>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
