/*
 * "By the numbers" helpers, shared by the build (ByTheNumbers.astro) and the
 * browser refresh script so both render identical labels. Pure functions,
 * no DOM and no imports. Copy governed by docs/DISCLOSURE_REGISTER.md (T1/T2:
 * counts and outcomes only, no feed names, thresholds or methods).
 */

export interface ThreatTypeCount {
  threat_type: string;
  count: number;
}

export interface Bar {
  key: string;
  label: string;
  count: number;
  /** Neutral grey bar (grouped infrastructure signals). */
  group: boolean;
  /** Optional one-line explanation shown in the tooltip. */
  note?: string;
}

/** Display order for the named bars; anything else sorts after, by count. */
const ORDER = [
  "malware_distribution",
  "phishing",
  "typosquatting",
  "c2",
  "credential_harvesting",
  "infrastructure_signals",
] as const;

const LABELS: Record<string, string> = {
  malware_distribution: "Malware distribution",
  phishing: "Phishing",
  typosquatting: "Typosquatting",
  c2: "Command & control",
  credential_harvesting: "Credential harvesting",
  infrastructure_signals: "Infrastructure signals",
};

/** Raw ids that are grouped into one neutral "Infrastructure signals" bar. */
const INFRA_IDS = new Set(["scanning", "malicious_ip"]);

/** Types below this count are noise on a chart of a million rows; dropped. */
export const MIN_TYPE_COUNT = 1000;
/** Unknown (unmapped) types below this share are folded into "Other". */
const OTHER_SHARE = 0.01;

