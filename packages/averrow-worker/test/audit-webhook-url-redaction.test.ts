/**
 * migrations-audit/0002_redact_webhook_urls.sql — historic audit rows.
 *
 * Before #1749, `webhook_config_updated` audit rows stored the full org
 * webhook URL (Slack/Teams/Discord URLs embed their credential). The
 * migration rewrites `details.webhook_url` to the redactWebhookUrl() form.
 *
 * Applies the real audit migrations to an in-memory node:sqlite DB, seeds
 * pre-#1749 shaped rows, runs 0002 twice and checks: no original
 * path/token survives, other details keys and other actions are untouched,
 * the cleanup is itself audited once, and the second run changes nothing.
 * A parity block pins the SQL redaction to the TS helper.
 */
import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { redactWebhookUrl } from "../src/lib/org-public";

type Row = Record<string, unknown>;
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { all(...p: unknown[]): Row[]; run(...p: unknown[]): unknown; get(...p: unknown[]): Row | undefined };
};
const nodeRequire = createRequire(import.meta.url);
let DatabaseSync: (new (path: string) => Db) | null = null;
try {
  DatabaseSync = (nodeRequire("node:sqlite") as { DatabaseSync: new (path: string) => Db }).DatabaseSync;
} catch {
  DatabaseSync = null;
}

const DIR = join(__dirname, "..", "migrations-audit");
const MIGRATION = "0002_redact_webhook_urls.sql";
const sqlOf = (f: string): string => readFileSync(join(DIR, f), "utf8");

function openAuditDb(): Db {
  const db = new DatabaseSync!(":memory:");
  for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort()) {
    if (f >= MIGRATION) break;
    db.exec(sqlOf(f));
  }
  return db;
}

function insert(db: Db, id: string, action: string, details: string | null): void {
  db.prepare(
    `INSERT INTO audit_log (id, user_id, action, resource_type, resource_id, details, ip_address, user_agent, outcome)
     VALUES (?, 'usr_1', ?, 'organization', '42', ?, '203.0.113.9', 'UA/1', 'success')`,
  ).run(id, action, details);
}

const SECRETS = {
  slack: "https://hooks.slack.com/services/T0SLACK/B0SLACK/xoxSlackSecretToken",
  teams: "https://contoso.webhook.office.com/webhookb2/aaaa-teams-guid@bbbb/IncomingWebhook/TEAMSSECRET/cccc",
  discord: "https://discord.com/api/webhooks/123456789/DiscordSecretToken_xyz",
  userinfo: "https://user:pa55word@hooks.example.co.uk:8443/path/SECRETPATH?token=QUERYSECRET#frag",
  tenantSubdomain: "https://tokensubdomain123.m.pipedream.net/hook",
  noScheme: "hooks.slack.com/services/T0X/B0X/NoSchemeSecret",
  uppercase: "HTTPS://Hooks.Slack.COM/services/T0U/B0U/UpperSecret",
  backslash: "https://hooks.slack.com\\services\\T0B\\BackslashSecret",
  // Review findings — each must end up "[redacted]" or host-only.
  otherScheme: "secrettoken://hooks.slack.com/x",
  alphaPort: "https://token123:secret.host.com/x",
  slashInPassword: "https://SECRETUSER:p/ss@hooks.slack.com/a",
  hashInPassword: "https://HASHTOKEN:x#@hooks.slack.com/a",
  longOctet: "https://1234567890.1.2.3/x",
  longOctet2: "https://7654321.1.1.1/x",
  fakeIpv6: "https://[deadbeefcafe0123456789]/x",
  fakeEllipsis: "https://…ELLIPSISTOKEN/x",
  whitespace: "  https://hooks.slack.com/services/T0WS/B0WS/WhitespaceSecret \n",
  pctInHost: "https://hooks.slack.com%2Fservices%2FPCTSECRET/x",
  multiAt: "https://ATUSERONE@ATUSERTWO@hooks.slack.com/services/ATSECRET",
  ipv6Zone: "https://[fe80::1%25ZONESECRET]/x",
} as const;

