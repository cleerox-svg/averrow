-- Migration 0288: Identity-provider (IdP) impersonation tagging
-- (docs/IDP_IMPERSONATION_PLAN_2026-10.md, task T2).
--
-- Additive only (ADD COLUMN + new indexes; no DROP/ALTER of existing columns).
--
-- threats.impersonated_idp — the abused identity provider (okta, entra,
--   onelogin, auth0, ping, duo, google, generic_sso) for a threat whose
--   `technique` is in the IdP family (lib/idp-impersonation.ts
--   IDP_FAMILY_TECHNIQUES). Kept separate from target_brand_id so the
--   targeted customer brand keeps the attribution credit (owner decision 4).
-- lookalike_domains.idp_lure — the IdP a seeded lookalike permutation lures
--   with (acme-okta.com → okta, acme-helpdesk.com → generic_sso).

ALTER TABLE threats ADD COLUMN impersonated_idp TEXT;
ALTER TABLE lookalike_domains ADD COLUMN idp_lure TEXT;

-- GET /api/intel/identity-threats: `technique IN (family) AND created_at >= ?`
-- range per technique. idx_threats_technique (0205) stays for other readers.
CREATE INDEX IF NOT EXISTS idx_threats_technique_created
  ON threats(technique, created_at);

-- lookalikes_flagged KPI: real detections only — IdP-lure rows that are
-- registered and not benign, dated by first_seen (when registration was
-- observed). Seeded-but-unregistered candidates are never indexed.
CREATE INDEX IF NOT EXISTS idx_lookalike_idp_lure_live
  ON lookalike_domains(first_seen)
  WHERE idp_lure IS NOT NULL AND registered = 1 AND status != 'benign';
