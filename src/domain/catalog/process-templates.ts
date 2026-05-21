/**
 * Process templates prefill onboarding questions — they never auto-activate contracts.
 */
export const PROCESS_TEMPLATES = [
  {
    id: "lead_delivery",
    label: "Lead delivery",
    suggestedPurpose: "New leads reach the CRM destination",
    suggestedCadenceType: "event_driven" as const,
    suggestedQuietWindowMinutes: 30,
  },
  {
    id: "webinar_registration",
    label: "Webinar registration",
    suggestedPurpose: "Webinar registrations reach the webinar platform",
    suggestedCadenceType: "event_driven" as const,
    suggestedQuietWindowMinutes: 15,
  },
  {
    id: "invoicing",
    label: "Invoicing",
    suggestedPurpose: "Invoices sync on schedule",
    suggestedCadenceType: "interval" as const,
    suggestedCadenceValue: "60",
  },
  {
    id: "support_ticket_creation",
    label: "Support-ticket creation",
    suggestedPurpose: "Support tickets are created from intake forms",
    suggestedCadenceType: "event_driven" as const,
    suggestedQuietWindowMinutes: 20,
  },
  {
    id: "customer_notification",
    label: "Customer notification",
    suggestedPurpose: "Customer notifications are sent after events",
    suggestedCadenceType: "event_driven" as const,
    suggestedQuietWindowMinutes: 10,
  },
  {
    id: "scheduled_data_sync",
    label: "Scheduled data sync",
    suggestedPurpose: "Scheduled data sync completes on cadence",
    suggestedCadenceType: "cron" as const,
    suggestedCadenceValue: "0 * * * *",
  },
  {
    id: "custom",
    label: "Custom process",
    suggestedPurpose: "",
    suggestedCadenceType: "interval" as const,
    suggestedCadenceValue: "15",
  },
] as const;

export type ProcessTemplateId = (typeof PROCESS_TEMPLATES)[number]["id"];

export function getProcessTemplate(id: string) {
  return PROCESS_TEMPLATES.find((t) => t.id === id) ?? null;
}
