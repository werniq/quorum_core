/**
 * In-process metrics for self-hosted / local observability.
 * Never transmitted by default — exposed only via local GET /metrics.
 */

export type MetricLabels = Record<string, string>;

function labelKey(labels?: MetricLabels): string {
  if (!labels) return "";
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
}

/** Reject labels that could carry secrets or PII. */
export function assertSafeMetricLabels(labels?: MetricLabels): void {
  if (!labels) return;
  for (const [key, value] of Object.entries(labels)) {
    const k = key.toLowerCase();
    if (
      k.includes("secret") ||
      k.includes("token") ||
      k.includes("password") ||
      k.includes("email") ||
      k.includes("payload") ||
      k.includes("record")
    ) {
      throw new Error(`unsafe_metric_label:${key}`);
    }
    if (value.length > 64) {
      throw new Error(`metric_label_too_long:${key}`);
    }
  }
}

export class LocalMetricsRegistry {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, number[]>();

  inc(name: string, labels?: MetricLabels, by = 1): void {
    assertSafeMetricLabels(labels);
    const key = `${name}|${labelKey(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  setGauge(name: string, value: number, labels?: MetricLabels): void {
    assertSafeMetricLabels(labels);
    const key = `${name}|${labelKey(labels)}`;
    this.gauges.set(key, value);
  }

  observe(name: string, valueMs: number, labels?: MetricLabels): void {
    assertSafeMetricLabels(labels);
    const key = `${name}|${labelKey(labels)}`;
    const series = this.histograms.get(key) ?? [];
    series.push(valueMs);
    if (series.length > 200) {
      series.shift();
    }
    this.histograms.set(key, series);
  }

  snapshot(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, { count: number; sum: number; avg: number }>;
  } {
    const counters: Record<string, number> = {};
    for (const [k, v] of this.counters) counters[k] = v;
    const gauges: Record<string, number> = {};
    for (const [k, v] of this.gauges) gauges[k] = v;
    const histograms: Record<
      string,
      { count: number; sum: number; avg: number }
    > = {};
    for (const [k, values] of this.histograms) {
      const sum = values.reduce((a, b) => a + b, 0);
      histograms[k] = {
        count: values.length,
        sum,
        avg: values.length ? sum / values.length : 0,
      };
    }
    return { counters, gauges, histograms };
  }

  /** Prometheus-text exposition without sensitive labels. */
  toPrometheusText(): string {
    const lines: string[] = [
      "# HELP quorum_info Quorum local metrics (never transmitted by default).",
      "# TYPE quorum_info gauge",
      'quorum_info{edition="local"} 1',
    ];
    for (const [key, value] of this.counters) {
      const [name, labels] = key.split("|");
      lines.push(`${promName(name!)}${promLabels(labels!)} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      const [name, labels] = key.split("|");
      lines.push(`${promName(name!)}${promLabels(labels!)} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  resetForTests(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

function promName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, "_");
}

function promLabels(raw: string): string {
  if (!raw) return "";
  const parts = raw.split(",").filter(Boolean);
  if (parts.length === 0) return "";
  return `{${parts
    .map((p) => {
      const [k, ...rest] = p.split("=");
      return `${k}="${rest.join("=").replaceAll('"', "")}"`;
    })
    .join(",")}}`;
}

/** Process-wide registry for the running Quorum instance. */
export const localMetrics = new LocalMetricsRegistry();
