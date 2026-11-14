// Static guard: every HTTP handler that returns raw threat rows (which carry
// surbl_* / dbl_* columns) must pass them through withDnsblVerdicts, so a
// blind-era "checked, not listed" stamp is never served as a clean verdict.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (rel: string) => readFileSync(join(__dirname, '..', 'src', rel), 'utf8');

function fnBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, `${name} not found`).toBeGreaterThan(-1);
  const next = source.indexOf('\nexport ', start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

describe('threat-row readers apply the DNSBL verdict rule', () => {
  const cases: Array<[string, string]> = [
    ['handlers/threats.ts', 'handleGetThreat'],
    ['handlers/tenantData.ts', 'handleTenantBrandThreats'],
  ];
  for (const [file, fn] of cases) {
    it(`${file} ${fn}`, () => {
      const body = fnBody(src(file), fn);
      expect(body).toMatch(/FROM threats/);
      expect(body).toContain('withDnsblVerdicts');
    });
  }
});
