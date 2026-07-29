import type { Edition } from "../../domain/terminology.js";
import type {
  ClientStatus,
  EmptyResultPolicy,
  CadenceType,
  IntervalMode,
  MonitoringMethod,
} from "../../domain/contracts/types.js";
import type {
  ContractHealth,
  EvidenceLevel,
} from "../../domain/terminology.js";
import type { HeartbeatEvidenceStatus } from "../../domain/evidence/empty-result.js";

export interface TenantRecord {
  id: string;
  name: string;
  edition: Edition;
  createdAt: string;
  updatedAt: string;
}

export interface ClientRecord {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: ClientStatus;
  protectionStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRecord {
  id: string;
  tenantId: string;
  clientId: string | null;
  name: string;
  sourcePlatform: "n8n";
  externalWorkflowId: string;
  description: string | null;
  monitoringMethod: MonitoringMethod;
  isActive: boolean;
  monitoringStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowContractRecord {
  id: string;
  tenantId: string;
  workflowId: string;
  name: string;
  businessPurpose: string;
  contractType: "heartbeat";
  cadenceType: CadenceType;
  cadenceValue: string;
  intervalMode: IntervalMode | null;
  scheduleAnchorAt: string | null;
  timezone: string | null;
  allowedLatenessMinutes: number;
  maxQuietWindowMinutes: number | null;
  initialGraceMinutes: number;
  emptyResultPolicy: EmptyResultPolicy;
  countLessSuccessAllowed: boolean;
  notificationBackoffMinutes: number;
  evidenceLevel: EvidenceLevel;
  schemaVersion: number;
  isActive: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowCredentialRecord {
  id: string;
  tenantId: string;
  workflowId: string;
  keyId: string;
  encryptedSecretOrVerificationMaterial: string;
  status: "active" | "revoked";
  createdAt: string;
  rotatedFromId: string | null;
  revokedAt: string | null;
}

export interface HeartbeatEventRecord {
  id: string;
  tenantId: string;
  workflowId: string;
  receivedAt: string;
  executedAt: string;
  status: HeartbeatEvidenceStatus;
  itemsProcessed: number | null;
  externalExecutionRef: string | null;
  idempotencyKey: string;
  payloadSchemaVersion: number;
  metadataJson: string | null;
  createdAt: string;
}

export interface WorkflowStateRecord {
  tenantId: string;
  workflowId: string;
  lastExecutionAt: string | null;
  lastNonemptySuccessAt: string | null;
  lastAcceptableSuccessAt: string | null;
  lastFailureAt: string | null;
  lastExternalExecutionRef: string | null;
  lastStatus: "success" | "failure" | "empty_result" | "unknown";
  nextExpectedAt: string | null;
  overdueSince: string | null;
  currentHealth: ContractHealth;
  evidenceLevel: EvidenceLevel;
  evidenceSummaryCode: string | null;
  unverifiedDimensionsJson: string | null;
  consecutiveStaleChecks: number;
  updatedAt: string;
}

/** Every query/mutation is tenant-scoped, including self-hosted. */
export interface CoreRepositories {
  ensureSelfHostedTenant(name?: string): TenantRecord;
  createClient(
    tenantId: string,
    input: Omit<ClientRecord, "tenantId" | "createdAt" | "updatedAt"> & {
      createdAt?: string;
      updatedAt?: string;
    },
  ): ClientRecord;
  listClients(tenantId: string): ClientRecord[];
  getClient(tenantId: string, clientId: string): ClientRecord | null;
  updateClientStatus(
    tenantId: string,
    clientId: string,
    status: ClientStatus,
    protectionStartedAt: string | null,
    nowIso: string,
  ): ClientRecord;
  /**
   * Soft-removes a workflow: deactivates contracts, unbinds connector,
   * revokes credentials, and hides it from the workflows list.
   * History (heartbeats/incidents) is retained.
   */
  removeWorkflow(tenantId: string, workflowId: string, nowIso: string): boolean;
  /**
   * Soft-removes a client (archived) and soft-removes its workflows.
   */
  removeClient(tenantId: string, clientId: string, nowIso: string): boolean;
  createWorkflow(
    tenantId: string,
    input: Omit<
      WorkflowRecord,
      "tenantId" | "createdAt" | "updatedAt" | "sourcePlatform"
    > & {
      sourcePlatform?: "n8n";
      createdAt?: string;
      updatedAt?: string;
    },
  ): WorkflowRecord;
  createWorkflowContract(
    tenantId: string,
    input: Omit<
      WorkflowContractRecord,
      "tenantId" | "createdAt" | "updatedAt" | "contractType"
    > & {
      contractType?: "heartbeat";
      createdAt?: string;
      updatedAt?: string;
    },
  ): WorkflowContractRecord;
  createCredential(
    tenantId: string,
    input: Omit<WorkflowCredentialRecord, "tenantId" | "createdAt"> & {
      createdAt?: string;
    },
  ): WorkflowCredentialRecord;
  insertHeartbeatEvent(
    tenantId: string,
    input: Omit<
      HeartbeatEventRecord,
      "tenantId" | "createdAt" | "metadataJson"
    > & {
      metadata?: unknown;
      createdAt?: string;
    },
  ): HeartbeatEventRecord;
  upsertWorkflowState(
    tenantId: string,
    state: WorkflowStateRecord,
  ): WorkflowStateRecord;
  getWorkflow(tenantId: string, workflowId: string): WorkflowRecord | null;
  listWorkflows(tenantId: string): WorkflowRecord[];
  getHeartbeatByIdempotencyKey(
    tenantId: string,
    workflowId: string,
    idempotencyKey: string,
  ): HeartbeatEventRecord | null;
  getWorkflowState(
    tenantId: string,
    workflowId: string,
  ): WorkflowStateRecord | null;
}
