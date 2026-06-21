// CampaignGraph — interactive infrastructure graph for a campaign (audit G4).
//
// The Doppel/ZeroFox "threat graph" idea: instead of three disconnected
// tables (providers / IPs / domains), show the campaign's infrastructure as a
// connected node-link diagram so an analyst sees the *shape* of the operation
// — which provider fans out to which IPs, which IPs host which domains, and
// which brands the whole thing targets.
//
// Custom SVG (no graph-lib dependency) in the platform's bespoke-SVG tradition
// (ExposureGauge, donut, ThreatMap). Deterministic radial layout — infra fans
// right (campaign → provider → IP → domain), brands arc left. Nodes are
// CLICKABLE and pivot into the rest of the entity graph:
//   provider → /providers?focus=:id   brand → /brands/:id
//   ip/domain → /threats?q=<indicator>
// Hovering a node highlights its connected edges so dense graphs stay legible.

import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CampaignInfrastructure, CampaignBrandRow } from '@/hooks/useCampaigns';

type NodeType = 'campaign' | 'provider' | 'ip' | 'domain' | 'brand';

interface GNode {
  id: string;
  type: NodeType;
  label: string;
  x: number;
  y: number;
  r: number;
  href?: string;
  title?: string;
}
interface GEdge { from: string; to: string }

const COLORS: Record<NodeType, string> = {
  campaign: 'var(--amber)',
  provider: 'var(--blue)',
  ip: 'var(--text-tertiary)',
  domain: 'var(--sev-high)',
  brand: 'var(--green)',
};

// Keep the graph legible: cap fan-out per tier.
const PROV_MAX = 6;
const IP_PER_PROV = 3;
const DOM_PER_IP = 2;
const BRAND_MAX = 6;

const W = 840;
const H = 720;
const CX = W / 2;
const CY = H / 2;
const R_PROV = 150;
const R_IP = 255;
const R_DOM = 345;
const R_BRAND = 150;

const deg = (d: number) => (d * Math.PI) / 180;
const ptX = (r: number, d: number) => CX + r * Math.cos(deg(d));
const ptY = (r: number, d: number) => CY + r * Math.sin(deg(d));

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Spread `n` items evenly across [lo, hi]; a single item lands at the midpoint.
function spread(n: number, lo: number, hi: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [(lo + hi) / 2];
  const step = (hi - lo) / (n - 1);
  return Array.from({ length: n }, (_, i) => lo + i * step);
}

