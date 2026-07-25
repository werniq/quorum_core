import type Database from "better-sqlite3";
import {
  emptyOnboardingDraft,
  parseOnboardingDraft,
  serializeOnboardingDraft,
  type OnboardingDraft,
} from "../../../domain/onboarding/draft.js";

export type OnboardingStep =
  | "create_admin"
  | "choose_method"
  | "select_workflows"
  | "define_contracts"
  | "review_evidence"
  | "configure_alerts"
  | "activate"
  | "catalog"
  | "client"
  | "connect_n8n"
  | "configure_monitoring"
  | "alerts_activate"
  | "complete";

export type MonitoringMethodChoice = "push" | "poll";

const LEGACY_STEP_MAP: Record<string, OnboardingStep> = {
  create_admin: "client",
  choose_method: "client",
  define_contracts: "configure_monitoring",
  review_evidence: "configure_monitoring",
  configure_alerts: "alerts_activate",
  activate: "alerts_activate",
};

function normalizeStep(step: string): OnboardingStep {
  return (LEGACY_STEP_MAP[step] ?? step) as OnboardingStep;
}

export class SqliteOnboardingRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  get(tenantId: string): {
    step: OnboardingStep;
    monitoringMethodChoice: MonitoringMethodChoice | null;
    completedAt: string | null;
    draft: OnboardingDraft;
  } | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM onboarding_state WHERE tenant_id = ?`)
      .get(tenantId) as
      | {
          step: string;
          monitoring_method_choice: MonitoringMethodChoice | null;
          completed_at: string | null;
          draft_json?: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      step: normalizeStep(row.step),
      monitoringMethodChoice: row.monitoring_method_choice,
      completedAt: row.completed_at,
      draft: parseOnboardingDraft(row.draft_json),
    };
  }

  ensure(
    tenantId: string,
    nowIso: string,
  ): {
    step: OnboardingStep;
    monitoringMethodChoice: MonitoringMethodChoice | null;
    completedAt: string | null;
    draft: OnboardingDraft;
  } {
    const existing = this.get(tenantId);
    if (existing) {
      return existing;
    }
    this.sqlite
      .prepare(
        `INSERT INTO onboarding_state (
           tenant_id, step, monitoring_method_choice, completed_at, updated_at, draft_json
         ) VALUES (?, 'client', NULL, NULL, ?, ?)`,
      )
      .run(tenantId, nowIso, serializeOnboardingDraft(emptyOnboardingDraft()));
    return {
      step: "client",
      monitoringMethodChoice: null,
      completedAt: null,
      draft: emptyOnboardingDraft(),
    };
  }

  setStep(
    tenantId: string,
    step: OnboardingStep,
    nowIso: string,
    extras?: {
      monitoringMethodChoice?: MonitoringMethodChoice;
      draft?: OnboardingDraft;
    },
  ): void {
    this.ensure(tenantId, nowIso);
    if (extras?.draft !== undefined && extras?.monitoringMethodChoice) {
      this.sqlite
        .prepare(
          `UPDATE onboarding_state
           SET step = ?, monitoring_method_choice = ?, draft_json = ?, updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(
          step,
          extras.monitoringMethodChoice,
          serializeOnboardingDraft(extras.draft),
          nowIso,
          tenantId,
        );
      return;
    }
    if (extras?.draft !== undefined) {
      this.sqlite
        .prepare(
          `UPDATE onboarding_state
           SET step = ?, draft_json = ?, updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(step, serializeOnboardingDraft(extras.draft), nowIso, tenantId);
      return;
    }
    if (extras?.monitoringMethodChoice) {
      this.sqlite
        .prepare(
          `UPDATE onboarding_state
           SET step = ?, monitoring_method_choice = ?, updated_at = ?
           WHERE tenant_id = ?`,
        )
        .run(step, extras.monitoringMethodChoice, nowIso, tenantId);
      return;
    }
    this.sqlite
      .prepare(
        `UPDATE onboarding_state SET step = ?, updated_at = ? WHERE tenant_id = ?`,
      )
      .run(step, nowIso, tenantId);
  }

  saveDraft(tenantId: string, draft: OnboardingDraft, nowIso: string): void {
    this.ensure(tenantId, nowIso);
    this.sqlite
      .prepare(
        `UPDATE onboarding_state SET draft_json = ?, updated_at = ? WHERE tenant_id = ?`,
      )
      .run(serializeOnboardingDraft(draft), nowIso, tenantId);
  }

  complete(tenantId: string, nowIso: string): void {
    this.ensure(tenantId, nowIso);
    this.sqlite
      .prepare(
        `UPDATE onboarding_state
         SET step = 'catalog', completed_at = ?, updated_at = ?
         WHERE tenant_id = ?`,
      )
      .run(nowIso, nowIso, tenantId);
  }

  isComplete(tenantId: string): boolean {
    const state = this.get(tenantId);
    return Boolean(state?.completedAt);
  }
}
