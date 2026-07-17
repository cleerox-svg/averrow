# Data Processing Agreement — Internal Working Draft

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

**Status:** Internal working draft only. This document has NOT been reviewed
by legal counsel, has NOT been approved by any officer of LRX Enterprises
Inc., and must NOT be sent to a customer, posted to the website, linked from
`/privacy`, `/terms`, or `/security`, or otherwise represented as a final or
binding agreement. It is a drafting aid to accelerate legal review — nothing
more.

**Purpose:** to give counsel a plain-language starting point for a customer-
facing Data Processing Agreement ("DPA") between LRX Enterprises Inc.
(operating as "Averrow") and its business customers, consistent with the
facts already published at `/privacy`, `/terms`, and `/security` and with
the actual data-handling practices described in those pages. Wherever this
draft would need a fact, a legal judgment call, or a jurisdiction-specific
decision that only a human (counsel, DPO, or an authorized officer) can
supply, it is marked `[NEEDS HUMAN INPUT: ...]` rather than guessed.

**No fabricated claims.** This draft does not assert any certification the
company does not currently hold. SOC 2 Type I is **scheduled** for Q3 2026
and SOC 2 Type II for Q1 2027 (per `/security`); neither has been completed
as of this draft. Nothing below should be edited to imply otherwise without
an actual audit report in hand.

---

## 0. How to Use This Draft

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

- This draft is scoped to match the facts on `/security` and the existing
  `/privacy` and `/terms` pages (`packages/averrow-worker/src/templates/privacy.ts`,
  `terms.ts`) as of 2026-07-14. If those pages change, this draft will drift
  and needs to be re-checked against them before use.
- Every `[NEEDS HUMAN INPUT: ...]` placeholder must be resolved before this
  document goes anywhere near a customer or a signature block.
- Once counsel finalizes this, it should be tracked as a signed/version-
  controlled contract artifact, not left as a marketing or docs page — this
  file lives in `docs/legal/` specifically because it is an internal
  drafting file, not site content.
- This agreement is drafted as a **standalone DPA** referenced by / attached
  to the master Terms of Service, following common SaaS practice. Counsel
  should confirm whether Averrow prefers a standalone DPA, a DPA exhibit
  appended to the Terms, or click-through acceptance at signup.
  `[NEEDS HUMAN INPUT: confirm DPA execution mechanism — standalone signed
  document, exhibit to Terms, or in-product click-to-accept]`

---

## 1. Parties

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

This Data Processing Agreement ("DPA") is entered into by and between:

- **Processor:** LRX Enterprises Inc., operating the Averrow platform
  ("Averrow", "we", "us", "our"), a company incorporated in
  [NEEDS HUMAN INPUT: confirm province/territory of incorporation — Terms of
  Service names Ontario as the governing-law jurisdiction, but this may or
  may not be the incorporation jurisdiction], with a registered address at
  [NEEDS HUMAN INPUT: legal entity registered address for contract
  execution]; and

- **Controller:** the customer entity identified in the applicable Order
  Form or subscription agreement ("Customer", "Controller", "you").

This DPA applies whenever Averrow processes personal data on Customer's
behalf in the course of providing the Averrow platform under the Terms of
Service.

---

## 2. Definitions

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

- **"Personal Data"** means any information relating to an identified or
  identifiable natural person that Averrow processes on Customer's behalf
  under this DPA.
- **"Processing"** has the meaning given under applicable Data Protection
  Law (e.g., GDPR Art. 4(2)), i.e., any operation performed on Personal
  Data.
- **"Data Protection Law"** means, as applicable to the Personal Data in
  question: the EU General Data Protection Regulation (GDPR), the UK GDPR
  and Data Protection Act 2018, Canada's Personal Information Protection
  and Electronic Documents Act (PIPEDA) and applicable provincial
  equivalents, and any other data protection or privacy law that applies
  to the Processing under this DPA.
  `[NEEDS HUMAN INPUT: confirm the complete list of privacy statutes counsel
  wants named here — e.g., should US state laws (CCPA/CPRA, etc.) be listed
  explicitly if Averrow has customers/data subjects in those states?]`
