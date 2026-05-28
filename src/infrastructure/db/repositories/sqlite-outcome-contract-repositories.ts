import type Database from "better-sqlite3";
import { createId } from "../../../domain/ids.js";
import {
  validateOutcomeContract,
  type MatchKeyDefinition,
  type OutcomeContractType,
} from "../../../domain/outcome/types.js";
import { assertExplicitContractConfirmation } from "../../../domain/contracts/explicit-activation.js";

export interface OutcomeContractRecord {
  id: string;
  tenantId: string;
  clientId: string | null;
  name: string;
  businessPurpose: string;
  contractType: OutcomeContractType;
  sourceConnectorId: string;
  destinationConnectorId: string;
  sourceObjectType: string;
  destinationObjectType: string;
  matchKeyDefinition: MatchKeyDefinition;
  sourceTimeField: string;
  destinationTimeField: string;
  maximumDeliveryDelayMinutes: number;
  acceptableMissingCount: number;
  acceptableMissingPercentage: number;
  scheduleExpression: string;
  timezone: string;
  evidenceLevelTarget: "medium" | "high";
  retentionDays: number;
  isActive: boolean;
  activatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function mapRow(row: Record<string, unknown>): OutcomeContractRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    clientId: (row.client_id as string | null) ?? null,
    name: String(row.name),
    businessPurpose: String(row.business_purpose),
    contractType: row.contract_type as OutcomeContractType,
    sourceConnectorId: String(row.source_connector_id),
    destinationConnectorId: String(row.destination_connector_id),
    sourceObjectType: String(row.source_object_type),
    destinationObjectType: String(row.destination_object_type),
    matchKeyDefinition: JSON.parse(
      String(row.match_key_definition),
    ) as MatchKeyDefinition,
    sourceTimeField: String(row.source_time_field),
    destinationTimeField: String(row.destination_time_field),
    maximumDeliveryDelayMinutes: Number(row.maximum_delivery_delay_minutes),
    acceptableMissingCount: Number(row.acceptable_missing_count),
    acceptableMissingPercentage: Number(row.acceptable_missing_percentage),
    scheduleExpression: String(row.schedule_expression),
    timezone: String(row.timezone),
    evidenceLevelTarget: row.evidence_level_target as "medium" | "high",
    retentionDays: Number(row.retention_days),
    isActive: Boolean(row.is_active),
    activatedAt: (row.activated_at as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteOutcomeContractRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  create(
    tenantId: string,
    input: Omit<
      OutcomeContractRecord,
      "tenantId" | "createdAt" | "updatedAt" | "activatedAt" | "isActive" | "id"
    > & {
      id?: string;
      isActive?: boolean;
      activatedAt?: string | null;
      nowIso: string;
      explicitlyConfirmed: boolean;
    },
  ): OutcomeContractRecord {
    assertExplicitContractConfirmation(input.explicitlyConfirmed, "alter");
    const validation = validateOutcomeContract({
      name: input.name,
      businessPurpose: input.businessPurpose,
      contractType: input.contractType,
      sourceConnectorId: input.sourceConnectorId,
      destinationConnectorId: input.destinationConnectorId,
      sourceObjectType: input.sourceObjectType,
      destinationObjectType: input.destinationObjectType,
      matchKeyDefinition: input.matchKeyDefinition,
      sourceTimeField: input.sourceTimeField,
      destinationTimeField: input.destinationTimeField,
      maximumDeliveryDelayMinutes: input.maximumDeliveryDelayMinutes,
      acceptableMissingCount: input.acceptableMissingCount,
      acceptableMissingPercentage: input.acceptableMissingPercentage,
      scheduleExpression: input.scheduleExpression,
      timezone: input.timezone,
      evidenceLevelTarget: input.evidenceLevelTarget,
      retentionDays: input.retentionDays,
      isActive: input.isActive ?? false,
    });
    if (!validation.ok) {
      throw new Error(validation.issues.join(","));
    }

    this.assertConnector(tenantId, input.sourceConnectorId, "source");
    this.assertConnector(tenantId, input.destinationConnectorId, "destination");

    const id = input.id ?? createId();
    const isActive = input.isActive ?? false;
    this.sqlite
      .prepare(
        `INSERT INTO outcome_contracts (
           id, tenant_id, client_id, name, business_purpose, contract_type,
           source_connector_id, destination_connector_id,
           source_object_type, destination_object_type, match_key_definition,
           source_time_field, destination_time_field,
           maximum_delivery_delay_minutes, acceptable_missing_count,
           acceptable_missing_percentage, schedule_expression, timezone,
           evidence_level_target, retention_days, is_active, activated_at,
           created_at, updated_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        id,
        tenantId,
        input.clientId,
        input.name,
        input.businessPurpose,
        input.contractType,
        input.sourceConnectorId,
        input.destinationConnectorId,
        input.sourceObjectType,
        input.destinationObjectType,
        JSON.stringify(input.matchKeyDefinition),
        input.sourceTimeField,
        input.destinationTimeField,
        input.maximumDeliveryDelayMinutes,
        input.acceptableMissingCount,
        input.acceptableMissingPercentage,
        input.scheduleExpression,
        input.timezone,
        input.evidenceLevelTarget,
        input.retentionDays,
        isActive ? 1 : 0,
        input.activatedAt ?? null,
        input.nowIso,
        input.nowIso,
      );
    return this.get(tenantId, id)!;
  }

  get(tenantId: string, id: string): OutcomeContractRecord | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM outcome_contracts WHERE tenant_id = ? AND id = ?`)
      .get(tenantId, id) as Record<string, unknown> | undefined;
    return row ? mapRow(row) : null;
  }

  list(tenantId: string): OutcomeContractRecord[] {
    const rows = this.sqlite
      .prepare(
        `SELECT * FROM outcome_contracts WHERE tenant_id = ? ORDER BY created_at ASC`,
      )
      .all(tenantId) as Array<Record<string, unknown>>;
    return rows.map(mapRow);
  }

  activate(
    tenantId: string,
    id: string,
    nowIso: string,
    explicitlyConfirmed: boolean,
  ): OutcomeContractRecord {
    assertExplicitContractConfirmation(explicitlyConfirmed, "activate");
    const result = this.sqlite
      .prepare(
        `UPDATE outcome_contracts
         SET is_active = 1, activated_at = ?, updated_at = ?
         WHERE tenant_id = ? AND id = ?`,
      )
      .run(nowIso, nowIso, tenantId, id);
    if (result.changes === 0) {
      throw new Error("outcome_contract_not_found");
    }
    return this.get(tenantId, id)!;
  }

  private assertConnector(
    tenantId: string,
    connectorId: string,
    expectedType: "source" | "destination",
  ): void {
    const row = this.sqlite
      .prepare(
        `SELECT connector_type FROM connectors WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, connectorId) as { connector_type: string } | undefined;
    if (!row) {
      throw new Error("connector_not_visible");
    }
    if (row.connector_type !== expectedType) {
      throw new Error("connector_type_mismatch");
    }
  }
}
