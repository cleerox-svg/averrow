# MISP Galaxy (threat-actor cluster): licence snapshot

- **Feed:** `actor_reference` (`packages/averrow-worker/src/feeds/actorReference.ts`, migration 0335)
- **Data URL:** https://raw.githubusercontent.com/MISP/misp-galaxy/main/clusters/threat-actor.json
- **Licence URL:** https://github.com/MISP/misp-galaxy/blob/main/LICENSE.md (same text in the README "License" section)
- **Checked:** 2026-11-15 (fetched live, generic User-Agent)
- **Publisher:** MISP Project (CIRCL, Computer Incident Response Center Luxembourg, and contributors)
- **Verdict:** commercial use permitted (CC0 1.0 public-domain dedication, or BSD-2-Clause, at the user's choice)

## Licence text (verbatim, LICENSE.md, opening)

> The MISP galaxy (JSON files) are dual-licensed under:
>
> - [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/legalcode) (CC0 1.0) - Public Domain Dedication.
>
> or
>
> Copyright (c) 2015-2018 Alexandre Dulaunoy - a@foo.be
> Copyright (c) 2015-2018 CIRCL - Computer Incident Response Center Luxembourg
> [...]
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
> 1. Redistributions of source code must retain the above copyright notice, [...]
> 2. Redistributions in binary form must reproduce the above copyright notice, [...]

(The README's copy of the BSD notice carries 2015-2025 dates.)

## File facts at check time

- 1,459,634 bytes, served with `cache-control: max-age=300` and an ETag.
- Galaxy `uuid` 7cdff317-a673-4474-84ec-4f1754947823, `type` threat-actor, `version` 359.
- 1,118 actors, 1,118 distinct uuids; 418 carry `meta.synonyms` (1,429 synonyms); 487 carry `meta.country`; 99 carry `meta.cfr-suspected-state-sponsor`.
- After normalisation: 2,481 alias rows, 2,450 distinct keys, 30 keys shared by more than one actor (e.g. `oilrig`, `mintsandstorm`, `nobelium`, `andariel`). Those resolve to nothing.
- Update cadence: the repository is committed to several times a month (commit API not reachable unauthenticated from the sandbox; cadence not measured). A daily pull is ample.

## What this means for Averrow

- We use the data under CC0: no attribution, notice or share-alike
  obligation. We show `Source: MISP Galaxy threat-actor cluster (MISP
  Project, CC0 1.0)` with the data anyway, so an analyst knows a name came
  from an outside list.
- If we ever relied on the BSD-2-Clause option instead (we do not), any
  redistribution would have to carry the copyright notice above.
- The entries summarise third-party vendor reporting (refs to Mandiant,
  Microsoft, CrowdStrike etc.). Names and country/sponsor fields are vendor
  naming and suspicion, not verified attribution. They must not be shown to
  a customer as Averrow's own attribution without review. Today they are
  staff-only reference data and change nothing a customer sees.
- MITRE ATT&CK group ids appear inside `meta.name-attribution`; that field
  is deliberately not ingested (ATT&CK terms were not reviewed, and the plan
  defers ATT&CK).
