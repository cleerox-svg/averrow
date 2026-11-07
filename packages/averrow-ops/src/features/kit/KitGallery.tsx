// Staff /kit gallery (P3-4): the facelift's living reference. Not linked from
// the nav or the command palette; reached by URL only.
//
// Shows the appearance switcher (mode / accent / base, plus "Reset to legacy"),
// live token swatches, the four Kinetic motion moves with replay buttons and a
// reduced-motion simulation, and the design-system component samples. The
// motion kit is a no-op without an accent, so the demos only move once an
// accent is picked here.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCENTS, BASES, readToken, useAppearance, useAppearanceVersion,
  type Accent, type Base, type Theme,
} from '@averrow/shared/theme';
import { NavIndicator, useArrivalFlash, useMotionOn, usePageSlide } from '@averrow/shared/ui';
import { useTheme } from '@/design-system/hooks';
import {
  Badge, Button, Card, DataRow, PageHeader, Tabs, type Severity,
} from '@/design-system/components';

const MODES: Theme[] = ['auto', 'dark', 'light'];
const MODE_LABEL: Record<Theme, string> = { auto: 'System', dark: 'Dark', light: 'Light' };

const SWATCHES = [
  '--bg-page', '--bg-card', '--bg-elevated', '--text-primary', '--text-secondary', '--text-muted',
  '--primary', '--primary-hover', '--primary-text', '--primary-ink', '--focus-ring', '--border-base',
  '--sev-critical', '--sev-high', '--sev-medium', '--sev-low', '--healthy', '--tag-nexus',
] as const;

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h2>
        {action}
      </div>
      {children}
    </Card>
  );
}

function Segmented<T extends string>({ label, options, value, onChange, format }: {
  label: string; options: readonly T[]; value: T | null; onChange: (v: T) => void; format?: (v: T) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-[88px] text-[12px]" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <Button key={o} size="sm" variant={value === o ? 'primary' : 'secondary'} aria-pressed={value === o} onClick={() => onChange(o)}>
            {format ? format(o) : o}
          </Button>
        ))}
      </div>
    </div>
  );
}

function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const { accent, base, setAccent, setBase } = useAppearance();
  return (
    <Section
      title="Appearance"
      action={<Button size="sm" variant="ghost" onClick={() => { setAccent(null); setBase(null); }}>Reset to legacy</Button>}
    >
      <div className="flex flex-col gap-3">
        <Segmented<Theme> label="Mode" options={MODES} value={theme} onChange={setTheme} format={(m) => MODE_LABEL[m]} />
        <Segmented<Accent> label="Accent" options={ACCENTS} value={accent} onChange={setAccent} />
        <Segmented<Base> label="Background" options={BASES} value={base} onChange={setBase} />
        <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }}>
          {accent ? `Accent ${accent}${base ? ` on ${base}` : ''}.` : 'Legacy look: no accent is set, so the motion kit is off.'}
        </p>
      </div>
    </Section>
  );
}

