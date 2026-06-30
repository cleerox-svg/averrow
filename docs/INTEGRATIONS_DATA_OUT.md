# Integrations — Data-Out Delivery Engine

How Averrow pushes platform events into a customer's own stack
(SIEM / SOAR / ticketing). This is the Tier-2 "feed the customer's systems"
track from `docs/ABUSE_MAILBOX_DIFFERENTIATION_2026-06.md`.

## Pipeline

```
Producer (alert.created, takedown.status_changed, …)
  → emitOrgEvent(env, orgId, eventType, data)   src/lib/org-events.ts
      ├─ deliverWebhook(...)                     src/lib/webhooks.ts  (existing)
      └─ deliverToIntegrations(...)              src/lib/integration-delivery.ts
            • load org_integrations WHERE status='connected' AND type ∈ connectors
            • decrypt config (lib/integration-secret)
            • dispatch to the connector for `type`
            • record an integration_deliveries row (delivered | failed)
```

`emitOrgEvent` is the single fan-out point — producers call it instead of
`deliverWebhook` directly, so every data-out destination is driven from one
place. Both paths are best-effort (`Promise.allSettled`); a failing
destination never blocks the other or the producer.

## Producers wired today
`alert.created` (app-store / social / dark-web monitors), `alert.status_changed`
(tenant data), `takedown.status_changed` (takedowns handler). Adding a producer
= call `emitOrgEvent` instead of `deliverWebhook`.

## Connectors

There are two delivery modes:
- **push** — fire every event at the destination (SIEM).
- **ticketing** — open a ticket on detection, close it on resolution (SOAR /
  compliance record), keyed on the underlying object.

| `org_integrations.type` | Mode | Status | File |
|---|---|---|---|
| `splunk` (HEC) | push | ✅ live | `src/lib/integrations/splunk.ts` |
| `jira` | ticketing | ✅ live | `src/lib/integrations/jira.ts` |
| `servicenow` | ticketing | ✅ live | `src/lib/integrations/servicenow.ts` |
| `sentinel` | push | planned | — |
| `qradar` | push | planned | — |

`DELIVERABLE_INTEGRATION_TYPES` (push), `TICKETING_INTEGRATION_TYPES`, and
their union `CONNECTOR_INTEGRATION_TYPES` in `lib/integration-delivery.ts` are
the source of truth. The test-connection endpoint
(`POST /api/orgs/:orgId/integrations/:id/test`) does a **real** live check for
every connector-backed type (push: synthetic event POST; ticketing: an auth
probe — Jira `GET /myself`, ServiceNow `GET /table?limit=1`) and falls back to
the legacy "config present → connected" for types without a connector yet.

### Ticketing — Jira / ServiceNow (compliance record)
Ticketing connectors open-on-detection / close-on-resolution, keyed on a
**takedown** (v1 scope). Flow: a `takedown.status_changed` event arrives →
the engine reads the takedown's state → if active and no ticket exists, it
**opens** one (Jira issue / ServiceNow incident) and links it in
`integration_tickets`; when the takedown reaches a terminal state
(`taken_down`/`failed`/`expired`/`withdrawn`) it **closes** the linked ticket.
This gives an auditable, externally-visible record of every action in the
customer's own system of record.

Because Sparrow's auto-submit (Phase G) flips status directly in SQL, it now
also emits `takedown.status_changed` so the **auto** takedown path creates
tickets too (not just manual/tenant transitions).

- **Jira** config: `base_url` (`https://co.atlassian.net`), `email`,
  `api_token`, `project_key`, optional `issue_type` (default `Task`),
  optional `done_transition_id`. Uses the v2 REST API; close picks a
  `Done`/`Closed`/`Resolved` transition (or the configured id).
- **ServiceNow** config: `instance_url`, `username`, `password`, optional
  `table` (default `incident`). Close resolves the incident (state 6).
- Link table `integration_tickets` (migration `0230`):
  `(integration_id, source_type, source_id)` UNIQUE → `external_key`,
  `external_url`, `status` (`open`|`closed`).

### Splunk HEC
Config (encrypted on the `org_integrations` row): `hec_url` (full collector
URL, https), `hec_token`, optional `index` / `source` / `sourcetype`
(default `averrow:event`). Delivery POSTs the HEC envelope with
`Authorization: Splunk <token>`. The HEC URL is SSRF-guarded
(`validateOutboundWebhookUrl`: https-only, no internal IPs) and requests use
`redirect: manual`.

## Audit / observability — `integration_deliveries`
Every delivery attempt writes a row (migration `0229`): `integration_id`,
`org_id`, `event_type`, `status`, `http_status`, `error`, `attempts`,
`payload_summary`, `created_at`. This is the **compliance trail** ("we
delivered X to your system at Y") and the foundation for retry/DLQ hardening.
`org_integrations.events_sent` / `last_sync_at` / `last_error` are also
stamped per attempt.

## Adding a connector
1. New `src/lib/integrations/<type>.ts` exporting a `parse<Type>Config` +
   `deliverTo<Type>(cfg, event): Promise<ConnectorResult>`.
2. Add the `type` to `DELIVERABLE_INTEGRATION_TYPES` and a `case` in
   `dispatchToConnector` (`lib/integration-delivery.ts`).
3. SSRF-guard any customer-supplied URL; 10s timeout; `redirect: manual`.
4. Add a `parse<Type>Config` unit test.

## Known gaps (next PRs)
- More push connectors: Sentinel, QRadar (same pattern as Splunk).
- Ticketing v1 covers takedowns; extend to alerts if customers want
  alert-level tickets. Jira close depends on a `Done`/`Closed`/`Resolved`
  transition existing (or `done_transition_id` set).
- Webhook + integration **delivery durability**: retry/backoff + DLQ (the
  `attempts` column + `integration_deliveries` are the foundation).
- A deliveries-read endpoint + UI panel (surface the compliance trail).
- Outbound TAXII server (today STIX is download-only).
