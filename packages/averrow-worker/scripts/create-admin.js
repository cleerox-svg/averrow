#!/usr/bin/env node
// Trust Radar v2 — Super Admin Bootstrap
// Usage: node scripts/create-admin.js <email> <name> [google_sub]
// Generates wrangler d1 execute commands to seed the first super_admin user.
// The google_sub will be linked automatically on first Google OAuth login if omitted.

const [email, name, googleSub] = process.argv.slice(2);

if (!email || !name) {
  console.error("Usage: node scripts/create-admin.js <email> <name> [google_sub]");
  console.error("  email      — Google account email for the super admin");
  console.error("  name       — Display name");
  console.error("  google_sub — (optional) Google subject ID; linked on first login if omitted");
  process.exit(1);
}

const crypto = require("crypto");
const id = crypto.randomUUID();
const googleSubValue = googleSub ? `'${googleSub}'` : "NULL";

const sql = `INSERT OR IGNORE INTO users (id, google_sub, email, name, role, status) VALUES ('${id}', ${googleSubValue}, '${email}', '${name}', 'super_admin', 'active');`;

console.log("\n── Local (dev) ──────────────────────────────────────────────");
console.log(`npx wrangler d1 execute DB --local --command "${sql}"`);
console.log("\n── Production ───────────────────────────────────────────────");
console.log(`npx wrangler d1 execute DB --remote --command "${sql}"`);
console.log("\nSuper Admin:");
console.log(`  Email:      ${email}`);
console.log(`  Name:       ${name}`);
console.log(`  Role:       super_admin`);
console.log(`  Google Sub: ${googleSub ?? "(will link on first login)"}`);
console.log(`  ID:         ${id}\n`);
