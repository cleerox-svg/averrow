import { describe, it, expect } from 'vitest';
import { sentenceCase } from './sentence-case';

describe('sentenceCase', () => {
  it.each([
    ['THREAT ACTORS', 'Threat actors'],
    ['ALL RESULTS', 'All results'],
    ['SOC CONSOLE', 'SOC console'],
    ['ASN LOOKUP', 'ASN lookup'],
    ['dns and ip', 'DNS and IP'],
    ['Intelligence', 'Intelligence'],
    ['', ''],
  ])('%s -> %s', (i, o) => expect(sentenceCase(i)).toBe(o));
});
