import { describe, it, expect } from 'vitest';
import { parseJiraConfig } from '../src/lib/integrations/jira';
import { parseServiceNowConfig } from '../src/lib/integrations/servicenow';

describe('parseJiraConfig', () => {
  it('requires base_url, email, api_token, project_key', () => {
    expect(parseJiraConfig(null)).toBeNull();
    expect(parseJiraConfig({})).toBeNull();
    expect(parseJiraConfig({ base_url: 'https://x.atlassian.net', email: 'a@b.co', api_token: 't' })).toBeNull();
  });

  it('parses a valid config, trims trailing slashes, defaults issue_type', () => {
    const cfg = parseJiraConfig({
      base_url: 'https://acme.atlassian.net/',
      email: 'ops@acme.co',
      api_token: 'tok',
      project_key: 'SEC',
    });
    expect(cfg).not.toBeNull();
    expect(cfg?.base_url).toBe('https://acme.atlassian.net');
    expect(cfg?.project_key).toBe('SEC');
    expect(cfg?.issue_type).toBe('Task');
    expect(cfg?.done_transition_id).toBeUndefined();
  });

  it('passes through issue_type + done_transition_id', () => {
    const cfg = parseJiraConfig({
      base_url: 'https://a.b', email: 'e@f.g', api_token: 't', project_key: 'P',
      issue_type: 'Bug', done_transition_id: '31',
    });
    expect(cfg?.issue_type).toBe('Bug');
    expect(cfg?.done_transition_id).toBe('31');
  });
});

describe('parseServiceNowConfig', () => {
  it('requires instance_url, username, password', () => {
    expect(parseServiceNowConfig(null)).toBeNull();
    expect(parseServiceNowConfig({ instance_url: 'https://x.service-now.com', username: 'u' })).toBeNull();
  });

  it('parses a valid config, trims slash, defaults table to incident', () => {
    const cfg = parseServiceNowConfig({
      instance_url: 'https://acme.service-now.com/',
      username: 'avr',
      password: 'pw',
    });
    expect(cfg?.instance_url).toBe('https://acme.service-now.com');
    expect(cfg?.table).toBe('incident');
  });

  it('passes through a custom table', () => {
    const cfg = parseServiceNowConfig({
      instance_url: 'https://a.b', username: 'u', password: 'p', table: 'sn_si_incident',
    });
    expect(cfg?.table).toBe('sn_si_incident');
  });
});
