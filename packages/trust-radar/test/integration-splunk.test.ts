import { describe, it, expect } from 'vitest';
import { parseSplunkConfig } from '../src/lib/integrations/splunk';

describe('parseSplunkConfig', () => {
  it('returns null when required fields are missing', () => {
    expect(parseSplunkConfig(null)).toBeNull();
    expect(parseSplunkConfig({})).toBeNull();
    expect(parseSplunkConfig({ hec_url: 'https://x/services/collector' })).toBeNull();
    expect(parseSplunkConfig({ hec_token: 'abc' })).toBeNull();
  });

  it('parses a minimal valid config with a default sourcetype', () => {
    const cfg = parseSplunkConfig({
      hec_url: 'https://hec.example.com/services/collector/event',
      hec_token: 'tok',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.hec_url).toBe('https://hec.example.com/services/collector/event');
    expect(cfg?.hec_token).toBe('tok');
    expect(cfg?.sourcetype).toBe('averrow:event');
    expect(cfg?.index).toBeUndefined();
  });

  it('passes through optional index/source/sourcetype', () => {
    const cfg = parseSplunkConfig({
      hec_url: 'https://h/c',
      hec_token: 't',
      index: 'main',
      source: 'avr',
      sourcetype: 'custom:type',
    });
    expect(cfg?.index).toBe('main');
    expect(cfg?.source).toBe('avr');
    expect(cfg?.sourcetype).toBe('custom:type');
  });

  it('ignores non-string optional fields', () => {
    const cfg = parseSplunkConfig({
      hec_url: 'https://h/c',
      hec_token: 't',
      index: 123 as unknown as string,
    });
    expect(cfg?.index).toBeUndefined();
  });
});