- **"Sub-processor"** means any third party engaged by Averrow to process
  Personal Data on Averrow's behalf in connection with this DPA.
- **"Data Subject"** means the identified or identifiable natural person to
  whom Personal Data relates.
- **"Security Incident"** means a breach of security leading to the
  accidental or unlawful destruction, loss, alteration, unauthorized
  disclosure of, or access to, Personal Data processed under this DPA.

---

## 3. Roles of the Parties

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

- **Customer is the Controller** (or, where Customer itself processes
  Personal Data on behalf of a third party, a processor acting on behalf of
  that third-party controller) with respect to Personal Data submitted to
  or processed by the Averrow platform, including account/user data and any
  Personal Data that may appear incidentally within scan targets, monitored
  domains, or threat-intelligence results.
- **Averrow is the Processor** (or, in GDPR terms, may also act as a
  processor's sub-processor where Customer itself is a processor) and
  processes Personal Data only:
  - to provide the Averrow platform per the Terms of Service and applicable
    Order Form;
  - on Customer's documented instructions (this DPA, the Terms of Service,
    and Customer's configuration of the platform constitute those
    instructions); and
  - as required by applicable law, in which case Averrow will inform
    Customer of that legal requirement before processing, unless the law
    prohibits such notice.
- Averrow does not sell Personal Data and does not process Personal Data
  for purposes other than providing and improving the Averrow platform, as
  described in the Privacy Policy.

`[NEEDS HUMAN INPUT: confirm whether Averrow ever acts as an independent
controller for any category of data (e.g., aggregated/de-identified threat
intelligence, platform usage analytics) — if so, that should be carved out
explicitly rather than left ambiguous under "processor."]`

---

## 4. Scope, Nature, and Purpose of Processing

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

**Subject matter:** Averrow's provision of brand/threat intelligence
monitoring services (domain scanning, impersonation detection, phishing
analysis, social-media monitoring, and threat-feed matching) as described in
the Terms of Service.

**Duration:** for the term of the underlying subscription/Order Form, plus
the retention and deletion periods described in Section 11 below.

**Categories of Data Subjects** (consistent with `/privacy` and `/security`):
- Customer's authorized users (account holders) — name, email address,
  company name.
- Individuals whose information may appear incidentally in public threat
  signals Averrow collects about Customer's monitored brand assets (e.g., a
  registrant name appearing in public WHOIS data, or a handle appearing in
  a public social-media impersonation match). Averrow does not intentionally
  collect data about these individuals beyond what is publicly available
  and relevant to threat detection.

