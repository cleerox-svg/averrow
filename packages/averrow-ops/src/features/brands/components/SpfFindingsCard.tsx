// SPF findings — staff view on the brand Surface tab.
//
// Reads the latest email_security_scans row already returned by
// GET /api/email-security/:brandId (spf_lookup_count, spf_walk_status,
// spf_findings — a JSON string). Findings are structured (code + validated DNS
// names + numbers), never record text; names are rendered as plain text.
// Only the confirmed-unregistered include is shown with severity styling:
// everything else is a neutral sentence. Contract: worker email-security.ts
// (SpfFindingCode) and docs/EMAIL_SECURITY_ENGINE.md.

import { Badge, Card } from '@/design-system/components';
import { SectionLabel } from '@/components/ui/SectionLabel';

export const SPF_LOOKUP_LIMIT = 10;

export interface SpfFinding {
  code: string;
  names?: string[];
  count?: number;
  atLeast?: boolean;
}

const KNOWN_CODES: ReadonlySet<string> = new Set([
  'lookup_limit_exceeded', 'void_lookup_limit_exceeded', 'multiple_records', 'include_multiple_records',
  'pass_all', 'include_pass_all', 'neutral_all', 'ptr_mechanism', 'syntax_error', 'include_loop',
  'include_target_missing', 'include_target_unregistered', 'include_target_unverified',
  'walk_incomplete', 'root_lookup_failed',
]);

const NAME_RE = /^[a-z0-9_]([a-z0-9_.-]{0,251}[a-z0-9_])?$/i;

