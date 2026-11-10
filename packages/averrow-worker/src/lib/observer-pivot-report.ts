// Observer's pivot-triggered run — a focused, rule-based operational report
// built ONLY from the pivot_detected payloads (owner decision 2026-11-10:
// make the nexus → observer edge work, and make Observer use the payload).
//
// Producers (both payload_v 2, lib/cluster-infra-movement.ts builders):
//   kind 'dormancy'        — ASN-lane cluster whose activity dropped >80%
//                            (lib/nexus-threat-lanes.ts): cluster_id, asn,
//                            cluster_name?, prev_asn.
//   kind 'infra_movement'  — bridge cluster gained new IPs/ASNs/cert serials
//                            (lib/cluster-infra-movement.ts): cluster_id,
//                            cluster_name, new_asns/new_ips/new_serials counts,
//                            new_asn_list, prev_asn_list.
//
// Pure: no D1, no AI. The orchestrator coalesces a tick's pivots into one
// run (lib/agent-event-dispatch.ts) and passes every payload as
// `input.events`, so one run reports all of them.

export interface DormancyPivot {
  kind: "dormancy";
  eventId: string | null;
  clusterId: string;
  clusterName: string | null;
  asn: string | null;
}

export interface InfraMovementPivot {
  kind: "infra_movement";
  eventId: string | null;
  clusterId: string;
  clusterName: string | null;
  newAsns: number;
  newIps: number;
  newSerials: number;
  newAsnList: string[];
  prevAsnList: string[];
}

export type PivotEvent = DormancyPivot | InfraMovementPivot;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];

/** Validate one pivot_detected payload; anything unrecognised → null. */
export function parsePivotPayload(payload: unknown, eventId: string | null = null): PivotEvent | null {
  if (!isRecord(payload)) return null;
  const clusterId = str(payload.cluster_id);
  if (!clusterId) return null;
  const clusterName = str(payload.cluster_name);
  if (payload.kind === "dormancy") {
    return { kind: "dormancy", eventId, clusterId, clusterName, asn: str(payload.asn) ?? str(payload.prev_asn) };
  }
  if (payload.kind === "infra_movement") {
    return {
      kind: "infra_movement",
      eventId,
      clusterId,
      clusterName,
      newAsns: num(payload.new_asns),
      newIps: num(payload.new_ips),
      newSerials: num(payload.new_serials),
      newAsnList: strList(payload.new_asn_list),
      prevAsnList: strList(payload.prev_asn_list),
    };
  }
  return null;
}

/**
 * Collect the pivots a run was dispatched for. The coalesced shape is
 * `input.events = [{ id, payload }]`; a run dispatched before coalescing (or
 * manually) carries one payload spread into the input itself. Duplicate
 * cluster+kind pairs are kept once (the latest wins).
 */
export function pivotsFromInput(input: Record<string, unknown>): PivotEvent[] {
  const raw: Array<{ id: string | null; payload: unknown }> = [];
  if (Array.isArray(input.events)) {
    for (const e of input.events) {
      if (isRecord(e)) raw.push({ id: str(e.id), payload: e.payload });
    }
  } else {
    raw.push({ id: null, payload: input });
  }
  const byKey = new Map<string, PivotEvent>();
  for (const r of raw) {
    const p = parsePivotPayload(r.payload, r.id);
    if (p) byKey.set(`${p.kind}:${p.clusterId}`, p);
  }
  return [...byKey.values()];
}

const label = (p: PivotEvent): string => p.clusterName ?? p.clusterId;

/** Max clusters named per kind in the summary line (details carry all). */
export const PIVOT_REPORT_NAMED_MAX = 5;

export interface PivotReport {
  summary: string;
  severity: "high" | "medium";
  details: {
    kind: "pivot_report";
    pivots: number;
    infra_movement: number;
    dormancy: number;
    cluster_ids: string[];
    asns: string[];
    events: PivotEvent[];
  };
}

/** Pure: one operational report covering every pivot in the run. Null when
 *  there is nothing valid to report. */
export function buildPivotReport(pivots: readonly PivotEvent[]): PivotReport | null {
  if (pivots.length === 0) return null;
  const moves = pivots.filter((p): p is InfraMovementPivot => p.kind === "infra_movement");
  const dorm = pivots.filter((p): p is DormancyPivot => p.kind === "dormancy");

  const parts: string[] = [];
  if (moves.length > 0) {
    const named = moves.slice(0, PIVOT_REPORT_NAMED_MAX).map((m) => {
      const growth = [
        m.newAsns > 0 ? `+${m.newAsns} ASN${m.newAsns === 1 ? "" : "s"}${m.newAsnList.length ? ` (${m.newAsnList.join(", ")})` : ""}` : null,
        m.newIps > 0 ? `+${m.newIps} IP${m.newIps === 1 ? "" : "s"}` : null,
        m.newSerials > 0 ? `+${m.newSerials} cert serial${m.newSerials === 1 ? "" : "s"}` : null,
      ].filter((x): x is string => x !== null).join(", ");
      const from = m.prevAsnList.length ? ` from ${m.prevAsnList.join(", ")}` : "";
      return `${label(m)}: ${growth || "new infrastructure"}${from}`;
    });
    const more = moves.length > PIVOT_REPORT_NAMED_MAX ? `; +${moves.length - PIVOT_REPORT_NAMED_MAX} more` : "";
    parts.push(`${moves.length} operation${moves.length === 1 ? "" : "s"} moved infrastructure — ${named.join("; ")}${more}`);
  }
  if (dorm.length > 0) {
    const named = dorm.slice(0, PIVOT_REPORT_NAMED_MAX).map((d) => `${label(d)}${d.asn ? ` (${d.asn})` : ""}`);
    const more = dorm.length > PIVOT_REPORT_NAMED_MAX ? `; +${dorm.length - PIVOT_REPORT_NAMED_MAX} more` : "";
    parts.push(`${dorm.length} cluster${dorm.length === 1 ? "" : "s"} went dormant (activity down >80% in 7d — watch for relocation) — ${named.join("; ")}${more}`);
  }

  const asns = [...new Set(pivots.flatMap((p) =>
    p.kind === "dormancy" ? (p.asn ? [p.asn] : []) : [...p.newAsnList, ...p.prevAsnList],
  ))].sort();

  return {
    summary: `Infrastructure pivots (${pivots.length}): ${parts.join(". ")}.`,
    // New infrastructure under a known operation is actionable now; a
    // dormancy alone is a watch item.
    severity: moves.length > 0 ? "high" : "medium",
    details: {
      kind: "pivot_report",
      pivots: pivots.length,
      infra_movement: moves.length,
      dormancy: dorm.length,
      cluster_ids: [...new Set(pivots.map((p) => p.clusterId))],
      asns,
      events: [...pivots],
    },
  };
}
