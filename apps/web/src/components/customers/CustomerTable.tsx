import { useEffect, useRef } from "react";
import { CUSTOMER_STATE } from "../../format";
import { routeHref } from "../../router";
import { planSummary, type CustomerRow } from "../../view";
import { Badge } from "../ui";

/** Affected customers, one row each: who they are, whether they complained, the evidence, the recovery and where it stands. A row opens their evidence chain. */
export function CustomerTable({ rows, selected, className = "" }: { rows: CustomerRow[]; selected?: string; className?: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  // A link to one customer (#/customers/s03) scrolls their row into view inside the table, without moving the page.
  useEffect(() => {
    const box = wrap.current;
    const row = box?.querySelector<HTMLElement>("tr.selected");
    if (!box || !row) return;
    const header = box.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const top = row.offsetTop - header;
    if (top < box.scrollTop || row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - 8);
  }, [selected]);
  return (
    <div className={`table-wrap ${className}`} ref={wrap}>
      <table className="table">
        <thead>
          <tr>
            <th>Customer</th>
            <th>Reported</th>
            <th>Evidence</th>
            <th>Recovery</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ customer, actions, state, headline }) => {
            const status = CUSTOMER_STATE[state];
            const isSelected = customer.ref === selected;
            return (
              <tr
                key={customer.ref}
                className={isSelected ? "row-link selected" : "row-link"}
                aria-selected={selected === undefined ? undefined : isSelected}
                onClick={() => (window.location.hash = routeHref("customers", customer.ref))}
              >
                <td className="primary nowrap">
                  <a href={routeHref("customers", customer.ref)} onClick={(e) => e.stopPropagation()}>
                    {customer.name}
                  </a>
                  {customer.tier === "priority" && <span className="tier">Priority</span>}
                </td>
                <td className="nowrap">
                  {customer.confidence !== "confirmed" ? <Badge>Not verified</Badge> : customer.complained ? <Badge>Complained</Badge> : <Badge tone="accent">Silent</Badge>}
                </td>
                <td className="evidence-cell">{headline}</td>
                <td className="plan-cell">{planSummary(actions) || <span className="muted">Planning…</span>}</td>
                <td>
                  <Badge tone={status.tone} dot={state === "needs_human"}>
                    {status.label}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
