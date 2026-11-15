/**
 * Infoblox Threat Intel open indicator data — REFERENCE / CONTEXT only.
 *
 * Source: https://github.com/infobloxopen/threat-intelligence
 * (`indicators/csv/*.csv`, one file per Infoblox publication; columns
 * `type,indicator,classification,detected_date`). Licence: CC BY 4.0
 * (attribution to Infoblox + the licence, indicate changes). Snapshot:
 * docs/licences/infoblox.md.
 *
 * This module holds the pure parts the feed uses (file catalogue, CSV
 * parser, indicator normalisation, per-file cap) and the ONE read-only
 * lookup (`lookupInfobloxReference`), used only by the staff threat detail
 * (`GET /api/threats/:id` → `infoblox_reference`). Nothing here writes, and
 * nothing feeds attribution, scoring, triage, alerts or any tenant /
 * public surface (pinned by test/infoblox-reference.test.ts).
 *
 * The labels are Infoblox's published naming for a DNS threat actor or a
 * campaign (e.g. "VexTrio", "Prolific Puma"). They are Infoblox's label,
 * never an Averrow attribution, and are staff-only by owner default.
 */

import { isUnderSharedHosting } from "./safeDomains";

export const INFOBLOX_RAW_BASE =
  "https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/indicators/csv/";
/** The folder README's publication table (CI-enforced upstream; used only to spot new files). */
export const INFOBLOX_INDEX_URL = `${INFOBLOX_RAW_BASE}README.md`;
export const INFOBLOX_REPO_URL = "https://github.com/infobloxopen/threat-intelligence";
export const INFOBLOX_LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/";

/**
 * CC BY 4.0 §3(a): name the creator, link the licence, say the material was
 * changed. Show this wherever a row is shown.
 */
export const INFOBLOX_CREDIT =
  "Source: Infoblox Threat Intel, infobloxopen/threat-intelligence (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Indicators normalised and subset by Averrow.";

/** Wording for every surface that shows a label. */
export const INFOBLOX_LABEL_NOTE =
  "Infoblox's published label for this indicator, shown as staff context. It is not an Averrow attribution.";

export type InfobloxLabelKind = "actor" | "campaign";

export interface InfobloxFile {
  /** File name under indicators/csv/. */
  file: string;
  /** Infoblox's actor / campaign name for the file (their label, verbatim where they name one). */
  label: string;
  /** 'actor' = Infoblox names a DNS threat actor; 'campaign' = a campaign / topic report. */
  kind: InfobloxLabelKind;
  /** Infoblox publication for the file, when its README links one. */
  publication: string | null;
}

const B = "https://blogs.infoblox.com/cyber-threat-intelligence/";
const T = "https://blogs.infoblox.com/threat-intelligence/";
const W = "https://www.infoblox.com/blog/threat-intelligence/";

/**
 * The files loaded, as listed on 2026-11-15 (folder listing + README table).
 * Order is the load order and the order the total row cap is applied in.
 * Deliberately NOT loaded: `ukraine_russia_legitimate_iocs.csv` and
 * `turkiye_earthquake_legitimate_iocs.csv` (Infoblox lists those domains as
 * LEGITIMATE). A new upstream file is reported as a pull warning until it
 * is added here.
 */