function SwatchSection() {
  const version = useAppearanceVersion();
  const values = useMemo(() => SWATCHES.map((t) => [t, readToken(t)] as const), [version]);
  return (
    <Section title="Tokens">
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
        {values.map(([name, value]) => (
          <div key={name} className="flex items-center gap-2 min-w-0" data-token={name}>
            <span aria-hidden="true" className="shrink-0 rounded-md" style={{ width: 28, height: 28, background: `var(${name})`, boxShadow: 'inset 0 0 0 1px var(--border-strong)' }} />
            <span className="min-w-0">
              <span className="block font-mono text-[11px] truncate" style={{ color: 'var(--text-primary)' }}>{name}</span>
              <span className="block font-mono text-[10px] truncate" style={{ color: 'var(--text-tertiary)' }}>{value || 'not a colour'}</span>
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── motion demos ─────────────────────────────────────────────────────

function Demo({ title, onReplay, children }: { title: string; onReplay: () => void; children: React.ReactNode }) {
  return (
    <div className="rounded-xl p-3" style={{ border: '1px solid var(--border-base)' }}>
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
        <Button size="sm" variant="secondary" onClick={onReplay}>Replay</Button>
      </div>
      {children}
    </div>
  );
}

function ArrivalDemo() {
  const [rows, setRows] = useState<Array<{ id: string; label: string; sev: Severity }>>([
    { id: 'a0', label: 'login-acme.example', sev: 'high' },
  ]);
  const counter = useRef(0);
  const ids = useMemo(() => rows.filter((r) => r.sev === 'critical').map((r) => r.id), [rows]);
  const arrived = useArrivalFlash(ids);
  const add = () => {
    const n = ++counter.current;
    setRows((rs) => [{ id: `c${n}`, label: `acme-verify-${n}.example`, sev: 'critical' as const }, ...rs].slice(0, 4));
  };
  return (
    <Demo title="Critical alert arrival" onReplay={add}>
      <div style={{ border: '1px solid var(--border-base)', borderRadius: 10, overflow: 'hidden' }}>
        {rows.map((r) => (
          <DataRow key={r.id} severity={r.sev} unread className={`flex items-center gap-3 px-3 py-2${arrived.has(r.id) ? ' motion-arrive' : ''}`}>
            <span className="flex-1 font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{r.label}</span>
            <Badge severity={r.sev}>{r.sev}</Badge>
          </DataRow>
        ))}
      </div>
    </Demo>
  );
}

const NAV_DEMO = ['Console', 'Overview', 'Observatory', 'Explorer'];

function NavDemo() {
  const [active, setActive] = useState(0);
  return (
    <Demo title="Gliding nav indicator" onReplay={() => setActive((a) => (a + 1) % NAV_DEMO.length)}>
      <nav className="v4-nav" aria-label="Demo navigation" style={{ padding: 12, overflow: 'visible' }}>
        <NavIndicator activeKey={active} />
        {NAV_DEMO.map((label, i) => (
          <a
            key={label}
            href="#kit"
            className={'v4-item' + (i === active ? ' active' : '')}
            aria-current={i === active ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); setActive(i); }}
          >
            {label}
          </a>
        ))}
      </nav>
    </Demo>
  );
}

const TAB_DEMO = [
  { id: 'brands', label: 'Brands' },
  { id: 'actors', label: 'Threat actors' },
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'providers', label: 'Providers' },
];

function TabsDemo() {
  const [tab, setTab] = useState('brands');
  const next = () => setTab((t) => TAB_DEMO[(TAB_DEMO.findIndex((x) => x.id === t) + 1) % TAB_DEMO.length]!.id);
  return (
    <Demo title="Tab underline morph" onReplay={next}>
      <Tabs variant="underline" tabs={TAB_DEMO} activeTab={tab} onChange={setTab} aria-label="Demo tabs" />
    </Demo>
  );
}

function PageSlideDemo() {
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  usePageSlide(ref, String(page), page);
  return (
    <Demo title="Directional page slide" onReplay={() => setPage((p) => (p + 1) % 3)}>
      <div className="flex gap-2 mb-2">
        <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>Back</Button>
        <Button size="sm" variant="ghost" onClick={() => setPage((p) => Math.min(2, p + 1))} disabled={page === 2}>Forward</Button>
      </div>
      <div style={{ overflow: 'hidden', borderRadius: 10, border: '1px solid var(--border-base)' }}>
        <div ref={ref} className="p-4 text-[13px]" style={{ color: 'var(--text-secondary)' }}>
          Page {page + 1} of 3
        </div>
      </div>
    </Demo>
  );
}

function MotionSection() {
  const motionOn = useMotionOn();
  const [simulateReduced, setSimulateReduced] = useState(false);
  useEffect(() => {
    const root = document.documentElement;
    if (simulateReduced) root.setAttribute('data-motion', 'reduce');
    else root.removeAttribute('data-motion');
    return () => root.removeAttribute('data-motion');
  }, [simulateReduced]);
  return (
    <Section
      title="Motion"
      action={
        <label className="inline-flex items-center gap-2 text-[12px] cursor-pointer" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={simulateReduced} onChange={(e) => setSimulateReduced(e.target.checked)} />
          Simulate reduced motion
        </label>
      }
    >
      <p className="text-[12px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
        {motionOn
          ? 'M1 Precision: 120 / 160 / 200 ms on ease-standard. Reduced motion fades only: no travel, no loops.'
          : 'Motion is off in the legacy look. Pick an accent above to see the moves.'}
      </p>
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))' }}>
        <ArrivalDemo />
        <NavDemo />
        <TabsDemo />
        <PageSlideDemo />
      </div>
    </Section>
  );
}

function ComponentsSection() {
  const [pill, setPill] = useState('all');
  const [bar, setBar] = useState('day');
  return (
    <Section title="Components">
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="danger">Danger</Button>
          <Button variant="ghost">Ghost</Button>
          <Button disabled>Disabled</Button>
        </div>
        <Tabs variant="pills" tabs={[{ id: 'all', label: 'All', count: 42 }, { id: 'open', label: 'Open', count: 7 }, { id: 'closed', label: 'Closed' }]} activeTab={pill} onChange={setPill} aria-label="Pill tabs sample" />
        <Tabs variant="bar" tabs={[{ id: 'day', label: '24h' }, { id: 'week', label: '7d' }, { id: 'month', label: '30d' }]} activeTab={bar} onChange={setBar} aria-label="Bar tabs sample" />
        <div className="flex flex-wrap gap-2">
          {SEVERITIES.map((s) => <Badge key={s} severity={s}>{s}</Badge>)}
          <Badge status="active" pulse>active</Badge>
        </div>
        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))' }}>
          <Card><span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Card</span></Card>
          <Card variant="elevated"><span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Elevated</span></Card>
          <Card variant="active"><span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Active</span></Card>
          <Card variant="critical"><span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>Critical</span></Card>
        </div>
      </div>
    </Section>
  );
}

function LogoSlot() {
  return (
    <Section title="Logo">
      <div
        data-slot="logo"
        className="flex items-center justify-center rounded-xl text-[12px]"
        style={{ height: 96, border: '1px dashed var(--border-strong)', color: 'var(--text-tertiary)' }}
      >
        The R3 mark and lockups land here in P3-5.
      </div>
    </Section>
  );
}

export function KitGallery() {
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Design kit" subtitle="Appearance, tokens, motion and components for the 2026-11 facelift. Staff only." />
      <AppearanceSection />
      <SwatchSection />
      <MotionSection />
      <ComponentsSection />
      <LogoSlot />
    </div>
  );
}
