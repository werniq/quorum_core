import type Database from "better-sqlite3";

export type OnboardingStep =
  | "create_admin"
  | "choose_method"
  | "select_workflows"
  | "define_contracts"
  | "review_evidence"
  | "configure_alerts"
  | "activate"
  | "catalog";

export type MonitoringMethodChoice = "push" | "poll";

export class SqliteOnboardingRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  get(tenantId: string): {
    step: OnboardingStep;
    monitoringMethodChoice: MonitoringMethodChoice | null;
    completedAt: string | null;
  } | null {
    const row = this.sqlite
      .prepare(`SELECT * FROM onboarding_state WHERE tenant_id = ?`)
      .get(tenantId) as
      | {
          step: OnboardingStep;
          monitoring_method_choice: MonitoringMethodChoice | null;
          completed_at: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      step: row.step,
      monitoringMethodChoice: row.monitoring_method_choice,
      completedAt: row.completed_at,
    };
  }

  ensure(
    tenantId: string,
    nowIso: string,
  ): {
    step: OnboardingStep;
    monitoringMethodChoice: MonitoringMethodChoice | null;
    completedAt: string | null;
  } {
    const existing = this.get(tenantId);
    if (existing) {
      return existing;
    }
    this.sqlite
      .prepare(
        `INSERT INTO onboarding_state (
           tenant_id, step, monitoring_method_choice, completed_at, updated_at
         ) VALUES (?, 'choose_method', NULL, NULL, ?)`,
      )
      .run(tenantId, nowIso);
    return {
      step: "choose_method",
      monitoringMethodChoice: null,
      completedAt: null,
    };
  }

  setStep(
    tenantId: string,
    step: OnboardingStep,
    nowIso: string,
    extras?: { monitoringMethodChoice?: MonitoringMethodChoice },
  ): void {
    this.ensure(tenantId, nowIso);
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