/** Expected migration output per fixture. */
const EXPECTED: Record<keyof typeof SECRETS, string> = {
  slack: "https://…slack.com/…",
  teams: "https://…office.com/…",
  discord: "https://discord.com/…",
  userinfo: "https://…example.co.uk/…",
  tenantSubdomain: "https://…pipedream.net/…",
  noScheme: "[redacted]",
  uppercase: "https://…slack.com/…",
  backslash: "https://…slack.com/…",
  otherScheme: "[redacted]",
  alphaPort: "[redacted]",
  slashInPassword: "[redacted]",
  hashInPassword: "[redacted]",
  longOctet: "[redacted]",
  longOctet2: "[redacted]",
  fakeIpv6: "[redacted]",
  fakeEllipsis: "[redacted]",
  whitespace: "https://…slack.com/…",
  pctInHost: "[redacted]",
  multiAt: "https://…slack.com/…",
  ipv6Zone: "[redacted]",
};

const TOKENS = [
  "T0SLACK", "xoxSlackSecretToken", "teams-guid", "TEAMSSECRET", "DiscordSecretToken_xyz", "123456789",
  "pa55word", "user:", "SECRETPATH", "QUERYSECRET", "frag", "8443", "tokensubdomain123",
  "NoSchemeSecret", "UpperSecret", "BackslashSecret", "/services", "/api/",
  "secrettoken", "token123", "secret.host", "SECRETUSER", "HASHTOKEN", "1234567890", "7654321",
  "deadbeefcafe", "ELLIPSISTOKEN", "WhitespaceSecret", "%2F", "PCTSECRET", "ATUSERONE", "ATUSERTWO",
  "ATSECRET", "ZONESECRET", "fe80",
].map((t) => t.toLowerCase());

function seed(db: Db): void {
  for (const [k, url] of Object.entries(SECRETS)) {
    insert(db, `wh_${k}`, "webhook_config_updated", JSON.stringify({ webhook_url: url, webhook_events: ["alert.created"] }));
  }
  // Already redacted by #1749 — must be left byte-for-byte.
  insert(db, "wh_done", "webhook_config_updated", JSON.stringify({ webhook_url: "https://…slack.com/…", webhook_events: ["x"] }));
  insert(db, "wh_done_cc", "webhook_config_updated", JSON.stringify({ webhook_url: "https://…bar.co.uk/…" }));
  insert(db, "wh_done_fallback", "webhook_config_updated", JSON.stringify({ webhook_url: "[redacted]" }));
  // Cleared / unchanged / no credential.
  insert(db, "wh_null", "webhook_config_updated", JSON.stringify({ webhook_url: null, webhook_events: ["a"] }));
  insert(db, "wh_absent", "webhook_config_updated", JSON.stringify({ webhook_events: ["a"] }));
  insert(db, "wh_empty", "webhook_config_updated", JSON.stringify({ webhook_url: "" }));
  insert(db, "wh_details_null", "webhook_config_updated", null);
  // Non-string value (pre-#1749 body was not type-checked).
  insert(db, "wh_object", "webhook_config_updated", JSON.stringify({ webhook_url: { u: SECRETS.slack } }));
  // Malformed JSON for the action (not producible by lib/audit.ts).
  insert(db, "wh_malformed", "webhook_config_updated", `{"webhook_url": "${SECRETS.discord}"`);
  // Other actions with url-ish keys — out of scope, must not change.
  insert(db, "other_url", "takedown_create", JSON.stringify({ target_value: "https://phish.example/login?x=1", url: SECRETS.slack }));
  insert(db, "other_webhook_key", "integration_created", JSON.stringify({ webhook_url: SECRETS.slack }));
  insert(db, "other_malformed", "login", "{not json");
}

const all = (db: Db): Row[] => db.prepare("SELECT * FROM audit_log ORDER BY id").all();
const detailsOf = (db: Db, id: string): Record<string, unknown> =>
  JSON.parse(String(db.prepare("SELECT details FROM audit_log WHERE id = ?").get(id)?.details));

