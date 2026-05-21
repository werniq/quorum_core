/**
 * Retainer protection report — evidence-backed, never vanity ping metrics.
 */

export interface RetainerReportProcess {
  name: string;
  health: string;
  evidenceLevel: string;
  evidenceLimitations: string;
  activeIncidentSummary: string | null;
  missingOutcomes: number | null;
}

export interface RetainerReportIncident {
  summary: string;
  severity: string;
  status: string;
  openedAt: string;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionDurationMinutes: number | null;
  acknowledgementDurationMinutes: number | null;
  responseTargetMet: boolean | null;
  resolutionTargetMet: boolean | null;
  incidentType: string;
}

export interface RetainerProtectionReport {
  clientName: string;
  agencyName: string;
  brandingApplied: boolean;
  monitoringPeriod: string;
  coverageNote: string;
  processes: RetainerReportProcess[];
  incidents: RetainerReportIncident[];
  contractsProtected: number;
  evidenceLevelCounts: Record<string, number>;
  incidentsOpened: number;
  incidentsAcknowledged: number;
  incidentsResolved: number;
  medianAcknowledgementMinutes: number | null;
  medianResolutionMinutes: number | null;
  responseTargetMetPercent: number | null;
  resolutionTargetMetPercent: number | null;
  volumeBandViolations: number;
  recommendedActions: string[];
  disclaimer: string;
}

export function buildRetainerProtectionReport(input: {
  clientName: string;
  agencyName: string;
  brandingApplied: boolean;
  monitoringPeriod: string;
  coverageNote: string;
  processes: RetainerReportProcess[];
  incidents: RetainerReportIncident[];
  volumeBandViolations?: number;
}): RetainerProtectionReport {
  const actions: string[] = [];
  for (const p of input.processes) {
    if (p.evidenceLevel === "basic") {
      actions.push(
        `Consider raising evidence for “${p.name}” — destination delivery is not independently verified.`,
      );
    }
    if (p.health === "overdue" || p.health === "warning") {
      actions.push(`Investigate “${p.name}” — current health is ${p.health}.`);
    }
    if (p.missingOutcomes != null && p.missingOutcomes > 0) {
      actions.push(
        `Reconcile ${p.missingOutcomes} missing outcome(s) for “${p.name}”.`,
      );
    }
  }
  if (input.processes.length === 0) {
    actions.push(
      "Define the first critical process that should always work for this client.",
    );
  }
  if (actions.length === 0) {
    actions.push(
      "Continue monitoring covered processes; do not imply uncovered work is protected.",
    );
  }

  const evidenceLevelCounts: Record<string, number> = {};
  for (const p of input.processes) {
    evidenceLevelCounts[p.evidenceLevel] =
      (evidenceLevelCounts[p.evidenceLevel] ?? 0) + 1;
  }

  const ackDurations = input.incidents
    .map((i) => i.acknowledgementDurationMinutes)
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
  const resDurations = input.incidents
    .map((i) => i.resolutionDurationMinutes)
    .filter((m): m is number => m != null)
    .sort((a, b) => a - b);
  const median = (sorted: number[]) =>
    sorted.length === 0
      ? null
      : sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;

  const responseTargets = input.incidents.filter(
    (i) => i.responseTargetMet != null,
  );
  const resolutionTargets = input.incidents.filter(
    (i) => i.resolutionTargetMet != null,
  );

  return {
    clientName: input.clientName,
    agencyName: input.agencyName,
    brandingApplied: input.brandingApplied,
    monitoringPeriod: input.monitoringPeriod,
    coverageNote: input.coverageNote,
    processes: input.processes,
    incidents: input.incidents,
    contractsProtected: input.processes.length,
    evidenceLevelCounts,
    incidentsOpened: input.incidents.length,
    incidentsAcknowledged: input.incidents.filter((i) => i.acknowledgedAt)
      .length,
    incidentsResolved: input.incidents.filter((i) => i.resolvedAt).length,
    medianAcknowledgementMinutes: median(ackDurations),
    medianResolutionMinutes: median(resDurations),
    responseTargetMetPercent:
      responseTargets.length === 0
        ? null
        : Math.round(
            (100 * responseTargets.filter((i) => i.responseTargetMet).length) /
              responseTargets.length,
          ),
    resolutionTargetMetPercent:
      resolutionTargets.length === 0
        ? null
        : Math.round(
            (100 *
              resolutionTargets.filter((i) => i.resolutionTargetMet).length) /
              resolutionTargets.length,
          ),
    volumeBandViolations: input.volumeBandViolations ?? 0,
    recommendedActions: actions,
    disclaimer:
      "This report describes observed monitoring evidence. It does not claim that incidents were prevented. Heartbeat and volume-band evidence can be self-reported and do not prove destination delivery. Incidents that missed a response target are included, not hidden.",
  };
}

export function renderRetainerReportHtml(
  report: RetainerProtectionReport,
): string {
  const brand = report.brandingApplied
    ? `<p class="brand">${escape(report.agencyName)}</p>`
    : `<p class="brand">Quorum</p>`;
  const processes =
    report.processes.length === 0
      ? `<tr><td colspan="5">No processes covered yet.</td></tr>`
      : report.processes
          .map(
            (p) => `<tr>
              <td>${escape(p.name)}</td>
              <td>${escape(p.health)}</td>
              <td>${escape(p.evidenceLevel)}</td>
              <td>${escape(p.evidenceLimitations)}</td>
              <td>${escape(p.activeIncidentSummary ?? "—")}${
                p.missingOutcomes != null && p.missingOutcomes > 0
                  ? ` · ${p.missingOutcomes} missing`
                  : ""
              }</td>
            </tr>`,
          )
          .join("");
  const incidents =
    report.incidents.length === 0
      ? `<p>No incidents in this period.</p>`
      : `<ul>${report.incidents
          .map(
            (i) =>
              `<li>${escape(i.summary)} (${escape(i.severity)}, ${escape(i.status)})${
                i.resolutionDurationMinutes != null
                  ? ` · resolved in ${i.resolutionDurationMinutes}m`
                  : ""
              }</li>`,
          )
          .join("")}</ul>`;

  return `<!doctype html><html><head><meta charset="utf-8"/><title>${escape(report.clientName)} protection report</title>
    <style>
      body{font-family:Georgia,serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#1c1914;background:#f7f2e8}
      .brand{font-size:1.4rem;font-weight:700}
      table{width:100%;border-collapse:collapse} th,td{text-align:left;padding:.5rem;border-bottom:1px solid #cfc6b6}
      .muted{color:#5c564c} .disclaimer{margin-top:2rem;font-size:.9rem;color:#5c564c}
    </style></head><body>
    ${brand}
    <h1>${escape(report.clientName)} — retainer protection</h1>
    <p class="muted">${escape(report.coverageNote)}</p>
    <p class="muted">Monitoring period: ${escape(report.monitoringPeriod)}</p>
    <h2>Covered processes</h2>
    <table><thead><tr><th>Process</th><th>Health</th><th>Evidence</th><th>Limitations</th><th>Attention</th></tr></thead>
    <tbody>${processes}</tbody></table>
    <h2>Incidents</h2>${incidents}
    <h2>Recommended actions</h2>
    <ul>${report.recommendedActions.map((a) => `<li>${escape(a)}</li>`).join("")}</ul>
    <p class="disclaimer">${escape(report.disclaimer)}</p>
    </body></html>`;
}

function escape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
