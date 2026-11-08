/*
 * Homepage hero (G5 H4A): geometry and labels of the fictional operation
 * OP-2291. Shared by the server-rendered SVG poster
 * (components/hero/OperationHero.astro) and the after-paint canvas runner
 * (scripts/hero.ts), so the animation always lands exactly on the poster.
 *
 * Every customer-visible string here is copied from
 * docs/brand/HERO_COPY_2026-11.md (register §3.13, rows H1-H8). Change them
 * there first. Rules that bind this file:
 *   - phishing domains (not lookalikes), RFC 2606 `.example` names;
 *   - infrastructure is hosting + one certificate only: no ASN, no /24,
 *     no registrar, no "serial"; RFC 5737 documentation IPs (the phone
 *     graph drops the IP for "Hosting A" / "Hosting B", as the copy doc
 *     allows when the label doesn't fit);
 *   - the actor is fictional and conditional; social + app are dashed
 *     "related findings", never part of the operation;
 *   - counts add up: 14 domain nodes = "14 phishing domains";
 *     8 taken down + 4 submitted + 2 to approve = 14.
 *
 * Ported from docs/brand/hero-prototype/src/core.js `build()`.
 */

export type Tone = "crit" | "high" | "med" | "low";
export type Kind = "dom" | "host" | "cert" | "soc" | "app";
export type Side = "l" | "r" | "ur" | "lr" | "d";

export interface GNode {
  id: string;
  kind: Kind;
  col: Tone;
  /** Scatter (start) and target (finished) positions. */
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  r: number;
  /** Drift phase and appear time on the story axis (0..4). */
  ph: number;
  ap: number;
  label: string | null;
  sub?: string;
  side: Side;
}

export interface GLink {
  a: string;
  b: string;
  t0: number;
  dur: number;
  /** ev = evidence link, sp = into the operation, rel = related finding (dashed). */
  kind: "ev" | "sp" | "rel";
}

/** Takedown state per domain: removed-at time, or a waiting status. */
export type DomainState = { rm: number } | "submitted" | "approve";

export interface Graph {
  /** Layout space the geometry was designed in (760x620 / 390x340). */
  w: number;
  /** Drawn width: the desktop space gets 40 extra units on the right so the
   *  social and app labels are never clipped. */
  vw: number;
  h: number;
  cp: boolean;
  cx: number;
  cy: number;
  hubR: number;
  nodes: GNode[];
  links: GLink[];
  st: Record<string, DomainState>;
}

export const HUB_TITLE = "Acme payroll sign-in impersonation";
export const HUB_ID = "OP-2291";
export const HUB_SUB = "14 phishing domains";
export const ACTOR_LINE = "Known actor: FX-114 (fictional)";

/** Removal order of the 8 taken-down domains (domain index). */
export const ORDER = [3, 11, 0, 9, 1, 10, 2, 12];
const NAMES: Record<number, string> = {
  1: "acmepay-support.example",
  3: "acme-payroll-login.example",
  11: "acme-hr-portal.example",
};