export const INFOBLOX_FILES: readonly InfobloxFile[] = [
  { file: "vextrio_unveiled_20250806.csv", label: "VexTrio", kind: "actor", publication: `${T}vextrios-origin-story-from-spam-to-scam-to-adtech/` },
  { file: "vextrio_cta_20240123_iocs.csv", label: "VexTrio", kind: "actor", publication: `${B}cybercrime-central-vextrio-operates-massive-criminal-affiliate-program` },
  { file: "vextrio_cta_20220606_iocs.csv", label: "VexTrio", kind: "actor", publication: `${B}cyber-threat-advisory/vextrio-ddga-domains-spread-adware-spyware-and-scam-web-forms/` },
  { file: "malicious_adtech_20250612_iocs.csv", label: "VexTrio adtech network", kind: "actor", publication: `${T}vexing-and-vicious-the-eerie-relationship-between-wordpress-hackers-and-an-adtech-cabal/` },
  { file: "prolific_puma_20231031.csv", label: "Prolific Puma", kind: "actor", publication: `${B}prolific-puma-shadowy-link-shortening-service-enables-cybercrime/` },
  { file: "vane_viper_20250912.csv", label: "Vane Viper", kind: "actor", publication: null },
  { file: "vault_viper_20251016.csv", label: "Vault Viper", kind: "actor", publication: null },
  { file: "vigorish_viper_20240722_iocs.csv", label: "Vigorish Viper", kind: "actor", publication: "https://www.infoblox.com/threat-intel/threat-actors/vigorish-viper/" },
  { file: "savvy_seahorse_20240228_iocs.csv", label: "Savvy Seahorse", kind: "actor", publication: `${B}beware-the-shallow-waters-savvy-seahorse-lures-victims-to-fake-investment-platforms-through-facebook-ads/` },
  { file: "hazy_hawk_20250520_iocs.csv", label: "Hazy Hawk", kind: "actor", publication: `${T}cloudy-with-a-chance-of-hijacking-forgotten-dns-records-enable-scam-actor/` },
  { file: "detour_dog_20250930_iocs.csv", label: "Detour Dog", kind: "actor", publication: `${T}detour-dog-dns-malware-powers-strela-stealer-campaigns/` },
  { file: "decoy_dog_cta_20230420_iocs.csv", label: "Decoy Dog", kind: "actor", publication: `${B}cyber-threat-advisory/dog-hunt-finding-decoy-dog-toolkit-via-anomalous-dns-traffic/` },
  { file: "decoy_dog_cta_20230714_iocs.csv", label: "Decoy Dog", kind: "actor", publication: `${B}decoy-dog-is-no-ordinary-pupy-distinguishing-malware-via-dns/` },
  { file: "open_tangle_cta_20231012_iocs.csv", label: "Open Tangle", kind: "actor", publication: `${B}open-tangle-creates-a-phishing-net-for-consumers/` },
  { file: "morphing_meerkat_20250327.csv", label: "Morphing Meerkat", kind: "actor", publication: `${T}a-phishing-tale-of-doh-and-dns-mx-abuse/` },
  { file: "lurking_lizard_20260707_iocs.csv", label: "Lurking Lizard", kind: "actor", publication: `${W}fake-installers-fake-reviews-fake-services-real-proxies-real-victims/` },
  { file: "sable_squirrel_20260813_iocs.csv", label: "Sable Squirrel", kind: "actor", publication: `${W}7-million-in-expired-domains-fuel-a-streaming-empire-with-a-malware-secret/` },
  { file: "help_tds_hotejka_20261015_iocs.csv", label: "Help TDS (Hotejka)", kind: "actor", publication: `${W}inside-help-tds-hotejka-cloudflare-pages-and-predictive-detection/` },
  { file: "omnatuor_cta_20220815_iocs.csv", label: "Omnatuor", kind: "actor", publication: `${B}cyber-threat-advisory/vast-malvertising-network-hijacks-browser-settings-to-spread-riskware/` },
  { file: "keitaro_abuse_20260331.csv", label: "Keitaro TDS abuse", kind: "campaign", publication: `${W}patterns-pirates-and-provider-action-what-we-learned-working-with-keitaro/` },
  { file: "sitting_ducks_20241113_iocs.csv", label: "Sitting Ducks hijacks", kind: "campaign", publication: "https://insights.infoblox.com/resources-research-report/infoblox-research-report-dns-predators-attack-vipers-hawks-hijack-sitting-ducks-domains" },
  { file: "rdga_20240717_iocs.csv", label: "RDGA domains", kind: "campaign", publication: `${T}rdgas-the-next-chapter-in-domain-generation-algorithms/` },
  { file: "suspicious_dga_cta_20230823.csv", label: "Suspicious DGA domains", kind: "campaign", publication: `${B}suspicious-dga-domains-discovered-in-dns-turn-up-in-malware-campaigns/` },
  { file: "banners_bots_butchers_20260217.csv", label: "Banners, Bots and Butchers", kind: "campaign", publication: `${W}banners-bots-and-butchers-an-automated-long-con-targeting-japan-asia-and-beyond/` },
  { file: "abusing_arpa_20260226.csv", label: ".arpa abuse", kind: "campaign", publication: `${W}abusing-arpa-the-tld-that-isnt-supposed-to-host-anything/` },
  { file: "apac_banking_trojan_20260410.csv", label: "APAC banking trojan", kind: "campaign", publication: `${W}scams-slaves-and-malware-as-a-service-tracking-a-trojan-to-cambodias-scam-centers/` },
  { file: "fake_captcha_20260423_iocs.csv", label: "Fake CAPTCHA IRSF", kind: "campaign", publication: `${W}hold-the-phone-international-revenue-share-fraud-driven-by-fake-captchas/` },
  { file: "volta_stealer_20260629_iocs.csv", label: "VoltaStealer", kind: "campaign", publication: "https://infosec.exchange/@InfobloxThreatIntel/116834079630750727" },
  { file: "drop_catch_iii_20260813.csv", label: "Dropcatch scavengers", kind: "campaign", publication: `${W}dropcatch-scavengers-expired-malicious-domains-become-cash-cows/` },
  { file: "casino_peckbirdy_20260915.csv", label: "Casino spam / PeckBirdy", kind: "campaign", publication: `${W}how-money-laundering-scams-and-espionage-hide-in-a-web-full-of-casino-garbage/` },
  { file: "borrowed_reputation_20261026.csv", label: "Borrowed Reputation (domain shadowing)", kind: "campaign", publication: `${W}borrowed-reputation-domain-shadowing-and-gambling-seo/` },
  { file: "decoy_parking_20251216_iocs.csv", label: "Weaponised parked domains", kind: "campaign", publication: `${T}parked-domains-become-weapons-with-direct-search-advertising/` },
  { file: "evilginx_20251201.csv", label: "Evilginx SSO phishing", kind: "campaign", publication: `${T}dns-uncovers-infrastructure-used-in-sso-attacks/` },
  { file: "pig_butchering_20250506_iocs.csv", label: "Pig-butchering (Telegram)", kind: "campaign", publication: `${T}telegram-tango-dancing-with-a-scammer/` },
  { file: "deepfake_crypto_scam_20240917_iocs.csv", label: "Deepfake crypto scam", kind: "campaign", publication: `${T}no-elon-musk-was-not-in-the-us-presidential-debate/` },
  { file: "crowdstrike_lookalike_20240725_iocs.csv", label: "CrowdStrike outage lookalikes", kind: "campaign", publication: `${T}lets-be-careful-out-there/` },
  { file: "usps_cta_20231219.csv", label: "USPS smishing", kind: "campaign", publication: `${B}phishers-weather-the-storm-the-dns-landscape-of-us-postal-smishing-attacks/` },
  { file: "lookalikes_malicious_rmm_ccb_20230131_iocs.csv", label: "Fake-support RMM lookalikes", kind: "campaign", publication: `${B}cyber-campaign-briefs/dont-dial-that-number-distribution-of-phishing-lookalikes-through-fake-support-calls/` },
  { file: "ameli_cta_20221118_iocs.csv", label: "Ameli smishing (France)", kind: "campaign", publication: `${B}cyber-threat-advisory/french-smishing-campaign-uses-fake-social-security-portal/` },
  { file: "metacoin_cta_20221109_iocs.csv", label: "Fake celebrity endorsement scams", kind: "campaign", publication: `${B}cyber-threat-advisory/scams-using-fake-celebrity-endorsements-target-eu-countries/` },
  { file: "emotet_cta_20221006_iocs.csv", label: "Emotet", kind: "campaign", publication: `${B}emotet-a-malware-family-that-keeps-going/` },
  { file: "smishing_cta_20220408_iocs.csv", label: "Smishing (2022)", kind: "campaign", publication: `${B}cyber-threat-advisory/the-smish-is-coming-from-inside-the-house/` },
  { file: "iphone_unlocker_20260514.csv", label: "iPhone unlocker scams", kind: "campaign", publication: null },
  { file: "dcloud_20260625_iocs.csv", label: "dcloud", kind: "campaign", publication: null },
  { file: "cryptdesignbot_cta_20230518_iocs.csv", label: "CryptDesignBot", kind: "campaign", publication: null },
  { file: "c2_beacon_20230414_iocs.csv", label: "C2 beacon (2023)", kind: "campaign", publication: null },
  { file: "olympics_20240729_iocs.csv", label: "Olympics 2024 lures", kind: "campaign", publication: null },
  { file: "turkiye_earthquake_malicious_suspicious_iocs.csv", label: "Turkiye earthquake lures", kind: "campaign", publication: null },
  { file: "ukraine_russia_malicous_suspicious_iocs.csv", label: "Ukraine war lures", kind: "campaign", publication: null },
];

