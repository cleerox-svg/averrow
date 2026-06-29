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

| `org_integrations.type` | Status | File |
|---|---|---|
| `splunk` (HEC) | ✅ live | `src/lib/integrations/splunk.ts` |
| `sentinel` | planned | — |
| `qradar` | planned | — |
| `jira` / `servicenow` (ticketing, compliance) | planned | — |

`DELIVERABLE_INTEGRATION_TYPES` in `lib/integration-delivery.ts` is the source
of truth for which `type`s have a connector. The test-connection endpoint
(`POST /api/orgs/:orgId/integrations/:id/test`) does a **real** live check for
connector-backed types (a synthetic event POST) and falls back to the legacy
"config present → connected" for types without a connector yet.

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
- More connectors: Sentinel, QRadar, then Jira/ServiceNow ticket
  create-on-detection + close-on-resolution (the compliance-record use case).
- Webhook + integration **delivery durability**: retry/backoff + DLQ (the
  `attempts` column + `integration_deliveries` are the foundation).
- A deliveries-read endpoint + UI panel (surface the compliance trail).
- Outbound TAXII server (today STIX is download-only).