describe.skipIf(!DatabaseSync)("audit migration 0002 — webhook URL redaction", () => {
  it("redacts every credential-bearing webhook_url, keeps the rest, and is idempotent", () => {
    const db = openAuditDb();
    seed(db);
    const before = all(db);

    db.exec(sqlOf(MIGRATION));
    const afterFirst = all(db);
    db.exec(sqlOf(MIGRATION));
    const afterSecond = all(db);

    // Second run is a no-op (including the audit record row).
    expect(afterSecond).toEqual(afterFirst);

    // Expected redacted forms.
    for (const [k, want] of Object.entries(EXPECTED)) {
      expect(detailsOf(db, `wh_${k}`).webhook_url, k).toBe(want);
    }
    expect(detailsOf(db, "wh_object").webhook_url).toBe("[redacted]");
    // Original length recorded alongside the marker.
    expect(detailsOf(db, "wh_slack").webhook_url_original_length).toBe(SECRETS.slack.length);

    // Other details keys preserved; rewritten rows are marked.
    for (const k of Object.keys(SECRETS)) {
      const d = detailsOf(db, `wh_${k}`);
      expect(d.webhook_events).toEqual(["alert.created"]);
      expect(d.webhook_url_redacted_by).toBe("0002_redact_webhook_urls");
    }

    // Malformed details replaced whole.
    expect(detailsOf(db, "wh_malformed")).toEqual({
      webhook_url: "[redacted]", details_unparseable: 1, webhook_url_redacted_by: "0002_redact_webhook_urls",
    });

    // No original token anywhere in a webhook_config_updated row.
    const webhookRows = afterSecond.filter((r) => r.action === "webhook_config_updated");
    for (const r of webhookRows) {
      const d = String(r.details).toLowerCase();
      for (const t of TOKENS) expect(d, `${r.id} leaks ${t}`).not.toContain(t);
    }

    // Untouched rows: already-redacted, null/absent/empty, other actions.
    const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));
    const b = byId(before);
    const a = byId(afterSecond);
    for (const id of [
      "wh_done", "wh_done_cc", "wh_done_fallback", "wh_null", "wh_absent", "wh_empty", "wh_details_null",
      "other_url", "other_webhook_key", "other_malformed",
    ]) {
      expect(a.get(id), id).toEqual(b.get(id));
    }
    // Non-details columns untouched on rewritten rows.
    for (const k of Object.keys(SECRETS)) {
      const { details: _d1, ...restBefore } = b.get(`wh_${k}`)!;
      const { details: _d2, ...restAfter } = a.get(`wh_${k}`)!;
      expect(restAfter).toEqual(restBefore);
    }

    // The cleanup is itself audited, exactly once, with the real count.
    const marks = afterSecond.filter((r) => r.action === "audit_redaction_applied");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({
      resource_type: "audit_log", resource_id: "webhook_config_updated", outcome: "success", user_id: null,
    });
    const md = JSON.parse(String(marks[0].details));
    expect(md.migration).toBe("0002_redact_webhook_urls");
    // every fixture URL + the object value + the malformed row.
    expect(md.rows_redacted).toBe(Object.keys(SECRETS).length + 2);
    expect(afterSecond.length).toBe(before.length + 1);
  });

  const PARITY_URLS = [
    SECRETS.slack, SECRETS.teams, SECRETS.discord, SECRETS.userinfo, SECRETS.tenantSubdomain, SECRETS.uppercase,
    SECRETS.whitespace, SECRETS.multiAt, SECRETS.backslash,
    "https://outlook.office.com/webhook/abc/IncomingWebhook/def/ghi",
    "https://discordapp.com/api/webhooks/1/x",
    "https://a.b.example.com.au/x",
    "https://example.co.uk/x",
    "https://foo.example.de/x",
    "https://under_score.hooks.example.com:443/x",
    "http://203.0.113.5:8080/hook?k=v",
    "http://0.0.0.0/x",
    "https://[2001:db8::1]:8443/hook",
    "https://[::1]/hook",
    "https://localhost/hook",
    "https://hooks.slack.com",
  ];

  it("matches redactWebhookUrl() for well-formed URLs (SQL ↔ TS parity)", () => {
    const db = openAuditDb();
    PARITY_URLS.forEach((u, i) => insert(db, `p${i}`, "webhook_config_updated", JSON.stringify({ webhook_url: u })));
    db.exec(sqlOf(MIGRATION));
    PARITY_URLS.forEach((u, i) => {
      expect(detailsOf(db, `p${i}`).webhook_url, u).toBe(redactWebhookUrl(u));
    });
  });

  it("leaves every post-#1749 value (redactWebhookUrl output) unchanged and unstamped", () => {
    const db = openAuditDb();
    const stored = PARITY_URLS.map((u) => redactWebhookUrl(u));
    stored.forEach((v, i) => insert(db, `f${i}`, "webhook_config_updated", JSON.stringify({ webhook_url: v, webhook_events: ["e"] })));
    const before = all(db);
    db.exec(sqlOf(MIGRATION));
    const after = all(db).filter((r) => r.action === "webhook_config_updated");
    expect(after).toEqual(before);
    const mark = all(db).find((r) => r.action === "audit_redaction_applied");
    expect(JSON.parse(String(mark?.details)).rows_redacted).toBe(0);
  });

  it("re-redacts the TS outputs it does not accept as fixed points (trailing dot, punycode)", () => {
    const db = openAuditDb();
    const tsOut = [
      redactWebhookUrl("https://hooks.slack.com./services/T/B/X"),
      redactWebhookUrl("https://hooks.bücher.example/x"),
    ];
    expect(tsOut).toEqual(["https://…com./…", "https://…xn--bcher-kva.example/…"]);
    tsOut.forEach((v, i) => insert(db, `t${i}`, "webhook_config_updated", JSON.stringify({ webhook_url: v })));
    db.exec(sqlOf(MIGRATION));
    tsOut.forEach((_, i) => {
      const d = detailsOf(db, `t${i}`);
      expect(d.webhook_url).toBe("[redacted]");
      expect(d.webhook_url_redacted_by).toBe("0002_redact_webhook_urls");
    });
  });

  it("over-redacts (never under-redacts) inputs it cannot parse like the TS helper", () => {
    const urls = [
      "https://hooks.slack.com./services/T/B/X",   // trailing-dot host
      "https://xn--bcher-kva.example/x",            // punycode
      "https://bücher.example/x",                   // raw IDN
      "https:hooks.slack.com/services/T/B/X",       // no '//'
      "file:///etc/passwd",                         // other scheme, empty host
      "https://[not-ipv6/x",                        // broken bracket
      "https://[1:2:3:4:5:6:7:8:9]/x",             // too many groups
      "https://[1::2::3]/x",                        // two '::'
      "https://[::ffff:1.2.3.4]/x",                 // embedded IPv4
      "https://256.1.1.1/x",                        // octet > 255
      "https://010.1.1.1/x",                        // leading zero
      "https://1.2.3/x",                            // WHATWG IPv4 shorthand
      "https://example.0x1f/x",                     // hex last label
      "https://hooks.slack.com:99999/x",            // port > 65535
      "https://hooks.slack.com:123456/x",           // port > 5 digits
      "https://…slack.com/extra",                   // '…' but not the exact form
      "https://…a.b.slack.com/…",                   // '…' with more labels than kept
      "HTTPS://…slack.com/…",                       // '…' form but not as written by TS
    ];
    const db = openAuditDb();
    urls.forEach((u, i) => insert(db, `o${i}`, "webhook_config_updated", JSON.stringify({ webhook_url: u })));
    db.exec(sqlOf(MIGRATION));
    urls.forEach((u, i) => expect(detailsOf(db, `o${i}`).webhook_url, u).toBe("[redacted]"));
  });

  it("output is always redactWebhookUrl(input) or [redacted] (header-comment claim)", () => {
    const urls = [...Object.values(SECRETS), ...PARITY_URLS];
    const db = openAuditDb();
    urls.forEach((u, i) => insert(db, `c${i}`, "webhook_config_updated", JSON.stringify({ webhook_url: u })));
    db.exec(sqlOf(MIGRATION));
    urls.forEach((u, i) => {
      const got = detailsOf(db, `c${i}`).webhook_url;
      expect([redactWebhookUrl(u), "[redacted]"], u).toContain(got);
    });
  });
});