/** Upstream files known and deliberately skipped (legitimate-domain lists). */
export const INFOBLOX_EXCLUDED_FILES: readonly string[] = [
  "ukraine_russia_legitimate_iocs.csv",
  "turkiye_earthquake_legitimate_iocs.csv",
];

/**
 * Classifications that are not a malicious claim: skipped. ('legitimate'
 * rows appear inside otherwise malicious files, e.g. usps / apac.)
 */
export const INFOBLOX_SKIPPED_CLASSIFICATIONS: ReadonlySet<string> = new Set(["legitimate", "unavailable", "other"]);

/** Newest rows kept per file (by detected_date). Larger files are truncated. */
export const INFOBLOX_MAX_ROWS_PER_FILE = 10_000;
/** Total rows kept across all files (applied in INFOBLOX_FILES order). */
export const INFOBLOX_MAX_ROWS_TOTAL = 120_000;
/** Data lines parsed per file before the rest of the file is ignored. */
export const INFOBLOX_MAX_LINES_PER_FILE = 150_000;
/** Largest upstream file was 4.79 MB on 2026-11-15 (malicious_adtech). */
export const INFOBLOX_MAX_FILE_BYTES = 8 * 1024 * 1024;

export type InfobloxIndicatorType = "domain" | "ip";

export interface InfobloxRow {
  indicator: string;
  type: InfobloxIndicatorType;
  classification: string | null;
  detectedDate: string | null;
}

