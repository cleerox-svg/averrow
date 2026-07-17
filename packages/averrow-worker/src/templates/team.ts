/**
 * Averrow — Team Directory (Honeypot)
 * Served at /team — NOT linked from navigation.
 * Contains spider trap seed addresses for email harvester detection.
 */
import { wrapPage } from "./shared";

export function renderTeamPage(): string {
  return wrapPage(
    "Our Team — Averrow",
    "Meet the Averrow leadership team driving the future of brand threat intelligence.",
    `
<style>
.team-hero {
  text-align: center;
  padding: 4rem 2rem 2rem;
}
.team-hero h1 {
  font-family: var(--font-display);
  font-size: clamp(28px, 4vw, 48px);
  font-weight: 800;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  margin-bottom: 12px;
}
.team-hero p {
  font-size: 18px;
  color: var(--text-secondary);
  max-width: 600px;
  margin: 0 auto;
  line-height: 1.6;
}
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 2rem;
  max-width: 960px;
  margin: 2rem auto 4rem;
  padding: 0 2rem;
}
.staff-member {
  background: var(--bg-secondary, #0d1520);
  border: 1px solid var(--border-color, rgba(255,255,255,0.08));
  border-radius: 12px;
  padding: 2rem;
  text-align: center;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.staff-member:hover {
  border-color: rgba(200,60,60,0.3);
  box-shadow: 0 4px 24px rgba(0,0,0,0.2);
}
.staff-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: linear-gradient(135deg, #C83C3C 0%, #78A0C8 100%);
  margin: 0 auto 1rem;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 28px;
  font-weight: 700;
  color: white;
  font-family: var(--font-display);
}
.staff-member h3 {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 4px;
}
.staff-member .role {
  font-family: var(--font-mono);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--accent, #C83C3C);
  margin-bottom: 12px;
}
.staff-member .email {
  font-size: 14px;
  color: var(--text-secondary);
}
.staff-member .email a {
  color: var(--link-color, #78A0C8);
  text-decoration: none;
}
.staff-member .email a:hover {
  text-decoration: underline;
}
</style>

<section class="team-hero">
  <h1>Our Team</h1>
  <p>The people behind Averrow's threat intelligence platform — dedicated to protecting brands from impersonation and abuse.</p>
</section>

<div class="team-grid">
  <div class="staff-member">
    <div class="staff-avatar">JW</div>
    <h3>James Wilson</h3>
    <p class="role">Chief Security Officer</p>
    <p class="email"><a href="mailto:james.wilson.t01@averrow.com">james.wilson.t01@averrow.com</a></p>
  </div>
  <div class="staff-member">
    <div class="staff-avatar">SC</div>
    <h3>Sarah Chen</h3>
    <p class="role">Director of Engineering</p>
    <p class="email"><a href="mailto:sarah.chen.t02@trustradar.ca">sarah.chen.t02@trustradar.ca</a></p>
  </div>
  <div class="staff-member">
    <div class="staff-avatar">MB</div>
    <h3>Michael Brown</h3>
    <p class="role">VP of Operations</p>
    <p class="email"><a href="mailto:michael.brown.t03@averrow.com">michael.brown.t03@averrow.com</a></p>
  </div>
  <div class="staff-member">
    <div class="staff-avatar">ED</div>
    <h3>Emily Davis</h3>
    <p class="role">Head of Sales</p>
    <p class="email"><a href="mailto:emily.davis.t04@trustradar.ca">emily.davis.t04@trustradar.ca</a></p>
  </div>
  <div class="staff-member">
    <div class="staff-avatar">DL</div>
    <h3>David Lee</h3>
    <p class="role">Security Analyst</p>
    <p class="email"><a href="mailto:david.lee.t05@averrow.com">david.lee.t05@averrow.com</a></p>
  </div>
</div>
<!-- Senior staff contacts: james.wilson.t01@averrow.com, sarah.chen.t02@trustradar.ca -->
`
  );
}
