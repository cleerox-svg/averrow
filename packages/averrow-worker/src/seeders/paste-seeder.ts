/**
 * Paste Seeder — Automatically posts "leaked" content to paste sites.
 *
 * Creates realistic-looking data exports containing trap email addresses
 * and posts them to public paste sites where scrapers will harvest them.
 * Rate limited to 5 pastes per day to avoid bans.
 */

import type { Env } from "../types";

const PASTE_SITES = [
  {
    name: "rentry.co",
    postUrl: "https://rentry.co/api/new",
    method: "POST" as const,
    bodyType: "form",
    bodyField: "text",
    responseIdField: "url",
  },
];

export async function executePasteSeeding(env: Env, campaign: { id: number; config: string; target_brands: string }): Promise<{ success: boolean; posted: number }> {
  const config = JSON.parse(campaign.config || "{}") as { addresses?: string[] };
  const addresses = config.addresses || [];

  if (addresses.length === 0) return { success: false, posted: 0 };

  const targetBrands = JSON.parse(campaign.target_brands || "[]") as string[];
  const content = generateLeakedContent(addresses, targetBrands);
  let posted = 0;

  for (const site of PASTE_SITES) {
    try {
      const body = new URLSearchParams();
      body.set(site.bodyField, content);

      const resp = await fetch(site.postUrl, {
        method: site.method,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (resp.ok) {
        const result = await resp.json() as Record<string, string>;
        await env.DB.prepare(
          "UPDATE seed_campaigns SET config = json_set(config, '$.paste_url', ?), addresses_seeded = addresses_seeded + ? WHERE id = ?"
        ).bind(result[site.responseIdField] || "", addresses.length, campaign.id).run();

        posted++;
      }
    } catch (e) {
      console.error(`[PasteSeeder] Failed to post to ${site.name}:`, e);
    }
  }

  return { success: posted > 0, posted };
}

function generateLeakedContent(addresses: string[], _brandTargets: string[]): string {
  const date = new Date().toISOString().split("T")[0];
  const lines = [
    `-- Export ${date} --`,
    `-- Customer contact list --`,
    `name,email,department,status`,
  ];

  const fakeNames = [
    "James Wilson", "Sarah Chen", "Michael Brown", "Emily Davis",
    "Robert Kim", "Jennifer Lee", "David Patel", "Lisa Rodriguez",
    "Thomas Anderson", "Maria Garcia", "Kevin Murphy", "Sandra Wright",
  ];

  const departments = ["Support", "Billing", "Security", "Accounts", "Verification"];

  for (let i = 0; i < addresses.length; i++) {
    const name = fakeNames[i % fakeNames.length];
    const dept = departments[i % departments.length];
    lines.push(`${name},${addresses[i]},${dept},active`);
  }

  return lines.join("\n");
}