/** Parse the stored JSON column; unknown codes and malformed names are dropped. */
export function parseSpfFindings(raw: unknown): SpfFinding[] {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try { v = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  const out: SpfFinding[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as { code?: unknown; names?: unknown; count?: unknown; atLeast?: unknown };
    if (typeof o.code !== 'string' || !KNOWN_CODES.has(o.code)) continue;
    const f: SpfFinding = { code: o.code };
    if (Array.isArray(o.names)) {
      f.names = o.names.filter((n): n is string => typeof n === 'string' && NAME_RE.test(n)).slice(0, 5);
    }
    if (typeof o.count === 'number' && Number.isFinite(o.count)) f.count = Math.max(0, Math.floor(o.count));
    if (o.atLeast === true) f.atLeast = true;
    out.push(f);
  }
  return out;
}

const WALK_STATUS_LABEL: Record<string, string> = {
  complete: 'Complete',
  unknown: 'Incomplete (could not read the whole tree)',
  no_record: 'No SPF record',
  not_walked: 'Not walked (multiple SPF records)',
  root_error: 'Not checked (DNS lookup failed)',
  carried_legacy: 'Carried from an earlier scan',
};

export function walkStatusLabel(status: unknown): string {
  return typeof status === 'string' && WALK_STATUS_LABEL[status] ? WALK_STATUS_LABEL[status]! : 'Not checked';
}

function nameList(names?: string[]): string {
  return names && names.length > 0 ? ` (${names.join(', ')})` : '';
}

export interface FindingLine {
  key: string;
  text: string;
  critical: boolean;
}

export function describeFinding(f: SpfFinding): FindingLine {
  const names = f.names ?? [];
  const many = names.length > 1;
  const list = names.join(', ');
  switch (f.code) {
    case 'lookup_limit_exceeded':
      return { key: f.code, critical: false, text: `Needs ${f.atLeast ? 'at least ' : ''}${f.count ?? 'more than 10'} DNS lookups, over the limit of ${SPF_LOOKUP_LIMIT}. Some receivers will treat this SPF record as an error.` };
    case 'void_lookup_limit_exceeded':
      return { key: f.code, critical: false, text: `${f.count ?? 'More than 2'} lookups that return nothing, over the limit of 2.` };
    case 'multiple_records':
      return { key: f.code, critical: false, text: `${f.count ?? 'More than one'} SPF records are published at the domain.` };
    case 'include_multiple_records':
      return { key: f.code, critical: false, text: `An include target publishes more than one SPF record${nameList(f.names)}.` };
    case 'pass_all':
      return { key: f.code, critical: false, text: 'The record ends in +all (or a bare all), which passes every sender.' };
    case 'include_pass_all':
      return { key: f.code, critical: false, text: `An included record ends in +all${nameList(f.names)}.` };
    case 'neutral_all':
      return { key: f.code, critical: false, text: 'The record ends in ?all (neutral).' };
    case 'ptr_mechanism':
      return { key: f.code, critical: false, text: `Uses the deprecated ptr mechanism${nameList(f.names)}.` };
    case 'syntax_error':
      return { key: f.code, critical: false, text: `Syntax error${nameList(f.names)}. Ask the domain owner to fix the record.` };
    case 'include_loop':
      return { key: f.code, critical: false, text: `Include loop${nameList(f.names)}. Ask the domain owner to fix the record.` };
    case 'include_target_missing':
      return { key: f.code, critical: false, text: `Include or redirect target has no SPF record or does not exist${nameList(f.names)}.` };
    case 'include_target_unregistered':
      return {
        key: f.code, critical: true,
        text: names.length === 0
          ? 'An include target is not registered. Anyone who registers it can send mail as this domain.'
          : `Include ${many ? 'targets' : 'target'} ${list} ${many ? 'are' : 'is'} not registered. Anyone who registers ${many ? 'one' : 'it'} can send mail as this domain.`,
      };
    case 'include_target_unverified':
      return { key: f.code, critical: false, text: `Could not confirm whether ${names.length ? list : 'an include target'} is registered. Check it manually.` };
    case 'walk_incomplete':
      return { key: f.code, critical: false, text: `The include tree could not be fully checked; ${f.count ?? 0} lookups were counted in the part that was read.` };
    case 'root_lookup_failed':
      return { key: f.code, critical: false, text: 'The SPF record could not be re-checked on this scan; showing the previous result.' };
    default:
      return { key: f.code, critical: false, text: f.code };
  }
}

/** Critical item first, the rest in stored order. */
export function findingLines(findings: SpfFinding[]): FindingLine[] {
  const lines = findings.map(describeFinding);
  return [...lines.filter((l) => l.critical), ...lines.filter((l) => !l.critical)];
}

export interface SpfScanFields {
  spf_walk_status?: string | null;
  spf_lookup_count?: number | null;
  spf_findings?: unknown;
  spf_exists?: number | null;
}

export function SpfFindingsCard({ emailSec }: { emailSec: SpfScanFields | null | undefined }) {
  if (!emailSec) return null;
  const walkStatus = emailSec.spf_walk_status ?? null;
  const findings = parseSpfFindings(emailSec.spf_findings);
  const lines = findingLines(findings);
  const count: number | null = typeof emailSec.spf_lookup_count === 'number' ? emailSec.spf_lookup_count : null;
  const lowerBound = walkStatus === 'unknown' || findings.some((f) => f.atLeast);
  const over = count !== null && count > SPF_LOOKUP_LIMIT;
  const noRecord = walkStatus === 'no_record' || emailSec.spf_exists === 0;

  return (
    <Card>
      <SectionLabel>SPF findings</SectionLabel>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-[12px]">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">DNS lookups</dt>
          <dd className="mt-0.5 font-mono text-[14px] text-[var(--text-primary)]" data-testid="spf-lookups">
            {count === null ? '—' : `${lowerBound ? '≥ ' : ''}${count} of ${SPF_LOOKUP_LIMIT}`}
            {over && <span className="ml-2 text-[11px] text-[var(--text-secondary)]">over limit</span>}
          </dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-tertiary)]">Include check</dt>
          <dd className="mt-0.5 text-[var(--text-primary)]" data-testid="spf-walk">{walkStatusLabel(walkStatus)}</dd>
        </div>
      </dl>

      {lines.length === 0 ? (
        <p className="mt-3 text-[12px] text-[var(--text-secondary)]">
          {noRecord
            ? 'No SPF record, so there is nothing to check.'
            : walkStatus === 'complete'
              ? 'No findings on the latest scan.'
              : walkStatus === null
                ? 'Not checked on the latest scan. Findings appear after the next scan.'
                : 'No findings reported, but the SPF record was not fully checked on this scan.'}
        </p>
      ) : (
        <ul className="mt-3 space-y-2" aria-label="SPF findings">
          {lines.map((l, i) => (
            <li
              key={`${l.key}-${i}`}
              data-critical={l.critical ? 'true' : undefined}
              className="flex flex-wrap items-start gap-2 rounded-md border px-3 py-2 text-[12px] leading-snug"
              style={
                l.critical
                  ? { borderColor: 'var(--sev-critical-border)', background: 'var(--sev-critical-bg)', color: 'var(--text-primary)' }
                  : { borderColor: 'var(--border-base)', color: 'var(--text-secondary)' }
              }
            >
              {l.critical && <Badge severity="critical" dot={false} />}
              <span className="min-w-0 flex-1 break-words">{l.text}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
