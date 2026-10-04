-- Migration 0275: staff-only alert ownership + notes (PR-C review, owner
-- decision 2026-10-04).
--
-- Alerts are shared rows: the tenant app (/api/orgs/:orgId/alerts,
-- handlers/tenantData.ts) shows status, assigned_to and resolution_notes to
-- the customer. Staff acting through the ops surface (/api/alerts*,
-- handlers/alerts.ts) must never appear to a customer as a named person,
-- must not overwrite the customer's own assignee, and their working notes
-- are internal. So staff writes go to these columns instead:
--
--   staff_assigned_to  users.id of the Averrow staff member handling the
--                      alert (validated isPlatformStaff by the ops PATCH),
--                      NULL = not claimed by staff. Plain TEXT, no FK —
--                      same as alerts.assigned_to (0221).
--   staff_assigned_at  when the staff claim was made (NULL with the above).
--   staff_notes        internal staff note. Never returned by a tenant
--                      route.
--
-- The tenant handlers strip every `staff_*` key and expose only a derived
-- `handled_by_averrow` boolean plus the "Averrow SOC" assignee label (when
-- the customer has no assignee of its own). Status changes made by staff
-- still write the shared `status` / `*_at` columns and remain visible to
-- the customer.
--
-- idx_takedown_requests_alert_source: ops bulk-takedown now links each
-- takedown to its alert (source_type='alert', source_id=alert id) and skips
-- alerts that already have one, so a repeated brand-wide call is
-- idempotent. The partial index serves that NOT EXISTS probe; queries
-- repeat `source_type = 'alert'` verbatim so SQLite can use it.
--
-- Additive only. DEPLOY ORDER: apply BEFORE the Worker — the ops alert
-- list/detail join users on a.staff_assigned_to and the PATCH writes the
-- new columns.

ALTER TABLE alerts ADD COLUMN staff_assigned_to TEXT;
ALTER TABLE alerts ADD COLUMN staff_assigned_at TEXT;
ALTER TABLE alerts ADD COLUMN staff_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_takedown_requests_alert_source
  ON takedown_requests (source_id)
  WHERE source_type = 'alert';
