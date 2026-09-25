import type { IncidentsPort } from "@crisiscrew/core";
import { freshworksRequest, textToHtml, type FreshworksAuth } from "./http";

export type FreshserviceOptions = FreshworksAuth & {
  /** Freshservice needs a requester for every ticket: the address incidents are filed as. */
  requesterEmail: string;
  /** Only for accounts with several workspaces. */
  workspaceId?: number;
};

type CreatedTicket = { ticket?: { id: number }; id?: number };

/**
 * Engineering incidents in Freshservice (API v2): one incident ticket per
 * CrisisCrew incident, then private notes as the root cause and customer
 * impact become known. Priority 3 (high) for checkout incidents, 2 (medium)
 * otherwise; status 2 (open).
 */
export function freshserviceIncidents(options: FreshserviceOptions): IncidentsPort {
  const numeric = (recordId: string) => {
    const id = Number(recordId.replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) throw new Error(`not a Freshservice ticket id: ${recordId}`);
    return id;
  };
  return {
    mode: "live",
    adapter: "freshservice",
    async open({ title, description, severity }) {
      const created = await freshworksRequest<CreatedTicket>(options, "POST", "/api/v2/tickets", {
        subject: title,
        description: textToHtml(description),
        email: options.requesterEmail,
        priority: severity === "high" ? 3 : 2,
        status: 2,
        ...(options.workspaceId !== undefined ? { workspace_id: options.workspaceId } : {}),
      });
      const id = created?.ticket?.id ?? created?.id;
      if (!id) throw new Error("Freshservice created the incident but returned no id");
      return { id: `#${id}`, url: `https://${options.domain}/a/tickets/${id}` };
    },
    async note(recordId, text) {
      await freshworksRequest(options, "POST", `/api/v2/tickets/${numeric(recordId)}/notes`, { body: textToHtml(text), private: true });
    },
  };
}
