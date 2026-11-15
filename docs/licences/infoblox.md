# Infoblox Threat Intel (infobloxopen/threat-intelligence): licence snapshot

- **Feed:** `infoblox_reference` (`packages/averrow-worker/src/feeds/infobloxReference.ts`, migration 0336)
- **Data URL:** https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/indicators/csv/<file>.csv (one file per Infoblox publication; list in `INFOBLOX_FILES`, `src/lib/infoblox-reference.ts`)
- **Licence URL:** https://raw.githubusercontent.com/infobloxopen/threat-intelligence/main/LICENSE (Creative Commons Attribution 4.0 International, full legal code) and the README's licence paragraph
- **Checked:** 2026-11-15 (README, LICENSE, the folder README and 51 CSV files fetched live from raw.githubusercontent.com with a generic User-Agent; the folder listing read through a page fetch, because the GitHub API and github.com pages are not reachable from the sandbox)
- **Publisher:** Infoblox Threat Intel (Infoblox Inc.)
- **Verdict:** commercial use permitted, with attribution (CC BY 4.0). No share-alike, no non-commercial term.

## Licence text (verbatim, README.md)

> This material is being provided by Infoblox under the Creative Commons CC BY 4.0 license. This license allows you to
> share and adapt the material, in particular to use it for both commercial and non-commercial security purposes, under
> the terms of: attribution to Infoblox and the license. For more details, see the LICENSE file in our repo or visit
> https://creativecommons.org/licenses/by/4.0/

`LICENSE` opens: "Attribution 4.0 International" (the standard CC BY 4.0 legal code).

The `sample-code` folder is GPL-3.0+ per the same README. We use none of it; only the `indicators/csv` data files.

## Obligations (CC BY 4.0 §3(a)) and how we meet them

1. **Identify the creator** ("Infoblox") — in `INFOBLOX_CREDIT`, returned with every match.
2. **Link the licence** — `INFOBLOX_CREDIT` names CC BY 4.0 with the URL; `licence_url` is returned too.
3. **Indicate changes** — we refang, lowercase, dedupe and subset (domain / IP rows only, newest 10,000 per file, non-malicious classifications dropped). `INFOBLOX_CREDIT` says "Indicators normalised and subset by Averrow."
4. **No endorsement implied** (§2(a)(6)) — the label is shown as "Infoblox's published label", never as Infoblox endorsing Averrow.
5. **No additional restrictions** on recipients — not applicable while the data stays staff-only.

Credit text used: `Source: Infoblox Threat Intel, infobloxopen/threat-intelligence (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Indicators normalised and subset by Averrow.`

## File facts at check time

- 51 CSV files in `indicators/csv/` seen (folder listing truncated at about 52 entries; 44 README publication rows, several README links misnamed, e.g. `rdga_20240717.csv` for the real `rdga_20240717_iocs.csv`).
- Header everywhere: `type,indicator,classification,detected_date`. Types seen: domain, ip, ipv4, url, sha256, email, telfhash.
- Some indicators are defanged (`[.]`), some rows carry a mis-encoded BOM (`ï»¿`), two headers carry a real BOM.
- 270,648 data rows in total, 268,998 domain / IP rows after skipping `legitimate` / `unavailable` / `other`. Largest files: `malicious_adtech_20250612_iocs.csv` 4.79 MB / 102,022 rows, `vane_viper_20250912.csv` 2.09 MB / 45,002, `vextrio_cta_20220606_iocs.csv` 1.69 MB / 37,868.
- Two files are lists of LEGITIMATE domains (`ukraine_russia_legitimate_iocs.csv`, `turkiye_earthquake_legitimate_iocs.csv`); they are not loaded.
- `indicators/combined.csv` (1.19 MB, 26,820 rows, rolling last year) carries no campaign label, so it is not used.
- raw.githubusercontent.com serves an ETag and honours If-None-Match. Update cadence (not measured, commit API unreachable): from the README dates, a new publication file every 2 to 6 weeks; old files rarely change.

## What this means for Averrow

- Labels such as "VexTrio" or "Prolific Puma" are Infoblox's naming from its own research. They are not an Averrow attribution and are staff-only by owner default: shown only on the staff threat detail, never in tenant, public or marketing surfaces, alerts, triage, scoring or NEXUS.
- Showing them to customers would need: the credit line above wherever shown, wording that the name is Infoblox's (not Averrow's) finding, an owner decision on vendor naming in customer copy, and a check that no customer page implies Infoblox endorsement.