export interface ParsedInfobloxFile {
  /** Kept rows: deduped by indicator, newest first, capped. */
  rows: InfobloxRow[];
  /** Data lines read (≤ INFOBLOX_MAX_LINES_PER_FILE). */
  lines: number;
  /** Lines that were not a valid domain / IP row. */
  malformed: number;
  /** url / sha256 / email / … rows (not loaded). */
  otherTypes: number;
  /** Rows skipped by classification (legitimate / unavailable / other). */
  skippedClass: number;
  /** Valid rows dropped by the per-file cap. */
  capped: number;
  /** True when the file had more lines than INFOBLOX_MAX_LINES_PER_FILE. */
  lineCapped: boolean;
}

const DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9_](?:[a-z0-9_-]{0,62})(?:\.[a-z0-9_](?:[a-z0-9_-]{0,62}))+$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-f:]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/** Undo the defanging Infoblox uses (`[.]`, `(.)`, `[dot]`) and stray BOMs. */
function refang(v: string): string {
  return v
    .replace(/^(﻿|ï»¿|ï»¿)+/, "")
    .replace(/\[\.\]|\(\.\)|\[dot\]/gi, ".")
    .trim();
}

/** Normalise a published domain: refang, lowercase, no trailing dot. */
export function normalizeInfobloxDomain(raw: string): string | null {
  const v = refang(raw).toLowerCase().replace(/\.+$/, "");
  return DOMAIN_RE.test(v) ? v : null;
}

/** Normalise a published IP: refang; IPv4 dotted quad or a lowercased IPv6. */
export function normalizeInfobloxIp(raw: string): string | null {
  const v = refang(raw).toLowerCase();
  if (IPV4_RE.test(v)) return v;
  if (v.includes(":") && IPV6_RE.test(v) && v.length <= 39) return v;
  return null;
}