export function CampaignGraph({
  campaignName,
  accent,
  infrastructure,
  brands,
}: {
  campaignName: string;
  accent: string;
  infrastructure: CampaignInfrastructure;
  brands: CampaignBrandRow[];
}) {
  const navigate = useNavigate();
  const [hovered, setHovered] = useState<string | null>(null);

  const { nodes, edges } = useMemo(() => {
    const nodes: GNode[] = [];
    const edges: GEdge[] = [];

    nodes.push({ id: 'campaign', type: 'campaign', label: truncate(campaignName, 22), x: CX, y: CY, r: 26 });

    const provs = infrastructure.providers.slice(0, PROV_MAX);
    const provAngles = spread(provs.length, -68, 68);

    provs.forEach((p, pi) => {
      const pid = `prov:${p.provider_id}`;
      const pAng = provAngles[pi];
      nodes.push({
        id: pid, type: 'provider', label: truncate(p.provider_name, 16),
        x: ptX(R_PROV, pAng), y: ptY(R_PROV, pAng), r: 12,
        href: `/providers?focus=${encodeURIComponent(p.provider_id)}`,
        title: `${p.provider_name} · ${p.threat_count} threats`,
      });
      edges.push({ from: 'campaign', to: pid });

      const provIps = infrastructure.ips
        .filter(ip => ip.hosting_provider_id === p.provider_id)
        .slice(0, IP_PER_PROV);
      const ipAngles = spread(provIps.length, pAng - 10, pAng + 10);

      provIps.forEach((ip, ii) => {
        const iid = `ip:${ip.ip_address}`;
        const iAng = ipAngles[ii];
        nodes.push({
          id: iid, type: 'ip', label: ip.ip_address,
          x: ptX(R_IP, iAng), y: ptY(R_IP, iAng), r: 7,
          href: `/threats?q=${encodeURIComponent(ip.ip_address)}`,
          title: `${ip.ip_address} · ${ip.domain_count} domains`,
        });
        edges.push({ from: pid, to: iid });

        const ipDomains = infrastructure.domains
          .filter(d => d.ip_address === ip.ip_address && d.domain)
          .slice(0, DOM_PER_IP);
        const domAngles = spread(ipDomains.length, iAng - 5, iAng + 5);

        ipDomains.forEach((d, di) => {
          const did = `dom:${d.domain}`;
          const dAng = domAngles[di];
          nodes.push({
            id: did, type: 'domain', label: d.domain,
            x: ptX(R_DOM, dAng), y: ptY(R_DOM, dAng), r: 4,
            href: `/threats?q=${encodeURIComponent(d.domain)}`,
            title: d.domain,
          });
          edges.push({ from: iid, to: did });
        });
      });
    });

    const topBrands = brands.slice(0, BRAND_MAX);
    const brandAngles = spread(topBrands.length, 116, 244);
    topBrands.forEach((b, bi) => {
      const bid = `brand:${b.id}`;
      const bAng = brandAngles[bi];
      nodes.push({
        id: bid, type: 'brand', label: truncate(b.name, 16),
        x: ptX(R_BRAND, bAng), y: ptY(R_BRAND, bAng), r: 11,
        href: `/brands/${b.id}`,
        title: `${b.name} · ${b.threat_count} threats`,
      });
      edges.push({ from: 'campaign', to: bid });
    });

    return { nodes, edges };
  }, [campaignName, infrastructure, brands]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    nodes.forEach(n => m.set(n.id, n));
    return m;
  }, [nodes]);

  // Edges touching the hovered node (for highlight); when nothing hovered, all
  // edges render at base opacity.
  const isEdgeActive = (e: GEdge) => hovered != null && (e.from === hovered || e.to === hovered);
  const isNodeDimmed = (id: string) => {
    if (hovered == null) return false;
    if (id === hovered) return false;
    return !edges.some(e =>
      (e.from === hovered && e.to === id) || (e.to === hovered && e.from === id),
    );
  };

  if (nodes.length <= 1) return null;

  const LEGEND: Array<[NodeType, string]> = [
    ['provider', 'Provider'],
    ['ip', 'IP'],
    ['domain', 'Domain'],
    ['brand', 'Brand'],
  ];

  return (
    <div className="animate-fade-in">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
        <span className="text-[11px] font-mono" style={{ color: 'var(--text-muted)' }}>
          {infrastructure.providers.length} providers · {infrastructure.ips.length} IPs ·
          {' '}{infrastructure.domains.length} domains{brands.length ? ` · ${brands.length} brands` : ''}
          {' '}— tap a node to highlight, again to pivot
        </span>
        <div className="flex items-center gap-3">
          {LEGEND.map(([t, label]) => (
            <span key={t} className="flex items-center gap-1.5 font-mono text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[t] }} />
              {label}
            </span>
          ))}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{ maxHeight: 560, display: 'block' }}
        role="img"
        aria-label={`Infrastructure graph for campaign ${campaignName}`}
      >
        {/* Edges first so nodes sit on top */}
        <g>
          {edges.map((e, i) => {
            const a = nodeById.get(e.from);
            const b = nodeById.get(e.to);
            if (!a || !b) return null;
            const active = isEdgeActive(e);
            return (
              <line
                key={i}
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={active ? COLORS[b.type] : 'var(--border-base)'}
                strokeWidth={active ? 1.6 : 1}
                strokeOpacity={hovered == null ? 0.35 : active ? 0.9 : 0.08}
                strokeDasharray={active ? '5 4' : undefined}
              >
                {active && (
                  <animate
                    attributeName="stroke-dashoffset"
                    from="9"
                    to="0"
                    dur="0.5s"
                    repeatCount="indefinite"
                  />
                )}
              </line>
            );
          })}
        </g>

        {/* Nodes */}
        <g>
          {nodes.map(n => {
            const dimmed = isNodeDimmed(n.id);
            const color = COLORS[n.type];
            const clickable = !!n.href;
            const showLabel = n.type === 'campaign' || n.type === 'provider' || n.type === 'brand' || n.id === hovered;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                style={{ cursor: clickable ? 'pointer' : 'default', opacity: dimmed ? 0.25 : 1, transition: 'opacity 0.15s' }}
                onMouseEnter={() => setHovered(n.id)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => {
                  if (!n.href) return;
                  // Two-step so touch (no hover) can both reveal + pivot: a
                  // first tap highlights/reveals the label, a second tap (or a
                  // desktop click, where mouseenter already set `hovered`)
                  // navigates.
                  if (hovered === n.id) navigate(n.href);
                  else setHovered(n.id);
                }}
              >
                {n.title && <title>{n.title}</title>}
                {/* Breathing pulse on the focal campaign node. */}
                {n.type === 'campaign' && (
                  <circle r={n.r} fill="none" stroke={accent} strokeWidth={1.5}>
                    <animate attributeName="r" values={`${n.r};${n.r + 22}`} dur="2.6s" repeatCount="indefinite" />
                    <animate attributeName="stroke-opacity" values="0.5;0" dur="2.6s" repeatCount="indefinite" />
                  </circle>
                )}
                <circle
                  r={n.r}
                  fill={n.type === 'campaign' ? accent : `${color}22`}
                  stroke={n.type === 'campaign' ? accent : color}
                  strokeWidth={n.type === 'campaign' ? 2 : 1.5}
                />
                {showLabel && (
                  <text
                    x={0}
                    y={n.r + 11}
                    textAnchor="middle"
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: n.type === 'campaign' ? 12 : 10,
                      fontWeight: n.type === 'campaign' ? 700 : 500,
                      fill: n.type === 'campaign' ? 'var(--text-primary)' : 'var(--text-secondary)',
                      pointerEvents: 'none',
                    }}
                  >
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