export function titleCase(id: string): string {
  return id
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Validate an untrusted threat_types payload; returns null if unusable. */
export function parseThreatTypes(v: unknown): ThreatTypeCount[] | null {
  if (!Array.isArray(v)) return null;
  const out: ThreatTypeCount[] = [];
  for (const row of v) {
    if (row && typeof row === "object") {
      const r = row as Record<string, unknown>;
      if (typeof r.threat_type === "string" && isCount(r.count)) {
        out.push({ threat_type: r.threat_type, count: r.count });
      }
    }
  }
  return out.length > 0 ? out : null;
}

/** Group, label, filter and order the raw per-type counts into chart bars. */
export function buildBars(rows: ThreatTypeCount[]): Bar[] {
  const sum = rows.reduce((a, r) => a + r.count, 0);
  const merged = new Map<string, number>();
  for (const r of rows) {
    const key = INFRA_IDS.has(r.threat_type) ? "infrastructure_signals" : r.threat_type;
    merged.set(key, (merged.get(key) ?? 0) + r.count);
  }

  const bars: Bar[] = [];
  let other = 0;
  for (const [key, count] of merged) {
    if (count < MIN_TYPE_COUNT) continue;
    const known = key in LABELS;
    if (!known && sum > 0 && count / sum < OTHER_SHARE) {
      other += count;
      continue;
    }
    bars.push({
      key,
      label: LABELS[key] ?? titleCase(key),
      count,
      group: key === "infrastructure_signals",
      note: key === "infrastructure_signals" ? "Scanning hosts and malicious IPs, grouped" : undefined,
    });
  }

  const rank = (k: string) => {
    const i = (ORDER as readonly string[]).indexOf(k);
    return i === -1 ? ORDER.length : i;
  };
  bars.sort((a, b) => rank(a.key) - rank(b.key) || b.count - a.count);
  if (other >= MIN_TYPE_COUNT) bars.push({ key: "other", label: "Other", count: other, group: true });
  return bars;
}

/** Sum of every reported type count: the denominator for bar shares. */
export function typeTotal(rows: ThreatTypeCount[]): number {
  return rows.reduce((a, r) => a + r.count, 0);
}

/** "388K", "4.6K", "1.27M": compact value label at the bar end. */
export function compactCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Exact count with thousands separators (fixed locale so SSR == browser). */
export function exact(n: number): string {
  return Math.floor(n).toLocaleString("en-US");
}

/** Round DOWN to 2 significant digits + "+": 2347 -> "2,300+", 12154 -> "12,000+". */
export function roundLabel(n: number): string {
  if (n < 1000) return String(Math.floor(n));
  const digits = Math.floor(Math.log10(n)) + 1;
  const step = 10 ** (digits - 2);
  return `${(Math.floor(n / step) * step).toLocaleString("en-US")}+`;
}

/**
 * Label for the 30-day lookalike count: the live build value rounded, else the
 * published fallback, else null (callers omit the figure; never show 0).
 * Shared by ByTheNumbers and Coverage so both render the same string.
 */
export function lookalikes30dLabel(live: number | null | undefined, fallback: string | null | undefined): string | null {
  if (live) return roundLabel(live);
  return fallback ? fallback : null;
}

/** "5 Oct 2026, 11:38 UTC" (deterministic, independent of the viewer's zone). */
export function utcStamp(iso: string | number | Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${date}, ${time} UTC`;
}

export function utcDate(iso: string | number | Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Tile values derived from the raw numbers (any may be null = keep fallback). */
export interface LiveNumbers {
  total_threats: number | null;
  threats_today: number | null;
  operations_tracked: number | null;
  lookalikes_found_30d: number | null;
  monitored_brands: number | null;
  providers_mapped: number | null;
  countries: number | null;
  active_feeds: number | null;
  threat_types: ThreatTypeCount[] | null;
}

/** Pull and validate the numbers the section needs from a /public/stats payload. */
export function parseLive(payload: unknown): { numbers: LiveNumbers; generatedAt: string | null } | null {
  const data = (payload && typeof payload === "object" ? (payload as Record<string, unknown>).data : null) as
    | Record<string, unknown>
    | null;
  if (!data || typeof data !== "object") return null;
  const proof = (data.proof && typeof data.proof === "object" ? data.proof : {}) as Record<string, unknown>;
  const n = (v: unknown): number | null => (isCount(v) ? v : null);
  const numbers: LiveNumbers = {
    total_threats: n(data.total_threats),
    threats_today: n(data.threats_today),
    operations_tracked: n(proof.operations_tracked),
    // 0 means "not measured under the current definition", never a real zero.
    lookalikes_found_30d: isCount(proof.lookalikes_found_30d) && proof.lookalikes_found_30d > 0 ? proof.lookalikes_found_30d : null,
    monitored_brands: n(proof.monitored_brands),
    providers_mapped: n(data.providers_mapped),
    countries: n(data.countries),
    active_feeds: n(data.active_feeds),
    threat_types: parseThreatTypes(data.threat_types),
  };
  const generatedAt = typeof proof.generated_at === "string" ? proof.generated_at : null;
  return { numbers, generatedAt };
}

/** The "40+" rule from the disclosure register: never the exact feed count. */
export function sourcesLabel(n: number): string {
  return n >= 40 ? "40+" : String(Math.floor(n));
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sharePct(count: number, total: number): string {
  return total > 0 ? `${((count / total) * 100).toFixed(1)}%` : "n/a";
}

/**
 * Chart rows as an HTML string. Used for the build-time render AND the live
 * refresh so the two can never drift. Each row is a focusable role="img" with
 * an aria-label; hover/focus tooltips read the data-* attributes.
 */
export function renderBars(bars: Bar[], total: number): string {
  const max = Math.max(1, ...bars.map((b) => b.count));
  return bars
    .map((b) => {
      const share = sharePct(b.count, total);
      const w = Math.max(1.5, (b.count / max) * 100).toFixed(1);
      return (
        `<div class="num-bar${b.group ? " grp" : ""}" role="img" tabindex="0"` +
        ` aria-label="${esc(`${b.label}: ${exact(b.count)} threats, ${share} of classified threats`)}"` +
        ` data-label="${esc(b.label)}" data-count="${exact(b.count)}" data-share="${share}"` +
        (b.note ? ` data-note="${esc(b.note)}"` : "") +
        `><span class="num-bar-l">${esc(b.label)}</span>` +
        `<span class="num-bar-tr" aria-hidden="true"><i class="num-bar-f" style="width:${w}%"></i></span>` +
        `<span class="num-bar-v" aria-hidden="true">${compactCount(b.count)}</span></div>`
      );
    })
    .join("");
}

/** Same data as a table body, for the visually-hidden accessible equivalent. */
export function renderTableRows(bars: Bar[], total: number): string {
  return bars
    .map((b) => `<tr><th scope="row">${esc(b.label)}</th><td>${exact(b.count)}</td><td>${sharePct(b.count, total)}</td></tr>`)
    .join("");
}
