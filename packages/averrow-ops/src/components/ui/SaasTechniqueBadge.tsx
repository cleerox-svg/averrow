// SaasTechniqueBadge — displays a PushSecurity SaaS attack technique.
//
// Usage:
//   <SaasTechniqueBadge
//     techniqueId="aitm_phishing"
//     techniqueName="AiTM Phishing"
//     phase="initial_access"
//     phaseLabel="Initial Access"
//     severity="critical"
//   />
//
// Colors map per-phase from design tokens. Keep inline styles (no Tailwind)
// so the badge works identically in dark and light themes.

export interface SaasTechniqueBadgeProps {
  techniqueId:   string;
  techniqueName: string;
  phase:         string;
  phaseLabel:    string;
  severity:      string;
  size?:         "xs" | "sm";
}

const PHASE_COLORS: Record<string, string> = {
  reconnaissance:       "var(--blue)",
  initial_access:       "var(--sev-high)",
  persistence:          "var(--sev-medium)",
  credential_access:    "var(--sev-critical)",
  lateral_movement:     "var(--amber)",
  exfiltration:         "var(--red)",
  execution:            "var(--sev-high)",
  privilege_escalation: "var(--sev-critical)",
  defense_evasion:      "var(--sev-medium)",
  discovery:            "var(--blue)",
};

export function SaasTechniqueBadge({
  techniqueId,
  techniqueName,
  phase,
  phaseLabel,
  size = "sm",
}: SaasTechniqueBadgeProps) {
  const color = PHASE_COLORS[phase] ?? "var(--text-muted)";

  return (
    <div
      title={`${techniqueName} · ${phaseLabel} (${techniqueId})`}
      style={{
        display:      "inline-flex",
        alignItems:   "center",
        gap:          6,
        padding:      size === "xs" ? "2px 7px" : "4px 10px",
        borderRadius: size === "xs" ? 5 : 7,
        background:   `color-mix(in srgb, ${color} 7%, transparent)`,
        border:       `1px solid color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      <div
        style={{
          width:      5,
          height:     5,
          borderRadius: "50%",
          background: color,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize:      size === "xs" ? 8 : 10,
          fontFamily:    "var(--font-mono)",
          fontWeight:    700,
          letterSpacing: "0.08em",
          color:         color,
          textTransform: "uppercase",
        }}
      >
        {techniqueName}
      </span>
      <span
        style={{
          fontSize:      size === "xs" ? 7 : 9,
          color:         "var(--text-muted)",
          fontFamily:    "var(--font-mono)",
          letterSpacing: "0.06em",
        }}
      >
        · {phaseLabel}
      </span>
    </div>
  );
}
