# Averrow "R3 Sharpened + edge": pre-clearance similarity check

**This is not legal advice and not a trademark clearance opinion.** It is an engineering pre-screen to help a trademark lawyer focus. Only a search of the official registers, interpreted by counsel, can clear a mark.

Mark under review: a solid red (#C83C3C) triangular capital "A", leaning forward about 9°, with a notched arrowhead counter and raked swallow-tail feet. Approved final files: `docs/brand/logo/` (the check was run on R3 before its counter was opened slightly; the change moves it further from the closest marks).

## Deliverables (session working files, not committed)
- `contact-r3.png`: R3 next to its 25 closest silhouettes among the 3,467 simple-icons brand logos.
- `contact-current.png`: the same check for today's mark, for reference.
- `contact-targeted.png`: R3 next to hand-collected marks (Avalanche, Adobe, Vercel, Atlassian, Akamai, Aave, Aptos, Arctic Wolf, Aviatrix, Armis), with IoU scores.
- `scores.json`, `targeted_scores.json`: raw scores. Scripts: `raster.js`, `score.py`, `sheet.js`, `lookup.py`.

## 1. Automated shape match
Method:
- Every simple-icons SVG (v-latest, 3,467 logos, CC0) and the Averrow mark were rasterised in Chromium to 128×128 binary masks. Each was cropped to its bounding box, scaled to fit 120 px and centred.
- The Averrow mark was tested at 14 poses: as drawn and mirrored, each rotated −15° to +15° in 5° steps. The best pose was kept for each icon.
- Main metric: IoU (overlap of filled areas). Secondary metrics:
  - symmetric chamfer distance (mean px between outlines, on the best pose);
  - Hu-moment distance. In practice Hu moments were weak and noisy for this kind of shape (they rank a heart and a pin icon as "close"), so they are reported in `scores.json` only.

Baseline: R3's mean IoU across all icons is 0.30, and the 99th percentile is 0.53. Anything above about 0.75 is a genuinely similar silhouette. Even then, silhouette similarity alone does not make marks confusingly similar.

### R3 top 25
| # | Brand | IoU | Chamfer px | Best pose |
|---|---|---|---|---|
| 1 | Radar | 0.757 | 4.02 | mirror 10° |
| 2 | Arch Linux | 0.730 | 3.34 | mirror 10° |
| 3 | Axis Bank | 0.649 | 4.22 | mirror 10° |
| 4 | Vercel | 0.641 | 7.41 | -10° |
| 5 | Ardour | 0.638 | 3.74 | mirror 10° |
| 6 | Elixir | 0.619 | 8.45 | mirror 5° |
| 7 | Atlassian | 0.603 | 6.09 | -5° |
| 8 | Artix Linux | 0.589 | 3.91 | mirror 10° |
| 9 | Slashdot | 0.587 | 4.71 | 0° |
| 10 | Spaceship | 0.586 | 8.24 | -5° |
| 11 | Tinder | 0.586 | 9.43 | 0° |
| 12 | EndeavourOS | 0.580 | 5.24 | 0° |
| 13 | Apache NiFi | 0.572 | 5.99 | -10° |
| 14 | Backblaze | 0.571 | 5.33 | -15° |
| 15 | pino | 0.570 | 4.61 | -10° |
| 16 | Akasa Air | 0.563 | 5.46 | -5° |
| 17 | China Southern Airlines | 0.563 | 6.7 | 10° |
| 18 | Lucid | 0.558 | 5.9 | mirror 0° |
| 19 | Star Trek | 0.553 | 6.83 | -5° |
| 20 | Eclipse Adoptium | 0.552 | 6.51 | mirror 0° |
| 21 | Bulma | 0.552 | 9.05 | mirror 5° |
| 22 | Galaxus | 0.552 | 7.61 | -10° |
| 23 | ReverbNation | 0.550 | 7.55 | -10° |
| 24 | Analogue | 0.548 | 7.91 | 0° |
| 25 | Macy's | 0.545 | 7.7 | mirror 10° |

### Today's mark, top 10 (for reference)
| # | Brand | IoU | Chamfer px | Best pose |
|---|---|---|---|---|
| 1 | Atlassian | 0.830 | 2.67 | 0° |
| 2 | CMake | 0.778 | 3.52 | 0° |
| 3 | Vercel | 0.763 | 5.12 | 0° |
| 4 | pino | 0.719 | 4.56 | 0° |
| 5 | Radar | 0.712 | 4.83 | 0° |
| 6 | Elixir | 0.696 | 7.4 | -5° |
| 7 | Axis Bank | 0.656 | 4.75 | -5° |
| 8 | Tinder | 0.653 | 8.5 | 10° |
| 9 | Artix Linux | 0.642 | 4.68 | 0° |
| 10 | Spaceship | 0.641 | 7.53 | -5° |

**Reading:** R3 is *further* from the well-known triangle/A marks than today's mark is:
- Atlassian: 0.83 to 0.61
- Vercel: 0.76 to 0.64
- CMake: 0.78 to under 0.55

The forward lean and the swallow-tail feet are doing their job. R3's closest silhouettes are Radar (0.76, mirrored arrowhead pointer) and Arch Linux (0.73, mirrored).

Coverage gap: simple-icons does **not** contain Adobe, Avalanche, Aave, Arc'teryx, Aptos, Arista, Arctic Wolf, Abnormal, Armis, Axonius, CrowdStrike, SentinelOne, Sophos or ESET. These were collected by hand (section 2).

## 2. Targeted marks
IoU = best R3 silhouette overlap, where a usable silhouette existed. Risk ratings are a designer's pre-screen of *visual* confusability combined with the trade the owner operates in. They are not legal conclusions.

| Mark | Official image | Similar | Different | Sector / classes | IoU | Risk |
|---|---|---|---|---|---|---|
| **Radar** (Radar Labs) | https://radar.com/ (simple-icons `radar`) | Solid arrowhead/triangle with a notched base. Closest silhouette found | Blue. Symmetric navigation pointer, not a letter. No counter. Mirrored lean | Location/geofencing SaaS, incl. fraud use cases (9/42) | 0.76 | **Low–medium.** Same classes and the closest outline, but it reads as a cursor, not an "A" |
| **Arch Linux** | https://archlinux.org/art/ | Leaning triangular "A"-like peak with a counter and swept feet | Blue. Rounded arch counter and curved, flared feet. Mirrored lean | Open-source OS (9) | 0.73 | **Low–medium.** Concept is close, but it is a community project mark with different curves and colour |
| **Avalanche / AVAX** (Ava Labs) | https://www.avax.network/ (press kit: https://support.avax.network/en/articles/4132288-avalanche-press-kit-and-brand-assets) | **Red** (#E6212F / #E84142) triangular, A-evoking mark | Two separate rounded triangles (large cut triangle plus small one). No counter. Upright | Blockchain software/fintech (9/36/42) | 0.57 | **Medium.** Red, triangle-A and software together. The shape is clearly different |
| **Adobe** | https://www.adobe.com/ (logos:adobe-icon) | Red, a letter "A", and a triangle-shaped crossbar device | Three-piece A made of slabs, square-cut, no lean | Software (9/42). Famous mark | 0.20 | **Low–medium.** Fame plus red A plus the same class. Silhouettes differ strongly |
| **Arctic Wolf** | https://arcticwolf.com/ (mark: https://arcticwolf.com/wp-content/uploads/2021/12/AW_MARK_RV-LOGO_120.png) | Solid triangle reading as an "A", **in security** | Wolf-head knockout, upright, equilateral, white/black | Cybersecurity, MDR (9/42/45) | 0.51 | **Low–medium.** Direct competitor sector, but its distinctive element (the wolf) is absent from R3 |
| **Armis** | https://www.armis.com/ | Triangular peak forming the "A" of the wordmark, in security | Small open triangle inside a wordmark, not a standalone red A | Cyber exposure management (9/42) | 0.56 | **Low** |
| **Aviatrix** | https://aviatrix.ai/ | Chevron "A" with no crossbar, cloud networking/security | Orange rounded strokes, an open chevron rather than a solid form | 9/42 | 0.46 | **Low** |
| **Vercel** | https://vercel.com/geist/brands | Solid triangle | Plain equilateral triangle, black, no letter features | 9/42 | 0.64 | **Low.** A basic geometric shape; R3's notch, lean and feet distinguish it |
| **Atlassian** | https://atlassian.design/foundations/logos | Two-stroke "A", leaning stroke | Blue, two separate rounded strokes | 9/42 | 0.61 | **Low.** Today's mark was closer (0.83) |
| **Alpine** (Renault) | https://www.alpinecars.com/ | Forward-leaning italic "A" with an arrow | Outline A pierced by a horizontal arrow, not solid | Cars (12) | n/a | **Low.** Different class |
| **Acura** | https://www.acura.com/ | Pointed "A" | Caliper "A" in an open ring, silver | Cars (12) | n/a | **Low** |
| **Aave** | https://aave.com/ | n/a | Ghost/arch with dots, purple gradient | DeFi (9/36) | 0.22 | **Low** |
| **Arc'teryx** | https://arcteryx.com/ | n/a | Archaeopteryx fossil | Apparel (25) | n/a | **Low** |
| **Abstergo** (fictional, Ubisoft) | Assassin's Creed franchise | Stylised triangular "A" emblem | Fictional company. Different construction. Ubisoft merchandise marks | 9/16/25/28/41 | n/a | **Low.** Worth noting because gamers associate the triangle-A with it |
| **Aptos** | https://aptosfoundation.org/ | n/a | Circle with horizontal bars | 9/36/42 | 0.27 | **Low** |
| **Arista** | https://www.arista.com/ | "A" with no crossbar | Wordmark only | Networking (9/42) | n/a | **Low** |
| **Anomali** | https://www.anomali.com/ | Crossbar-less A, **threat intelligence** | Thin wordmark, no symbol | 9/42 | n/a | **Low** (watch the word space, not the logo) |
| **Avast** | https://www.avast.com/ | n/a | Orange circle with "a" swirl | Security (9/42) | 0.31* | **Low** |
| **Abnormal Security** | https://abnormal.ai/ | Lambda-style "Λ" for the A | Thin wordmark, no symbol | Email security (9/42) | n/a | **Low** |
| **Axonius / Akamai** | https://www.axonius.com/, https://www.akamai.com/ | n/a | Purple nodes / blue wave with wordmark | 9/42 | –/0.17 | **Low** |
| **Axis Bank** | https://www.axisbank.com/ | Burgundy "A" with a notch, mirrored | Two-piece A, banking | 36 | 0.65 | **Low.** Different class |
| **Astra Security** | https://www.getastra.com/ | n/a | Wordmark "astra" | Pentest (42) | n/a | **Low** |

\* simple-icons version of the mark.

**Is anything a real concern?** No mark found is identical or near-identical. The two worth showing counsel first:
1. **Avalanche.** It is the only *red*, triangle-A, software/tech mark found. Red is not protectable on its own, but colour adds to the overall impression.
2. **Arctic Wolf.** It is a triangle "A" in the same security market.

Radar and Arch Linux are the closest pure silhouettes, but neither is red or reads as a letter A.

## 3. Brief for trademark counsel
**Not legal advice.**

**Registers to search (design/figurative):**
- **CIPO** Canadian Trademarks Database (home market; Vienna codes).
- **USPTO** Trademark Search with design search codes. The USPTO uses its *own* Design Search Code Manual, not Vienna.
- **WIPO Global Brand Database** image search, plus a Vienna-code filter (covers Madrid and many national offices).
- **EUIPO** eSearch / TMview image and Vienna search.
- Optionally UKIPO, and DesignView for registered designs.

**Vienna Classification codes** (checked against the 9th-edition WIPO list, `dl/vie9.pdf`):
- 27.5.1: letters presenting a special form of writing.
  - A 27.5.21: one letter.
  - A 27.5.17: letters in heavy characters.
  - A 27.5.9: letters linked to or containing a figurative element (the arrowhead counter).
- 26.3.1: one triangle.
- *26.3.26: triangles with cutout areas (new in the 9th edition).
- A 26.3.24: triangles with dark surfaces.
- A 26.3.7: triangular figures with truncated angles (the raked feet).
- 26.3.23: lines or bands forming an angle (chevrons/arrowheads).
- 24.15.21: arrowheads.
- Colour code 29.1.1: red (if the mark is filed in colour).

**USPTO design codes** (confirm in the current Design Search Code Manual):
- **26.05.x** triangles. In the USPTO system 26.03 is *ovals*, not triangles.
- **27.03.01** geometric figures forming letters.
- **24.15.x** arrows/arrowheads.
- **29.01.01** red, if claiming colour.

**Nice classes:**
- **9**: downloadable software, SaaS apps.
- **42**: SaaS, threat-intelligence platform, cybersecurity services.
- **45**: security/brand-protection services, takedown services (counsel to confirm the wording).
- Optionally **35**: brand monitoring for others / business information.

Consider filing the mark in **black and white** for the broadest protection, with colour as a separate filing if wanted.

**Specific marks to pull and compare:** Avalanche / Ava Labs (red triangle mark), Arctic Wolf (triangle-wolf mark), Radar Labs (arrowhead), Arch Linux logo, Adobe "A" mark, Armis, Aviatrix "A" chevron, Atlassian, Vercel, Axis Bank. Also search "A"-letter marks in classes 9/42 that combine a triangle with an arrow, and the word mark AVERROW together with the mark.

## Design note: a tweak that adds distance
The nearest silhouettes (Radar, Arctic Wolf, Vercel) are all *solid triangles/arrowheads without a readable counter*. R3's distance comes from three things: the open arrowhead counter, the lean, and the swallow-tail feet. At 16–24 px the counter nearly closes, and R3 collapses toward "red arrowhead".

Suggested tweak: open the counter slightly, for example by moving the apex point at (17.6, 17.5) up about 1–1.5 units, or by widening its base. Also keep the feet's rake at least as deep as now, so the "A" stays legible at small sizes. Avoid rounding the corners, which would move the mark toward Avalanche and Aviatrix, and avoid curving the feet, which would move it toward Arch Linux. Using the mark next to the AVERROW wordmark also strengthens distinctiveness.

## Limits
- simple-icons is biased toward tech/open-source brands and misses many small security vendors.
- IoU ignores colour, context and connotation, which all count in a legal confusion test.
- Web logos were captured on 2026-11-07 and may be outdated.
- None of this replaces a register search.
