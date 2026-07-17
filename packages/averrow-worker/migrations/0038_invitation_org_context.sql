-- Migration 0038: Add organization context to invitations for org-scoped invite flow
ALTER TABLE invitations ADD COLUMN org_id INTEGER REFERENCES organizations(id);
ALTER TABLE invitations ADD COLUMN org_role TEXT DEFAULT 'viewer';

CREATE INDEX IF NOT EXISTS idx_invitations_org ON invitations(org_id);