/** Map an upstream `type` value to ours (ipv4 and ip are both IPs). */
function rowType(t: string): InfobloxIndicatorType | "other" {
  const v = t.trim().toLowerCase();
  if (v === "domain") return "domain";
  if (v === "ip" || v === "ipv4" || v === "ipv6") return "ip";
  return "other";
}

/** Split one CSV line (the files are 4 plain columns; quotes handled defensively). */
function splitCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(",");
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const EXPECTED_HEADER = ["type", "indicator", "classification", "detected_date"];

/**
 * Parse one indicators/csv file. Throws when the header is not the
 * published schema (a changed format must fail the file, not load garbage).
 */
export function parseInfobloxCsv(text: string, maxRows = INFOBLOX_MAX_ROWS_PER_FILE): ParsedInfobloxFile {
  const all = text.split(/\r?\n/);
  const header = splitCsvLine(refang(all[0] ?? "")).map((h) => h.trim().toLowerCase());
  if (EXPECTED_HEADER.some((h, i) => header[i] !== h)) {
    throw new Error(`unexpected header "${(all[0] ?? "").slice(0, 80)}"`);
  }
  const byIndicator = new Map<string, InfobloxRow>();
  let lines = 0;
  let malformed = 0;
  let otherTypes = 0;
  let skippedClass = 0;
  let lineCapped = false;
  for (let i = 1; i < all.length; i++) {
    const line = all[i]!;
    if (line.trim() === "") continue;
    if (lines >= INFOBLOX_MAX_LINES_PER_FILE) { lineCapped = true; break; }
    lines++;
    const cols = splitCsvLine(line);
    if (cols.length < 2) { malformed++; continue; }
    const t = rowType(refang(cols[0] ?? ""));
    if (t === "other") { otherTypes++; continue; }
    const classification = (cols[2] ?? "").trim().toLowerCase().slice(0, 64) || null;
    if (classification && INFOBLOX_SKIPPED_CLASSIFICATIONS.has(classification)) { skippedClass++; continue; }
    const indicator = t === "domain" ? normalizeInfobloxDomain(cols[1] ?? "") : normalizeInfobloxIp(cols[1] ?? "");
    if (!indicator) { malformed++; continue; }
    const d = (cols[3] ?? "").trim();
    const detectedDate = DATE_RE.test(d) ? d.slice(0, 10) : null;
    const prev = byIndicator.get(indicator);
    // Same indicator twice in a file: keep the newest detection.
    if (!prev || (detectedDate ?? "") > (prev.detectedDate ?? "")) {
      byIndicator.set(indicator, { indicator, type: t, classification, detectedDate });
    }
  }
  const sorted = [...byIndicator.values()].sort((a, b) => {
    const da = a.detectedDate ?? "";
    const dbb = b.detectedDate ?? "";
    if (da !== dbb) return da < dbb ? 1 : -1;
    return a.indicator < b.indicator ? -1 : a.indicator > b.indicator ? 1 : 0;
  });
  const cap = Math.max(0, maxRows);
  return {
    rows: sorted.slice(0, cap),
    lines,
    malformed,
    otherTypes,
    skippedClass,
    capped: Math.max(0, sorted.length - cap),
    lineCapped,
  };
}

/** Stem used to compare upstream README names with INFOBLOX_FILES (README links are not exact). */
export function infobloxFileStem(name: string): string {
  return name.toLowerCase().replace(/\.csv$/, "").replace(/_iocs$/, "").replace(/_\d{8}$/, "");
}

/**
 * Data-file names the folder README links that are neither loaded nor
 * excluded (new publications). Pure.
 */
export function unlistedInfobloxFiles(readme: string): string[] {
  const known = new Set([...INFOBLOX_FILES.map((f) => f.file), ...INFOBLOX_EXCLUDED_FILES].map(infobloxFileStem));
  const out = new Set<string>();
  for (const m of readme.matchAll(/\/([A-Za-z0-9_.-]+\.csv)\b/g)) {
    const name = m[1]!;
    if (!known.has(infobloxFileStem(name))) out.add(name);
  }
  return [...out].sort();
}

// ─── Read-only lookup (staff threat detail only) ──────────────────

