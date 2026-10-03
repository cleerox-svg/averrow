// The audit-log CSV export (GET /api/admin/audit/export) quotes every cell
// and neutralises spreadsheet formulas. view_audit (analyst, auditor) can
// now reach it, so a crafted value must not run as a formula in Excel or
// Sheets, and a comma inside a value must not shift the columns.

import { describe, it, expect } from "vitest";
import { csvCell, handleExportAuditLog } from "../src/handlers/audit";
import type { Env } from "../src/types";

describe("csvCell", () => {
  it("quotes plain values and doubles embedded quotes", () => {
    expect(csvCell("login")).toBe('"login"');
    expect(csvCell('{"a":"b"}')).toBe('"{""a"":""b""}"');
  });

  it("renders null and undefined as an empty quoted cell", () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
  });

  it("keeps commas inside the cell", () => {
    expect(csvCell("b_1,b_2,b_3")).toBe('"b_1,b_2,b_3"');
  });

  for (const lead of ["=", "+", "-", "@", "\t", "\r"]) {
    it(`prefixes a cell starting with ${JSON.stringify(lead)}`, () => {
      expect(csvCell(`${lead}HYPERLINK("http://x")`)).toBe(`"'${lead}HYPERLINK(""http://x"")"`);
    });
  }
});

describe("handleExportAuditLog", () => {
  it("emits one aligned row per record with no-store caching", async () => {
    const env = {
      AUDIT_DB: {
        prepare() {
          return {
            bind() {
              return {
                async all() {
                  return {
                    results: [
                      {
                        timestamp: "2026-10-03T00:00:00Z",
                        user_id: "usr_1",
                        action: "brands_bulk_delete",
                        resource_type: "brand",
                        resource_id: "b_1,b_2",
                        outcome: "success",
                        ip_address: "203.0.113.5",
                        details: "=cmd",
                      },
                    ],
                  };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;

    const res = await handleExportAuditLog(new Request("https://averrow.com/api/admin/audit/export"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const lines = (await res.text()).split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(
      '"2026-10-03T00:00:00Z","usr_1","brands_bulk_delete","brand","b_1,b_2","success","203.0.113.5","\'=cmd"',
    );
  });
});
