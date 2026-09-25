/** Every tool an agent or MCP client can call through the policy gate. */
export const TOOL_NAMES = [
  "search_recent_tickets",
  "get_incident",
  "get_customer_impact",
  "get_recovery_coverage",
  "get_payment_health",
  "get_recent_deployments",
  "get_service_status",
  "identify_affected_customers",
  "open_incident",
  "file_engineering_incident",
  "update_engineering_incident",
  "link_ticket_to_incident",
  "add_ticket_note",
  "draft_customer_update",
  "plan_recovery",
  "add_account_note",
  "request_human_approval",
  "send_customer_update",
  "issue_recovery_credit",
  "page_on_call",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
