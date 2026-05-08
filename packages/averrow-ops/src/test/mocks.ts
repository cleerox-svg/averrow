import { vi } from 'vitest';

// Mock the API client
export function mockApi() {
  const mock = {
    get: vi.fn().mockResolvedValue({ success: true, data: [] }),
    post: vi.fn().mockResolvedValue({ success: true }),
    patch: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    setTokens: vi.fn(),
    clearTokens: vi.fn(),
    getToken: vi.fn().mockReturnValue('mock-token'),
    onAuthError: vi.fn(),
  };
  vi.doMock('@/lib/api', () => ({ api: mock }));
  return mock;
}

// Mock data factories
export function createMockBrand(overrides = {}) {
  return {
    id: 'brand_test',
    name: 'Test Brand',
    canonical_domain: 'test.com',
    sector: 'tech',
    threat_count: 42,
    email_security_grade: 'B',
    exposure_score: 65,
    monitoring_status: 'active',
    social_risk_score: null,
    last_social_scan: null,
    logo_url: null,
    bimi_grade: 'B',
    bimi_record: null,
    bimi_svg_url: null,
    bimi_vmc_url: null,
    bimi_vmc_valid: null,
    bimi_vmc_expiry: null,
    ...overrides,
  };
}

export function createMockAgent(overrides = {}) {
  return {
    agent_id: 'sentinel',
    name: 'sentinel',
    display_name: 'Sentinel',
    description: 'Certificate & domain surveillance',
    color: '#C83C3C',
    status: 'active',
    schedule: '5m (event)',
    jobs_24h: 20,
    outputs_24h: 284,
    error_count_24h: 0,
    activity: new Array(24).fill(0).map(() => Math.floor(Math.random() * 5)),
    last_run_at: new Date().toISOString(),
    last_run_status: 'success',
    last_run_duration_ms: 400,
    last_run_error: null,
    last_output_at: new Date().toISOString(),
    avg_duration_ms: 350,
    ...overrides,
  };
}

export function createMockTakedown(overrides = {}) {
  return {
    id: 'td-001',
    brand_id: 'brand_test',
    brand_name: 'Test Brand',
    brand_domain: 'test.com',
    target_type: 'url',
    target_value: 'phishing.test.com',
    target_platform: null,
    target_url: 'https://phishing.test.com/login',
    evidence_summary: 'Malicious URL targeting Test Brand',
    evidence_detail: null,
    evidence_urls: null,
    provider_name: 'Cloudflare',
    provider_abuse_contact: 'abuse@cloudflare.com',
    provider_method: 'email',
    status: 'draft',
    severity: 'HIGH',
    priority_score: 70,
    requested_by: null,
    source_type: 'url_scan',
    notes: null,
    evidence_count: 0,
    created_at: new Date().toISOString(),
    submitted_at: null,
    resolved_at: null,
    resolution: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockLead(overrides = {}) {
  return {
    id: 1,
    brand_id: 'brand_test',
    company_name: 'Test Corp',
    company_domain: 'testcorp.com',
    prospect_score: 75,
    pitch_angle: 'email_security_gap',
    email_security_grade: 'F',
    threat_count_30d: 45,
    status: 'new',
    findings_summary: 'Test Corp has significant email security gaps.',
    outreach_variant_1: null,
    outreach_variant_2: null,
    ai_enriched: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function createMockCapture(overrides = {}) {
  return {
    id: 1,
    from_address: 'attacker@evil.com',
    from_domain: 'evil.com',
    subject: 'Urgent: Verify your account',
    spoofed_brand_id: 'brand_test',
    brand_name: 'Test Brand',
    spf_result: 'fail',
    dkim_result: 'none',
    dmarc_result: 'fail',
    category: 'Phishing',
    severity: 'HIGH',
    captured_at: new Date().toISOString(),
    ...overrides,
  };
}