export interface InfobloxMatch {
  indicator: string;
  indicator_type: InfobloxIndicatorType;
  /** 'exact' = the threat's own domain / IP; 'parent_domain' = a parent of its domain. */
  match: "exact" | "parent_domain";
  /** Infoblox's label (actor or campaign name). */
  infoblox_label: string;
  label_kind: InfobloxLabelKind;
  classification: string | null;
  detected_date: string | null;
  source_file: string;
  publication_url: string | null;
  updated_at: string;
}

export interface InfobloxReferenceView {
  label_note: string;
  credit: string;
  licence_url: string;
  matches: InfobloxMatch[];
}

/** A D1Database or a read session: only `prepare` is used. */
interface Preparer { prepare(sql: string): D1PreparedStatement }

const MAX_PARENT_HOPS = 4;
const LOOKUP_LIMIT = 20;

/**
 * The domain itself, then its parents (≥ 2 labels). A parent that is (or is
 * under) a shared-hosting domain is skipped: `x.pages.dev` must not match a
 * listing of a different `pages.dev` tenant. Pure.
 */
export function infobloxDomainCandidates(domain: string): Array<{ value: string; match: "exact" | "parent_domain" }> {
  const d = normalizeInfobloxDomain(domain);
  if (!d) return [];
  const out: Array<{ value: string; match: "exact" | "parent_domain" }> = [{ value: d, match: "exact" }];
  const labels = d.split(".");
  for (let i = 1; i <= MAX_PARENT_HOPS && labels.length - i >= 2; i++) {
    const parent = labels.slice(i).join(".");
    if (isUnderSharedHosting(parent)) break;
    out.push({ value: parent, match: "parent_domain" });
  }
  return out;
}

/** Host part of a URL, or null. */
function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`).hostname || null;
  } catch {
    return null;
  }
}

/**
 * Live Infoblox reference rows for a threat's domain (exact or parent) or
 * IP, or null when nothing is listed. Read-only; fails soft (missing table,
 * D1 error → null).
 */
export async function lookupInfobloxReference(
  db: Preparer,
  threat: { domain?: string | null; url?: string | null; ip?: string | null },
): Promise<InfobloxReferenceView | null> {
  const candidates = new Map<string, "exact" | "parent_domain">();
  const domain = threat.domain || hostOf(threat.url);
  if (domain) for (const c of infobloxDomainCandidates(domain)) if (!candidates.has(c.value)) candidates.set(c.value, c.match);
  const ip = threat.ip ? normalizeInfobloxIp(threat.ip) : null;
  if (ip) candidates.set(ip, "exact");
  if (candidates.size === 0) return null;
  const keys = [...candidates.keys()];
  try {
    const rows = await db.prepare(
      `SELECT r.indicator, r.indicator_type, r.classification, r.detected_date, r.source_file, r.updated_at,
              f.label, f.label_kind, f.publication_url
         FROM infoblox_reference r
         JOIN infoblox_reference_files f ON f.source_file = r.source_file
        WHERE r.indicator IN (${keys.map(() => "?").join(",")})
          AND r.removed_at IS NULL
        ORDER BY r.detected_date DESC
        LIMIT ${LOOKUP_LIMIT}`,
    ).bind(...keys).all<{
      indicator: string; indicator_type: InfobloxIndicatorType; classification: string | null;
      detected_date: string | null; source_file: string; updated_at: string;
      label: string; label_kind: InfobloxLabelKind; publication_url: string | null;
    }>();
    const matches: InfobloxMatch[] = (rows.results ?? []).map((r) => ({
      indicator: r.indicator,
      indicator_type: r.indicator_type,
      match: candidates.get(r.indicator) ?? "exact",
      infoblox_label: r.label,
      label_kind: r.label_kind,
      classification: r.classification,
      detected_date: r.detected_date,
      source_file: r.source_file,
      publication_url: r.publication_url,
      updated_at: r.updated_at,
    }));
    if (matches.length === 0) return null;
    return { label_note: INFOBLOX_LABEL_NOTE, credit: INFOBLOX_CREDIT, licence_url: INFOBLOX_LICENCE_URL, matches };
  } catch {
    return null;
  }
}