**Categories of Personal Data processed** (matching `/security` "What data
we collect" / "What we DON'T collect"):

| Collected | Not collected |
|---|---|
| Account info: name, email, company name | Email content |
| Domain names submitted for monitoring | Credentials |
| Email security records (public DNS — SPF/DKIM/DMARC) | Internal network data |
| Social platform public profile data (for impersonation detection) | Customer PII beyond account info |
| Threat feed matches / scan results | |
| Usage data (pages visited, feature usage, session duration) | |

Averrow does not collect or process sensitive/special-category data as a
matter of course. `[NEEDS HUMAN INPUT: confirm with counsel whether this
statement needs qualification — e.g., could a customer-submitted scan
target incidentally surface special-category data in public web content,
and if so, does the DPA need a clause addressing that residual risk rather
than asserting an absolute "we don't collect it"?]`

---

## 5. Sub-processors

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Averrow uses the following categories of sub-processor to provide the
platform, consistent with `/privacy` and `/security` (do not add
sub-processors here without confirming they are actually named/consistent
with the public site — this list must never grow ahead of what
`/privacy` discloses):

| Sub-processor | Purpose | Notes |
|---|---|---|
| **Cloudflare** | Infrastructure, CDN, edge compute (Workers), database (D1), and cache (KV) hosting the Averrow platform. | Processes requests on Averrow's behalf to deliver the platform. |
| **[AI Provider]** | Threat analysis, content classification, and risk scoring (AI/LLM inference). | Data shared is limited to what's necessary for analysis. `/privacy` refers to this sub-processor generically as "AI Provider" without naming the specific vendor. |

`[NEEDS HUMAN INPUT: decide whether the DPA (and the customer-facing
sub-processor list it should link to) must name the AI provider explicitly
by legal/corporate name — most GDPR-facing DPAs require a specific,
identified sub-processor list, not a generic category. If the vendor is to
be named, confirm the exact legal entity name and location for this table
and for Annex 1, and confirm that naming it does not conflict with any
vendor confidentiality terms.]`

`[NEEDS HUMAN INPUT: confirm whether there are any other sub-processors in
use that are NOT reflected on /security or /privacy today — e.g., email
delivery, payment processing (Stripe is referenced elsewhere in the
codebase for billing) — a real DPA sub-processor list must be complete, and
omitting a sub-processor that is actually in use would be a compliance gap,
not just a documentation gap.]`

**Sub-processor changes:** Averrow will provide Customer with
[NEEDS HUMAN INPUT: confirm advance-notice period for new/replacement
sub-processors — common terms are 15 or 30 days] advance notice of any new
sub-processor or change of sub-processor, via
[NEEDS HUMAN INPUT: confirm notice mechanism — email, in-platform notice,
posted sub-processor list with subscribe/RSS, etc.], and Customer may
object on reasonable data-protection grounds within
[NEEDS HUMAN INPUT: confirm objection window].

Averrow remains liable for the acts and omissions of its sub-processors to
the same extent Averrow would be liable if performing the services directly,
and imposes data protection obligations on sub-processors that are no less
protective than those in this DPA.

---

## 6. Security Measures

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Averrow implements and maintains the following technical and organizational
measures, consistent with `/security` — this section must not claim
anything beyond what is actually in production:

- **Encryption in transit:** TLS 1.3 for all data in transit.
- **Encryption at rest:** All data encrypted at rest, including the
  primary database (Cloudflare D1) and cache layer (Cloudflare KV).
- **Access control:** JWT-based authentication with short-lived tokens;
  role-based access control (RBAC) enforcing multi-tenant isolation between
  customer organizations.
- **Audit logging:** All API access and administrative actions are logged
  to a tamper-resistant audit trail.
- **Secrets management:** API keys and similar credentials are stored as
  hashed secrets, never in plaintext.
- **Architecture:** Edge-native compute (Cloudflare Workers) with no
  traditional origin servers; automatic backups on the primary database.
- **Data minimization:** Averrow does not collect email content,
  credentials, internal network data, or customer PII beyond account
  information (see Section 4 table).

**Certifications — status as of this draft (do not overstate):**
- SOC 2 Type I: **scheduled for Q3 2026, not yet completed.** Engagement
  letter is in place; no report exists yet to reference or attach.
- SOC 2 Type II: **scheduled for Q1 2027, not yet completed.**
- No other third-party security certification (e.g., ISO 27001) is
  currently held or in progress as of this draft.
  `[NEEDS HUMAN INPUT: confirm this is still accurate at time of
  finalization — if any certification status has changed, update this
  section and the corresponding claim on /security before this DPA is
  used, not after.]`
- GDPR-aligned processing and PIPEDA compliance are described on
  `/security` as controls Averrow "operates to today" (not a certification,
  a self-described operating posture) — phrase any DPA representation about
  these accordingly: an operational commitment, not a third-party-certified
  compliance status. `[NEEDS HUMAN INPUT: counsel should confirm the exact
  representation language here — "aligned with" vs. "compliant with" carries
  different legal weight.]`

Upon reasonable written request, and no more than
`[NEEDS HUMAN INPUT: confirm frequency limit, e.g., once per 12 months]`,
Averrow will make available a summary of its security measures sufficient
for Customer to satisfy its own due-diligence obligations under applicable
Data Protection Law.

---

## 7. Assistance with Data Subject Rights

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Taking into account the nature of the processing, Averrow will provide
Customer with reasonable assistance to respond to requests from Data
Subjects exercising rights under applicable Data Protection Law
(access, correction, deletion/erasure, data portability, restriction, or
objection), consistent with the rights already described on `/privacy`.

- Where a Data Subject contacts Averrow directly instead of Customer,
  Averrow will, without undue delay, either direct the individual to
  Customer or notify Customer of the request, and will not itself respond
  substantively to the request without Customer's instruction, except
  where required by law.
- Averrow will use commercially reasonable efforts to respond to Customer's
  assistance requests within
  `[NEEDS HUMAN INPUT: confirm processor-side response SLA for
  Customer's data-subject-rights assistance requests — the 30-day figure
  in /privacy is Averrow's own end-user-facing response time as a
  controller of account data, not necessarily the right SLA for
  processor-to-controller assistance under this DPA; counsel should decide
  whether to reuse 30 days or set a shorter internal turnaround so Customer
  can still meet its own regulatory deadline (e.g., GDPR's 1-month
  Article 12(3) clock)]`.

---

## 8. Personal Data Breach Notification

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Averrow will notify Customer without undue delay, and in any event within
`[NEEDS HUMAN INPUT: confirm processor-to-controller notification window —
commonly 24–72 hours from Averrow becoming aware of the incident; must be
short enough that Customer, as controller, can still meet its own
regulatory notification deadline, e.g., GDPR's 72-hour supervisory-authority
window]`, after becoming aware of a Security Incident affecting Customer's
Personal Data.

The notification will include, to the extent known at the time and
supplemented as more information becomes available:
- the nature of the incident, including categories and approximate number
  of Data Subjects and records affected;
- the likely consequences;
- the measures taken or proposed to address the incident, including
  measures to mitigate its possible adverse effects;
- contact point for further information.

Averrow will cooperate with Customer and provide reasonable information
Customer needs to meet any of its own notification obligations to
supervisory authorities or affected individuals under applicable Data
Protection Law.

`[NEEDS HUMAN INPUT: confirm the notification contact channel/address to
be named here — currently security@averrow.com is used for vulnerability
disclosure per /security, but breach notification to a Controller under a
signed DPA may warrant a dedicated contact or an account-specific escalation
path.]`

---

## 9. Data Location and International Transfers

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Averrow's infrastructure runs on Cloudflare's global edge network. As of
this draft, the specific regions in which Customer's Personal Data is
stored and processed have not been documented for this DPA.

`[NEEDS HUMAN INPUT: this section is incomplete and must not be finalized
without input — confirm: (1) the specific Cloudflare data-storage region(s)
or jurisdiction(s) used for D1/KV for this account tier (Cloudflare Workers
route requests globally at the edge, but D1/KV storage location is
configurable and matters for a real transfer-mechanism analysis); (2)
whether Personal Data of EU/UK/Canadian Data Subjects is processed or
stored outside those regions, and if so, which cross-border transfer
mechanism applies — e.g., EU Standard Contractual Clauses (SCCs), the UK
International Data Transfer Addendum, or an adequacy decision; (3) whether
the AI-provider sub-processor processes data outside the region(s)
Customer expects, and what transfer mechanism covers that hop; (4) whether
Averrow needs a signed SCC module (or equivalent) with each sub-processor
before this DPA can be offered to EU/UK/Swiss customers.]`

Until the above is resolved, this DPA should not be represented to any
customer as providing a complete international-transfer safeguard.

---

## 10. Audit Rights

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Averrow will make available to Customer information reasonably necessary to
demonstrate compliance with this DPA, including responses to a reasonable
security questionnaire and (once available) the SOC 2 report described in
Section 6.

Customer may request an audit of Averrow's relevant processing activities,
subject to:
- reasonable advance written notice (`[NEEDS HUMAN INPUT: confirm notice
  period, e.g., 30 days]`);
- no more than `[NEEDS HUMAN INPUT: confirm audit frequency cap, e.g., once
  per 12-month period, absent a Security Incident or regulator requirement]`;
- confidentiality obligations protecting Averrow's and its other customers'
  information and Averrow's own security posture;
- audits conducted during business hours in a manner that does not
  unreasonably disrupt Averrow's operations; and
- `[NEEDS HUMAN INPUT: confirm whether Customer bears its own audit costs,
  or whether Averrow charges a fee for on-site/hands-on audits beyond the
  standard questionnaire/report exchange — common in SaaS DPAs to limit
  audit rights to documentation review plus SOC-report reliance once a
  report exists, with on-site audits reserved for confirmed incidents or
  regulator demand.]`

Until the SOC 2 Type I report exists (Q3 2026 target), Averrow cannot rely
on a third-party report to satisfy audit requests and should expect direct
questionnaire-based diligence in the interim — this is a real, current gap,
not a drafting placeholder, and should be flagged to sales/success teams
handling enterprise procurement in the meantime.

---

## 11. Retention and Deletion

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Matching `/security` and `/privacy` exactly — do not introduce different
numbers here without updating those pages too:

- **Active account data** (account info, scan history, monitoring data) is
  retained for as long as the Customer subscription remains active.
- **Free/one-time scan results** are cached for 24 hours and then
  automatically purged.
- **Account deletion:** upon request, Customer's account and all associated
  data are permanently deleted within 30 days of the request. Deletion
  requests go to `privacy@averrow.com` per `/privacy`.

`[NEEDS HUMAN INPUT: confirm whether the DPA needs additional detail beyond
what /privacy already states — e.g., specific retention periods for backups
(the /security infrastructure list mentions "automatic backups" on D1 but
does not state a backup retention/rotation period), and whether backups are
purged/overwritten within the same 30-day deletion window or on a separate
backup-rotation schedule. A real DPA typically needs to address backup
retention explicitly, and this fact is not yet documented anywhere in the
existing site copy.]`

On termination of the underlying subscription (see Section 12), Averrow
will delete or return Personal Data per Customer's instructions, subject to
any retention required by applicable law, consistent with the above.

---

## 12. Term and Termination

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

This DPA takes effect on `[NEEDS HUMAN INPUT: effective date]` and remains
in effect for as long as Averrow processes Personal Data on Customer's
behalf under the Terms of Service, i.e., for the term of the underlying
subscription plus the retention/deletion period in Section 11.

Termination of the underlying subscription (per the Terms of Service
termination provisions) automatically terminates this DPA, without
prejudice to any obligations that by their nature survive termination
(e.g., confidentiality, post-termination deletion obligations, liability).

---

## 13. Liability

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

Each party's liability arising out of or in connection with this DPA is
subject to the limitations and exclusions of liability set out in the
Terms of Service, unless applicable Data Protection Law prohibits limiting
liability for the type of claim in question.

`[NEEDS HUMAN INPUT: confirm with counsel whether GDPR Article 82
(right to compensation) or similar provisions require carve-outs from the
Terms of Service's general liability cap for this DPA — this is a common
and material drafting decision that should not be resolved by inheriting
the general commercial liability cap without review.]`

---

## 14. Governing Law and Jurisdiction

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

`[NEEDS HUMAN INPUT: the Terms of Service specify the laws of the Province
of Ontario, Canada with exclusive jurisdiction in Ontario courts. Confirm
with counsel whether this DPA should: (a) simply inherit that governing law
and forum, consistent with the rest of the contract stack, or (b) require a
different mechanism for EU/UK/other customers where local law may mandate a
different governing-law or forum clause for data-protection-specific
disputes (some EU regulators/customers expect the DPA to reference the
GDPR itself as the controlling data-protection framework regardless of the
commercial contract's chosen governing law). This is a genuine legal
judgment call, not a fact this draft can safely default.]`

---

## 15. Annexes

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

### Annex 1 — Sub-processors
See Section 5 table. `[NEEDS HUMAN INPUT: finalize the exact, complete,
named sub-processor list — including the AI provider's legal name and any
sub-processors used for functions not yet reflected on /security (e.g.
billing/payment processing, email delivery) — before this annex is treated
as complete.]`

### Annex 2 — Description of Processing
See Section 4 table (categories of data subjects, categories of data,
purpose, duration). `[NEEDS HUMAN INPUT: confirm this table matches the
final agreed scope-of-service language in the master Terms/Order Form —
scope of processing described in a DPA must track the actual commercial
service being sold.]`

### Annex 3 — Security Measures
See Section 6. Update this annex any time an entry on `/security`'s
"Security Practices," "Infrastructure," or "Compliance" sections changes,
so the DPA never drifts out of sync with the public-facing claims.

### Annex 4 — Signature Block
`[NEEDS HUMAN INPUT: standard signature block — authorized signatory name/
title for LRX Enterprises Inc., and a blank signatory block for Customer.
Not drafted here since this document is not yet execution-ready.]`

---

## Summary of Open Items for Legal / Human Sign-off

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

This list consolidates every `[NEEDS HUMAN INPUT: ...]` marker above so
counsel can track resolution in one place:

1. DPA execution mechanism (standalone / exhibit / click-through).
2. Province/territory of incorporation for the Processor recital, and the
   registered address for contract execution.
3. Complete list of privacy statutes to name in Definitions (beyond
   GDPR/UK GDPR/PIPEDA — e.g., US state laws if applicable).
4. Whether Averrow ever acts as an independent controller for any data
   category (e.g., aggregated threat intelligence) that should be carved
   out of the processor role.
5. Whether incidental exposure of special-category data via scan targets
   needs its own clause rather than a blanket "we don't collect it."
6. Whether to name the AI-provider sub-processor by legal entity name in
   the sub-processor list/annex, and confirm that's permitted under vendor
   terms.
7. Confirm completeness of the sub-processor list — check for
   payment/billing and email-delivery vendors not currently reflected on
   `/security` or `/privacy`.
8. Sub-processor change notice period, mechanism, and objection window.
9. Frequency cap on Customer's right to request a security-measures
   summary.
10. Exact representation language for "GDPR-aligned"/"PIPEDA-compliant"
    claims (operational posture vs. certified compliance).
11. Processor-to-controller SLA for data-subject-rights assistance
    requests (distinct from the 30-day end-user-facing figure in
    `/privacy`).
12. Processor-to-controller breach notification window (e.g., 24–72
    hours) and the specific contact channel for breach notices.
13. Data storage region(s)/jurisdiction(s) for D1/KV, whether cross-border
    transfers occur for EU/UK/Canadian data subjects, and which transfer
    mechanism (SCCs, IDTA, adequacy) applies — currently undocumented
    anywhere in the codebase or site copy.
14. Whether the AI-provider hop requires its own transfer-mechanism
    analysis.
15. Audit notice period, frequency cap, cost allocation, and whether
    audits are limited to documentation/questionnaire review pending the
    SOC 2 report.
16. Effective date of the DPA.
17. Whether GDPR Art. 82-style carve-outs are needed from the Terms of
    Service's general liability cap.
18. Governing law/jurisdiction for the DPA — inherit Ontario from the
    Terms, or add a data-protection-specific mechanism for EU/UK
    customers.
19. Complete, named sub-processor list and finalized signature block
    (Annexes 1 and 4).
20. Confirm backup retention/rotation period for D1 backups (currently
    undocumented) and whether backups fall inside the 30-day deletion
    window.

---

> **DRAFT — requires human and legal review before publishing. Not legal advice.**

This document was drafted to support legal review, not to replace it. Do
not publish, sign, or represent any part of this document as final until
counsel has resolved every item above and the resulting text has been
independently reviewed against the live `/privacy`, `/terms`, and
`/security` pages for consistency.
