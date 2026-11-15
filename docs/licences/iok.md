# IOK (Indicator of Kit) ruleset: licence snapshot

- **Use:** phishing-kit rule matching on page captures (`packages/averrow-worker/src/lib/iok-engine.ts`, vendored copy in `packages/averrow-worker/src/data/iok/`, migration 0333)
- **Source:** https://github.com/phish-report/IOK (`indicators/*.yml`), project page https://phish.report/IOK
- **Licence file:** https://github.com/phish-report/IOK/blob/main/LICENSE (copied to `src/data/iok/LICENSE`)
- **Checked:** 2026-11-15 (repository cloned live, commit `142f762aa12994cbd26ddf7d40d40c07ac01bd66`, dated 2025-04-24)
- **Operator:** Phish Report
- **Verdict:** commercial use permitted with credit (ODC Open Database License, ODbL 1.0)

## Licence statement (verbatim, README "License")

> This project is [ODbL](https://github.com/phish-report/IOK/blob/main/LICENSE) licensed.
> You're free to use the rules in your own projects (including commercial ones!)
> as long as you credit [phish.report/IOK](https://phish.report/IOK) as the source.
>
> For more details, read [OpenStreetMap's guidance](https://wiki.openstreetmap.org/wiki/License/Use_Cases) (who also use
> the ODbL license).

The `LICENSE` file is the full "ODC Open Database License (ODbL)" text
(539 lines).

## Terms that bind us (verbatim excerpts from LICENSE)

§4.2 Notices: "If You Publicly Convey this Database, any Derivative
Database, or the Database as part of a Collective Database, then You must:
a. Do so only under the terms of this License or another license permitted
under Section 4.4; b. Include a copy of this License [...] or its Uniform
Resource Identifier (URI) with the Database or Derivative Database [...];
c. Keep intact any copyright or Database Right notices and notices that
refer to this License."

§4.3 Notice for using output: "if you Publicly Use a Produced Work, You must
include a notice associated with the Produced Work reasonably calculated to
make any Person that uses, views, accesses, interacts with, or is otherwise
exposed to the Produced Work aware that Content was obtained from the
Database, Derivative Database, or the Database as part of a Collective
Database, and that it is available under this License." Example notice:
"Contains information from DATABASE NAME, which is made available here under
the Open Database License (ODbL)."

§4.4 Share alike: "a. Any Derivative Database that You Publicly Use must be
only under the terms of: i. This License; [...] c. [...] A Derivative
Database is Publicly Used and so must comply with Section 4.4. if a Produced
Work created from the Derivative Database is Publicly Used."

§4.5 Limits of Share Alike: "b. Using this Database, a Derivative Database,
or this Database as part of a Collective Database to create a Produced Work
does not create a Derivative Database for purposes of Section 4.4; and
c. Use of a Derivative Database internally within an organisation is not to
the public and therefore does not fall under the requirements of Section
4.4."

§4.6 Access to Derivative Databases: "If You Publicly Use a Derivative
Database or a Produced Work from a Derivative Database, You must also offer
to recipients of the Derivative Database or Produced Work a copy in a
machine readable form of: a. The entire Derivative Database; or b. A file
containing all of the alterations made to the Database or the method of
making the alterations to the Database (such as an algorithm) [...]".

§4.7(c): "You may place this Database or a Derivative Database in an
authenticated environment, behind a password, or within a similar access
control scheme provided that You do not alter or restrict the terms of this
License".

## What this means for Averrow

- `src/data/iok/rules.json` is a converted copy of the rules: a Derivative
  Database. It stays under ODbL 1.0. The licence text (`LICENSE`), the source,
  commit and attribution (`SOURCE.md`) sit next to it, and the conversion
  method is in the repository (`scripts/vendor-iok-rules.ts`,
  `scripts/iok-compile.ts`). The ODbL covers that data file, not the Worker
  code around it.
- Credit wherever matches are shown: **"Rules: IOK by phish.report (ODbL)"**.
  The staff detection detail returns it as `captures[].kit_matching.attribution`;
  a UI that renders matches must render it.
- Matches are shown to Averrow staff only (internal use, §4.5c). Showing them
  to tenants or the public is a "Publicly Used" Produced Work: it then needs
  the §4.3 notice with the matches and the §4.6 offer of the converted rules
  (or the conversion scripts). Do not add a tenant or public reader without
  doing both; `test/iok-kit-matches-exposure.test.ts` pins the current readers.
- Do not add our own rules to `rules.json`. Anything put in that file is
  licensed ODbL with it (§4.4d). Averrow-authored rules belong in a separate
  file.
- The converted copy leaves out rule descriptions and references, drops 6 of 266 rules and expands `1 of` / `all of` conditions; titles, ids and match values are unchanged (`src/data/iok/SOURCE.md` lists the alterations).
- A rule match is a signature hit, not a verdict. Matches are context only:
  no alerts, no severity or triage changes, no takedown text.
- This is our reading of the licence, not legal advice. Re-read the upstream
  `LICENSE` and README before each refresh.
