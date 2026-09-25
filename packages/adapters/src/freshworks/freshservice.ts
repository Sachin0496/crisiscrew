import type { ImportanceLevel } from "@crisiscrew/contracts";
import type { IncidentsPort } from "@crisiscrew/core";
import { freshworksRequest, textToHtml, type FreshworksAuth } from "./http";

export type FreshserviceOptions = FreshworksAuth & {
  /** Freshservice needs a requester for every ticket: the address incidents are filed as. */
  requesterEmail: string;
  /** Only for accounts with several workspaces. */
  workspaceId?: number;
};

type CreatedTicket = { ticket?: { id: number }; id?: number };

/** Freshservice priority (1 low to 4 urgent), urgency and impact (1 low to 3 high) for each importance level. */
export const FRESHSERVICE_PRIORITY: Record<ImportanceLevel, { priority: number; urgency: number; impact: number }> = {
  P1: { priority: 4, urgency: 3, impact: 3 },
  P2: { priority: 3, urgency: 2, impact: 2 },
  P3: { priority: 2, urgency: 1, impact: 1 },
};

/**
 * Engineering incidents in Freshservice (API v2): one incident ticket per
 * CrisisCrew incident, then private notes as the root cause and customer
 * impact become known. Priority, urgency and impact follow the incident's
 * importance (FRESHSERVICE_PRIORITY), and rise with it; status 2 (open).
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
    async open({ title, description, importance }) {
      const created = await freshworksRequest<CreatedTicket>(options, "POST", "/api/v2/tickets", {
        subject: title,
        description: textToHtml(description),
        email: options.requesterEmail,
        ...FRESHSERVICE_PRIORITY[importance],
        status: 2,
        ...(options.workspaceId !== undefined ? { workspace_id: options.workspaceId } : {}),
      });
      const id = created?.ticket?.id ?? created?.id;
      if (!id) throw new Error("Freshservice created the incident but returned no id");
      return { id: `#${id}`, url: `https://${options.domain}/a/tickets/${id}` };
    },
    async setImportance(recordId, importance) {
      await freshworksRequest(options, "PUT", `/api/v2/tickets/${numeric(recordId)}`, FRESHSERVICE_PRIORITY[importance]);
    },
    async note(recordId, text) {
      await freshworksRequest(options, "POST", `/api/v2/tickets/${numeric(recordId)}/notes`, { body: textToHtml(text), private: true });
    },
  };
}
