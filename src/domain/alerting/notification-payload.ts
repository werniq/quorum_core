export interface AlertNotificationPayload {
  schemaVersion: 1;
  eventType: string;
  incident: {
    id: string;
    type: string;
    severity: string;
    status: string;
    summary: string;
  };
  client: {
    id: string | null;
    name: string | null;
  };
  contract: {
    id: string;
    kind: string;
    name: string;
    businessPurpose: string;
  };
  expectation: {
    expectedAt: string | null;
    deadlineAt: string | null;
    overdueSince: string | null;
    overdueDurationSeconds: number | null;
  };
  observation: {
    lastStatus: string | null;
    lastAcceptableEvidenceAt: string | null;
    currentHealth: string;
  };
  evidence: {
    level: string;
    explanation: string;
    verifiedDimensions: string[];
    unverifiedDimensions: string[];
  };
  catalogEntryUrl: string;
}
