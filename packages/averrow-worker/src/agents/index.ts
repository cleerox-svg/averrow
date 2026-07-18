/**
 * Agent registry — maps agent names to modules.
 *
 * Canonical agents:
 *   sentinel (5min/event), analyst (15min), cartographer (15min), strategist (6h),
 *   observer (daily), nexus (4h), pathfinder (weekly), sparrow (6h)
 */

import type { AgentModule } from "../lib/agentRunner";

import { sentinelAgent } from "./sentinel";
import { analystAgent } from "./analyst";
import { cartographerAgent } from "./cartographer";
import { strategistAgent } from "./strategist";
import { observerAgent } from "./observer";
import { pathfinderAgent } from "./pathfinder";
import { sparrowAgent } from "./sparrow";
import { nexusAgent } from "./nexus";
import { flightControlAgent } from "./flightControl";
import { curatorAgent } from "./curator";
import { watchdogAgent } from "./watchdog";
// architectAgent — RETIRED 2026-04-29 (Phase 2.2 of agent audit).
// Dead since 2026-04-11 (status='error', 0 runs in 7 days). Meta-agent
// designed to audit other agents but the architect_bundles R2 bucket
// is empty and zero diagnostic outputs in the last 30 days. Source
// files retained at agents/architect/ per AGENT_STANDARD §20.1
// (git history is the audit trail). To resurrect: re-add the import,
// the agentModules entry, the agent-metadata row, and the group.
import { narratorAgent } from "./narrator";
import { notificationNarratorAgent } from "./notification_narrator";
import { appStoreMonitorAgent } from "./appStoreMonitor";
import { darkWebMonitorAgent } from "./darkWebMonitor";
import { socialMonitorAgent } from "./socialMonitor";
import { socialDiscoveryAgent } from "./socialDiscovery";
import { autoSeederAgent } from "./auto-seeder";
import { seedStrategistAgent } from "./seed-strategist";
import { cubeHealerAgent } from "./cube-healer";
import { navigatorAgent } from "../cron/navigator";
import { enricherAgent } from "../cron/enricher";
import { publicTrustCheckAgent } from "./public-trust-check";
import { qualifiedReportAgent } from "./qualified-report";
import { brandAnalysisAgent } from "./brand-analysis";
import { brandReportAgent } from "./brand-report";
import { brandDeepScanAgent } from "./brand-deep-scan";
import { honeypotGeneratorAgent } from "./honeypot-generator";
import { brandEnricherAgent } from "./brand-enricher";
import { lookalikeScannerAgent } from "./lookalike-scanner";
import { trademarkMonitorAgent } from "./trademarkMonitor";
import { adminClassifyAgent } from "./admin-classify";
import { urlScanAgent } from "./url-scan";
import { scanReportAgent } from "./scan-report";
import { socialAiAssessorAgent } from "./social-ai-assessor";
import { geoCampaignAssessmentAgent } from "./geo-campaign-assessment";
import { evidenceAssemblerAgent } from "./evidence-assembler";
import { geoipRefreshAgent } from "./geoip-refresh";
import { attributorAgent } from "./attributor";
import { newsWatcherAgent } from "./news-watcher";
import { campaignHunterAgent } from "./campaign-hunter";
import { abuseMailboxClassifierAgent } from "./abuseMailboxClassifier";
import { ctMonitorAgent } from "./ct-monitor";

// TrustBot is a utility module for the /api/trustbot/chat endpoint — not a scheduled/event agent
export { trustbotAgent } from "./trustbot";

export const agentModules: Record<string, AgentModule> = {
  "sentinel": sentinelAgent,
  "analyst": analystAgent,
  "cartographer": cartographerAgent,
  "strategist": strategistAgent,
  "observer": observerAgent,
  "pathfinder": pathfinderAgent,
  "sparrow": sparrowAgent,
  "nexus": nexusAgent,
  "flight_control": flightControlAgent,
  "curator": curatorAgent,
  "watchdog": watchdogAgent,
  // "architect": retired (see comment above)
  "narrator": narratorAgent,
  "notification_narrator": notificationNarratorAgent,
  "app_store_monitor": appStoreMonitorAgent,
  "dark_web_monitor": darkWebMonitorAgent,
  "social_monitor": socialMonitorAgent,
  "social_discovery": socialDiscoveryAgent,
  "auto_seeder": autoSeederAgent,
  "seed_strategist": seedStrategistAgent,
  "cube_healer": cubeHealerAgent,
  "navigator": navigatorAgent,
  "enricher": enricherAgent,
  "public_trust_check": publicTrustCheckAgent,
  "qualified_report": qualifiedReportAgent,
  "brand_analysis": brandAnalysisAgent,
  "brand_report": brandReportAgent,
  "brand_deep_scan": brandDeepScanAgent,
  "honeypot_generator": honeypotGeneratorAgent,
  "brand_enricher": brandEnricherAgent,
  "lookalike_scanner": lookalikeScannerAgent,
  "trademark_monitor": trademarkMonitorAgent,
  "admin_classify": adminClassifyAgent,
  "url_scan": urlScanAgent,
  "scan_report": scanReportAgent,
  "social_ai_assessor": socialAiAssessorAgent,
  "geo_campaign_assessment": geoCampaignAssessmentAgent,
  "evidence_assembler": evidenceAssemblerAgent,
  "geoip_refresh": geoipRefreshAgent,
  "attributor": attributorAgent,
  "news_watcher": newsWatcherAgent,
  "campaign_hunter": campaignHunterAgent,
  "abuse_mailbox_classifier": abuseMailboxClassifierAgent,
  "ct_monitor": ctMonitorAgent,
};
