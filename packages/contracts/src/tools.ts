/** Every tool an agent or MCP client can call through the policy gate. */
export const TOOL_NAMES = [
  "search_recent_tickets",
  "get_incident",
  "get_payment_health",
  "get_recent_deployments",
  "get_service_status",
  "identify_affected_customers",
  "open_incident",
  "link_ticket_to_incident",
  "draft_customer_update",
  "propose_recovery_credit",
  "request_human_approval",
  "send_customer_update",
  "issue_recovery_credit",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
