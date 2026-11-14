/**
 * Prod DDL of dmarc_report_records — the table predates migrations/ and was
 * copied from prod sqlite_master on 2026-11-10. Migration 0329 recreates it
 * with `IF NOT EXISTS`; test/dmarc-sensor.test.ts pins the
 * migration's columns and indexes against this text.
 */
export const PROD_DMARC_REPORT_RECORDS_DDL = [
  `CREATE TABLE dmarc_report_records (
     id INTEGER PRIMARY KEY AUTOINCREMENT, report_id INTEGER NOT NULL, source_ip TEXT NOT NULL,
     count INTEGER DEFAULT 1, disposition TEXT, dkim_result TEXT, spf_result TEXT, dmarc_result TEXT,
     header_from TEXT, envelope_from TEXT, dkim_domain TEXT, spf_domain TEXT, country_code TEXT,
     city TEXT, lat REAL, lng REAL, asn TEXT, org TEXT,
     FOREIGN KEY (report_id) REFERENCES dmarc_reports(id))`,
  "CREATE INDEX idx_drr_report ON dmarc_report_records(report_id)",
  "CREATE INDEX idx_drr_ip ON dmarc_report_records(source_ip)",
  "CREATE INDEX idx_drr_dmarc_result ON dmarc_report_records(dmarc_result)",
];
