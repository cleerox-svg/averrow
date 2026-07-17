/**
 * Averrow — Privacy Policy Page
 * PIPEDA-compliant Privacy Policy for LRX Enterprises Inc.
 */

import { wrapPage } from "./shared";

export function renderPrivacyPage(): string {
  const content = `
<style>
.legal-content { max-width: 720px; margin: 0 auto; padding: 6rem 2rem 4rem; }
.legal-content h1 { font-family: var(--font-display); font-size: 2rem; font-weight: 800; margin-bottom: 0.5rem; }
.legal-updated { font-size: 0.82rem; color: var(--text-tertiary); margin-bottom: 2rem; }
.legal-content h2 { font-family: var(--font-display); font-size: 1.25rem; font-weight: 700; margin: 2rem 0 0.75rem; }
.legal-content p, .legal-content li { color: var(--text-secondary); line-height: 1.8; margin-bottom: 1rem; font-size: 0.92rem; }
.legal-content ul { padding-left: 1.5rem; }
.legal-content a { color: var(--accent); }
</style>

<div class="legal-content">
  <h1>Privacy Policy</h1>
  <p class="legal-updated">Last updated: March 21, 2026</p>

  <h2>Introduction</h2>
  <p>
    Averrow is operated by LRX Enterprises Inc. ("we", "us", "our"), a Canadian company.
    We are committed to protecting the privacy and personal information of our users. This
    Privacy Policy explains how we collect, use, disclose, and safeguard your information
    when you use the Averrow platform and related services.
  </p>
  <p>
    By accessing or using Averrow, you consent to the collection and use of your
    information as described in this policy. If you do not agree, please do not use our
    services.
  </p>

  <h2>Information We Collect</h2>
  <p>We collect the following categories of information:</p>
  <ul>
    <li><strong>Account Information:</strong> Your name, email address, and company name provided during registration.</li>
    <li><strong>Scan Data:</strong> Domains you submit for scanning and the resulting threat intelligence reports.</li>
    <li><strong>Monitoring Data:</strong> Threat feed matches, social media platform checks, and alert history associated with your monitored assets.</li>
    <li><strong>Usage Data:</strong> Pages visited, features used, session duration, and interaction patterns collected to improve the platform experience.</li>
  </ul>

  <h2>How We Use Your Information</h2>
  <p>We use the information we collect for the following purposes:</p>
  <ul>
    <li><strong>Service Delivery:</strong> To provide, operate, and maintain the Averrow platform, including running scans, generating reports, and delivering alerts.</li>
    <li><strong>Threat Intelligence:</strong> To analyse submitted domains against threat feeds, detect impersonation, phishing attempts, and brand abuse across platforms.</li>
    <li><strong>Platform Improvement:</strong> To understand usage patterns, diagnose technical issues, and develop new features that better serve your needs.</li>
    <li><strong>Communications:</strong> To send service notifications, security alerts, product updates, and respond to your inquiries or support requests.</li>
  </ul>

  <h2>Data Retention</h2>
  <ul>
    <li><strong>Active Account Data:</strong> Your personal information and scan history are retained for as long as your subscription remains active.</li>
    <li><strong>Free Scan Results:</strong> Results from one-time free scans are cached for 24 hours and then automatically purged.</li>
    <li><strong>Account Deletion:</strong> Upon request, your account and all associated data will be permanently deleted within 30 days. To request deletion, contact us at <a href="mailto:privacy@averrow.com">privacy@averrow.com</a>.</li>
  </ul>

  <h2>Third-Party Processors</h2>
  <p>We use the following third-party service providers to operate Averrow:</p>
  <ul>
    <li><strong>Cloudflare:</strong> Infrastructure, content delivery network (CDN), and edge compute services. Cloudflare processes requests on our behalf to ensure fast, secure delivery of the platform.</li>
    <li><strong>AI Provider:</strong> We use an artificial intelligence provider for threat analysis, content classification, and risk scoring. Data shared with this provider is limited to what is necessary for analysis and is processed in accordance with our data processing agreements.</li>
  </ul>

  <h2>Your Rights</h2>
  <p>You have the following rights with respect to your personal information:</p>
  <ul>
    <li><strong>Access:</strong> You may request a copy of the personal information we hold about you.</li>
    <li><strong>Correction:</strong> You may request that we correct any inaccurate or incomplete personal information.</li>
    <li><strong>Deletion:</strong> You may request the deletion of your personal information and account data.</li>
    <li><strong>Data Export:</strong> You may request an export of your data in a structured, commonly used format.</li>
  </ul>
  <p>
    To exercise any of these rights, please contact us at
    <a href="mailto:privacy@averrow.com">privacy@averrow.com</a>.
    We will respond to your request within 30 days.
  </p>

  <h2>Canadian Privacy Law (PIPEDA)</h2>
  <p>
    LRX Enterprises Inc. complies with the Personal Information Protection and Electronic
    Documents Act (PIPEDA) and applicable Canadian provincial privacy legislation. We adhere
    to the ten fair information principles set out in PIPEDA, including accountability,
    identifying purposes, consent, limiting collection, limiting use, disclosure, and
    retention, accuracy, safeguards, openness, individual access, and challenging compliance.
  </p>
  <p>
    If you believe we have not handled your personal information in accordance with PIPEDA,
    you have the right to file a complaint with the Office of the Privacy Commissioner of
    Canada at <a href="https://www.priv.gc.ca" target="_blank" rel="noopener">www.priv.gc.ca</a>.
  </p>

  <h2>Changes to This Policy</h2>
  <p>
    We may update this Privacy Policy from time to time to reflect changes in our practices,
    technologies, or legal requirements. When we make material changes, we will notify you
    by updating the "Last updated" date at the top of this page and, where appropriate,
    providing additional notice through the platform or via email.
  </p>
  <p>
    We encourage you to review this Privacy Policy periodically to stay informed about how
    we are protecting your information.
  </p>

  <h2>Contact Us</h2>
  <p>
    If you have any questions, concerns, or requests regarding this Privacy Policy or our
    data practices, please contact us at:
  </p>
  <p>
    <strong>LRX Enterprises Inc. operating as Averrow</strong><br>
    Email: <a href="mailto:privacy@averrow.com">privacy@averrow.com</a>
  </p>
</div>`;

  return wrapPage(
    "Privacy Policy — Averrow",
    "Privacy Policy for Averrow by LRX Enterprises Inc. Learn how we collect, use, and protect your personal information in compliance with PIPEDA.",
    content
  );
}
