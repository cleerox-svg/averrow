// Takedown Authorization — DRAFT MSA copy.
//
// This file is the customer-facing legal text shown on
// /tenant/settings/takedown-authorization before signing.
//
// IMPORTANT: This is a working-draft placeholder, not final legal
// language. When Legal delivers the approved MSA copy:
//   1. Replace AGREEMENT_BODY with the final text
//   2. Bump AGREEMENT_VERSION (drop the '-draft' suffix and date-stamp)
//   3. Any new signing after that point records the new version;
//      existing signed authorizations keep their older version string
//      — that's the audit trail.
//
// The agreement_version string is what the backend stamps onto
// takedown_authorizations.agreement_version. It must change on every
// substantive copy revision so customers re-consent when terms shift.

export const AGREEMENT_VERSION = 'v0.1-draft-2026-05';

export const AGREEMENT_TITLE = 'Takedown Submission Authorization';

export interface AgreementSection {
  heading: string;
  body:    string;
}

/**
 * Body is rendered as plain paragraphs (no HTML / markdown). Keep
 * lines short for readability — the form area is ~640px wide.
 */
export const AGREEMENT_SECTIONS: AgreementSection[] = [
  {
    heading: '1. What you authorize',
    body:
      'You authorize Averrow and its agents to submit takedown, deactivation, and abuse-report requests on your organization\'s behalf to domain registrars, hosting providers, social platforms, app stores, and other intermediaries identified by the modules listed in Scope below. Submissions are made under your organization\'s name and may reference your trademarks, logos, and brand assets.',
  },
  {
    heading: '2. Scope you control',
    body:
      'You set the modules covered, the monthly cap, escalation behavior, and whether high-risk takedowns require per-takedown approval. You may change scope or revoke this authorization at any time. Revocation halts new automated submissions immediately; in-flight requests already filed are not recalled.',
  },
  {
    heading: '3. Accuracy of representations',
    body:
      'You represent that you own or are licensed to enforce the trademarks, brand assets, and intellectual property that submissions will rely on. You acknowledge that knowingly false takedown claims may carry liability under applicable law (e.g. DMCA §512(f) in the United States) and indemnify Averrow against losses arising from misrepresentation by your organization in such submissions.',
  },
  {
    heading: '4. Audit trail',
    body:
      'Every submission Averrow makes on your behalf is logged with the target, provider, evidence package, and timestamps. You can review and export this log from the Takedowns surface at any time. Signing record (signer identity, IP, user-agent, agreement version, signed timestamp) is preserved per organization.',
  },
  {
    heading: '5. Data handling',
    body:
      'Evidence packages may include URLs, screenshots, WHOIS data, and infrastructure metadata. They are shared with the receiving provider as part of the submission and retained in our audit log. Averrow does not sell this data and processes it solely to perform the service you authorized.',
  },
  {
    heading: '6. Termination',
    body:
      'This authorization remains in effect until revoked by you or until the underlying service agreement terminates. Revocation does not affect the validity of submissions already made.',
  },
  {
    heading: '7. Governing terms',
    body:
      'This authorization supplements and is governed by Averrow\'s Master Services Agreement. To the extent any conflict exists, the MSA controls. Capitalized terms not defined here have the meaning given in the MSA.',
  },
];

/** Single-line summary shown above the form for skim-readers. */
export const AGREEMENT_SUMMARY =
  'Lets Averrow submit takedowns on your behalf for the modules you select. Revocable, audited, scope-limited.';