/** Deterministic PRNG (mulberry32) so server poster and client agree. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Desktop space 760x620 (drawn 800 wide); compact (phone) space 390x340. */
export function build(cp: boolean): Graph {
  const w = cp ? 390 : 760;
  const h = cp ? 340 : 620;
  const sx = cp ? w / 760 : 1;
  const sy = cp ? h / 620 : 1;
  const mg = cp ? 20 : 30;
  const d3: [number, number] = cp ? [w * 0.42, h * 0.6] : [262, 335];
  const rnd = rng(11);
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const P = (x: number, y: number): [number, number] => [x * sx, y * sy];
  const arc = (c: [number, number], r: number, deg: number) => {
    const a = (deg * Math.PI) / 180;
    return P(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r);
  };
  const scatter = (): [number, number] => {
    let x: number;
    let y: number;
    do {
      x = mg + rnd() * (w - (cp ? mg + 95 : 150) - mg);
      y = mg + rnd() * (h * (cp ? 0.86 : 0.8) - 2 * mg);
    } while (!cp && y > d3[1] - 22 && y < d3[1] + 22 && x > d3[0] - 200 && x < d3[0] + 16);
    return [x, y];
  };
  const add = (n: Omit<GNode, "sx" | "sy" | "ph" | "ap">, ap: number) => {
    const s = n.id === "d3" ? d3 : scatter();
    nodes.push({ ...n, sx: s[0], sy: s[1], ph: rnd() * 6.28, ap });
  };

  const A0: [number, number] = [345, 180];
  const A1: [number, number] = [345, 448];
  const hub = P(545, 316);
  const dr = cp ? 4.4 : 6.5;
  const ar = cp ? 5.6 : 8;
  let rank = 0;
  for (let i = 0; i < 14; i++) {
    const p = i < 9 ? arc(A0, 138, 120 + i * 18.75) : arc(A1, 112, 90 + (i - 9) * 37.5);
    const col: Tone = i < 9 ? (i < 5 ? "crit" : "high") : i < 12 ? "crit" : "high";
    add({ id: "d" + i, kind: "dom", col, tx: p[0], ty: p[1], r: dr, label: NAMES[i] ?? null, side: "l" }, i === 3 ? 0.05 : 0.4 + rank++ * 0.045);
  }
  let p = P(A0[0], A0[1]);
  add({ id: "a0", kind: "host", col: "high", tx: p[0], ty: p[1], r: ar, label: cp ? "Hosting A" : "Hosting · 203.0.113.24", side: "ur" }, 1.05);
  p = P(A1[0], A1[1]);
  add({ id: "a1", kind: "host", col: "high", tx: p[0], ty: p[1], r: ar, label: cp ? "Hosting B" : "Hosting · 198.51.100.7", side: "lr" }, 1.12);
  p = P(392, 316);
  add({ id: "c0", kind: "cert", col: "med", tx: p[0], ty: p[1], r: ar, label: "TLS certificate", sub: "shared by 5 domains", side: cp ? "d" : "l" }, 1.2);
  p = P(640, 150);
  add({ id: "s0", kind: "soc", col: "low", tx: p[0], ty: p[1], r: ar, label: "@acme_hr_support", sub: "impersonation account", side: "r" }, 2.45);
  p = P(640, 440);
  add({ id: "p0", kind: "app", col: "low", tx: p[0], ty: p[1], r: ar, label: "Acme Pay", sub: "copycat app", side: "r" }, 2.52);

  let k = 0;
  for (let i = 0; i < 14; i++) links.push({ a: "d" + i, b: i < 9 ? "a0" : "a1", t0: 1.3 + k++ * 0.022, dur: 0.25, kind: "ev" });
  for (const j of [6, 7, 8, 9, 10]) links.push({ a: "d" + j, b: "c0", t0: 1.3 + k++ * 0.022, dur: 0.25, kind: "ev" });
  links.push(
    { a: "a0", b: "hub", t0: 2.25, dur: 0.3, kind: "sp" },
    { a: "a1", b: "hub", t0: 2.3, dur: 0.3, kind: "sp" },
    { a: "c0", b: "hub", t0: 2.35, dur: 0.3, kind: "sp" },
    { a: "s0", b: "hub", t0: 2.6, dur: 0.3, kind: "rel" },
    { a: "p0", b: "hub", t0: 2.68, dur: 0.3, kind: "rel" },
  );

  const st: Record<string, DomainState> = {};
  for (let i = 0; i < 14; i++) {
    const oi = ORDER.indexOf(i);
    st["d" + i] = oi >= 0 ? { rm: 3.3 + oi * 0.07 } : i >= 4 && i <= 7 ? "submitted" : "approve";
  }
  return { w, vw: cp ? w : 800, h, cp, cx: hub[0], cy: hub[1], hubR: cp ? 40 : 68, nodes, links, st };
}

/** Label anchor for a node at (x, y). */
export function labelPos(n: GNode, x: number, y: number): { x: number; y: number; a: "start" | "end" | "middle" } {
  const g = n.r + 8;
  switch (n.side) {
    case "l":
      return { x: x - g, y: y + 4, a: "end" };
    case "r":
      return { x: x + g, y: y - 1, a: "start" };
    case "ur":
      return { x: x + g, y: y - 9, a: "start" };
    case "d":
      return { x, y: y + g + 10, a: "middle" };
    default:
      return { x: x + g - 2, y: y + g, a: "start" };
  }
}

/** Phone layout hides domain, social and app labels (no room at 390). */
export function showsLabel(n: GNode, cp: boolean): boolean {
  return !!n.label && !(cp && (n.kind === "dom" || n.kind === "soc" || n.kind === "app"));
}

/**
 * Hub text placement. On the phone graph the hub is 80px wide, too narrow
 * for "14 phishing domains", so that line sits between the title and the hub.
 */
export function hubText(S: Graph) {
  const { cx, cy, hubR: R, cp } = S;
  return cp
    ? { id: [cx, cy + 4], sub: [cx, cy - R - 9], title: [cx, cy - R - 23], actor: [cx, cy + R + 14] }
    : { id: [cx, cy - 2], sub: [cx, cy + 14], title: [cx, cy - R - 14], actor: [cx, cy + R + 17] };
}

/** End point of a link, trimmed to the hub's edge when it points at the hub. */
export function linkEnd(S: Graph, a: [number, number], b: [number, number], toHub: boolean, p = 1): [number, number] {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const f = toHub ? 1 - S.hubR / (Math.hypot(dx, dy) || 1) : 1;
  return [a[0] + dx * p * f, a[1] + dy * p * f];
}
