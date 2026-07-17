/**
 * Averrow — Terms of Service Page
 * Terms of Service for LRX Enterprises Inc.
 */

import { wrapPage } from "./shared";

export function renderTermsPage(): string {
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
  <h1>Terms of Service</h1>
  <p class="legal-updated">Last updated: March 21, 2026</p>

  <h2>Acceptance of Terms</h2>
  <p>
    By accessing or using Averrow ("the Service"), operated by LRX Enterprises Inc.
    ("we", "us", "our"), you agree to be bound by these Terms of Service. If you do not
    agree to these terms, you may not access or use the Service. These terms apply to all
    users, including visitors, free-tier users, and paid subscribers.
  </p>

  <h2>Service Description</h2>
  <p>
    Averrow is an AI-powered brand threat intelligence platform. The Service provides
    domain scanning, impersonation detection, phishing analysis, social media monitoring,
    and threat feed matching to help organizations identify and respond to brand abuse and
    online threats.
  </p>
  <p>
    We reserve the right to modify, suspend, or discontinue any aspect of the Service at
    any time, with or without notice. We will make reasonable efforts to notify subscribers
    of material changes.
  </p>

  <h2>Account Responsibilities</h2>
  <p>
    You are responsible for maintaining the confidentiality of your account credentials and
    for all activities that occur under your account. You agree to:
  </p>
  <ul>
    <li>Provide accurate and complete registration information.</li>
    <li>Promptly update your account information if it changes.</li>
    <li>Notify us immediately of any unauthorized access to or use of your account.</li>
    <li>Ensure that your use of the Service complies with all applicable laws and regulations.</li>
  </ul>

  <h2>Acceptable Use</h2>
  <p>You agree not to use the Service to:</p>
  <ul>
    <li>Reverse engineer, decompile, disassemble, or otherwise attempt to derive the source code or underlying algorithms of the Service.</li>
    <li>Scrape, crawl, or use automated tools to extract data from the Service beyond what is provided through our intended interfaces and APIs.</li>
    <li>Resell, sublicense, redistribute, or make the Service available to any third party without our prior written consent.</li>
    <li>Use the Service for any unlawful purpose or in violation of any applicable local, provincial, national, or international law.</li>
    <li>Interfere with or disrupt the integrity or performance of the Service or its underlying infrastructure.</li>
    <li>Attempt to gain unauthorized access to the Service, other user accounts, or related systems or networks.</li>
  </ul>

  <h2>Intellectual Property</h2>
  <p>
    The Service, including its design, features, content, algorithms, and underlying
    technology, is the exclusive property of LRX Enterprises Inc. and is protected by
    Canadian and international intellectual property laws. Your use of the Service does
    not grant you any ownership rights to the Service or its components.
  </p>
  <p>
    You retain ownership of any data you submit to the Service. By submitting data, you
    grant us a limited, non-exclusive licence to process that data solely for the purpose
    of delivering the Service to you.
  </p>

  <h2>Subscription Terms</h2>
  <p>
    Averrow offers free and paid subscription plans. By subscribing to a paid plan,
    you agree to the following:
  </p>
  <ul>
    <li><strong>Pricing:</strong> Subscription fees are as listed on our pricing page at the time of purchase. Prices are in Canadian dollars unless otherwise stated.</li>
    <li><strong>Billing:</strong> Paid subscriptions are billed on a recurring basis (monthly or annually, depending on the plan selected). Payment is due at the start of each billing cycle.</li>
    <li><strong>Cancellation:</strong> You may cancel your subscription at any time through your account settings or by contacting us. Cancellation takes effect at the end of the current billing period. No refunds are provided for partial billing periods.</li>
    <li><strong>Changes:</strong> We reserve the right to adjust pricing with 30 days' notice. Existing subscribers will be notified before any price change takes effect on their account.</li>
  </ul>

  <h2>Limitation of Liability</h2>
  <p>
    To the maximum extent permitted by applicable law, LRX Enterprises Inc. and its
    directors, officers, employees, and agents shall not be liable for any indirect,
    incidental, special, consequential, or punitive damages, including but not limited to
    loss of profits, data, business opportunities, or goodwill, arising out of or in
    connection with your use of the Service.
  </p>
  <p>
    Our total aggregate liability for all claims arising from or related to the Service
    shall not exceed the total fees you paid to us in the twelve (12) months preceding
    the event giving rise to the claim.
  </p>
  <p>
    The Service is provided on an "as is" and "as available" basis. We do not warrant that
    the Service will be uninterrupted, error-free, or completely secure, or that the
    results obtained from the Service will be accurate or reliable.
  </p>

  <h2>Indemnification</h2>
  <p>
    You agree to indemnify, defend, and hold harmless LRX Enterprises Inc. and its
    directors, officers, employees, and agents from and against any and all claims,
    liabilities, damages, losses, and expenses (including reasonable legal fees) arising
    out of or in connection with your use of the Service, your violation of these Terms,
    or your violation of any rights of a third party.
  </p>

  <h2>Termination</h2>
  <p>
    We may suspend or terminate your access to the Service at any time, with or without
    cause, and with or without notice. Grounds for termination include, but are not limited
    to, violation of these Terms, non-payment of fees, or conduct that we reasonably
    believe is harmful to other users or the Service.
  </p>
  <p>
    Upon termination, your right to use the Service ceases immediately. Provisions of these
    Terms that by their nature should survive termination shall remain in effect, including
    intellectual property, limitation of liability, indemnification, and governing law
    provisions.
  </p>

  <h2>Governing Law</h2>
  <p>
    These Terms of Service are governed by and construed in accordance with the laws of the
    Province of Ontario, Canada, without regard to its conflict of law principles. Any
    disputes arising from or relating to these Terms or your use of the Service shall be
    subject to the exclusive jurisdiction of the courts located in the Province of Ontario,
    Canada.
  </p>

  <h2>Changes to These Terms</h2>
  <p>
    We reserve the right to update or modify these Terms of Service at any time. When we
    make material changes, we will update the "Last updated" date at the top of this page
    and notify affected users through the platform or via email. Your continued use of the
    Service after changes are posted constitutes acceptance of the revised terms.
  </p>

  <h2>Contact Us</h2>
  <p>
    If you have questions or concerns about these Terms of Service, please contact us at:
  </p>
  <p>
    <strong>LRX Enterprises Inc. operating as Averrow</strong><br>
    Email: <a href="mailto:legal@averrow.com">legal@averrow.com</a>
  </p>
</div>`;

  return wrapPage(
    "Terms of Service — Averrow",
    "Terms of Service for Averrow by LRX Enterprises Inc. Read the terms governing your use of our AI-powered brand threat intelligence platform.",
    content
  );
}
