/*
 * Homepage hero runner (G5 H4A "Auto-play steps").
 *
 * Loaded after paint by OperationHero.astro (dynamic import on `load` +
 * idle), never when the visitor prefers reduced motion. Until it runs, the
 * server-rendered SVG poster shows the finished operation, so the page is
 * complete without it.
 *
 * Plain canvas 2D + rAF + CSS transitions: works the same in Chrome,
 * Safari, Firefox and Edge. Colours are read from the CSS tokens at runtime
 * and re-read when the theme toggles. Easing is monotone (no overshoot on
 * data). The rAF loop only runs while something moves: it stops when
 * paused, finished, off-screen or in a hidden tab.
 *
 * Ported from docs/brand/hero-prototype/src/core.js + h4a-run.js.
 */
import { build, labelPos, showsLabel, hubText, linkEnd, ORDER, HUB_ID, HUB_SUB, HUB_TITLE, ACTOR_LINE, type Graph } from "../lib/hero-graph";

type Pt = [number, number];
type Colors = Record<"crit" | "high" | "med" | "low" | "bg" | "pt" | "text" | "muted" | "t2" | "tint", string>;

const MONO = '"Geist Mono",ui-monospace,Menlo,monospace';
const SANS = "Geist,ui-sans-serif,system-ui,sans-serif";
/** Per step: [build seconds, hold seconds]; ST = step start times. */
const SEG: Pt[] = [[2, 0.9], [2.6, 1], [2.2, 1], [3, 2.8]];
const ST = [0, 2.9, 6.5, 9.7];
const TOT = 15.5;
const OUT = 0.45;
const GAP = 0.45;
/** Plays the story this many times, then rests on the finished operation. */
const PLAYS = 3;
/** Timeline speed. Tests set `window.__heroSpeed` to fast-forward the story. */
const SPEED = Number((window as unknown as { __heroSpeed?: number }).__heroSpeed) || 1;

const cl = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const rp = (u: number, a: number, b: number) => cl((u - a) / (b - a));
const eio = (x: number) => ((x = cl(x)), x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const eo = (x: number) => 1 - Math.pow(1 - cl(x), 3);
const eo4 = (x: number) => 1 - Math.pow(1 - cl(x), 4);

function readColors(): Colors {
  const s = getComputedStyle(document.documentElement);
  const g = (n: string) => s.getPropertyValue("--" + n).trim();
  return {
    crit: g("sev-critical"), high: g("sev-high"), med: g("sev-medium"), low: g("sev-low"),
    bg: g("bg-primary"), pt: g("primary-text"), text: g("text-primary"), muted: g("text-muted"),
    t2: g("text-secondary"), tint: g("primary-tint"),
  };
}

function pos(S: Graph, n: Graph["nodes"][number], u: number, t: number): Pt {
  const c = eio(rp(u, 1.1, 1.95));
  const d = (1 - c) * (S.cp ? 7 : 11);
  const x = n.sx + Math.sin(t * 0.7 + n.ph) * d;
  const y = n.sy + Math.cos(t * 0.55 + n.ph * 1.3) * d;
  return [x + (n.tx - x) * c, y + (n.ty - y) * c];
}

function draw(c: CanvasRenderingContext2D, S: Graph, C: Colors, u: number, t: number, G: number) {
  const { cp, cx, cy, hubR: R } = S;
  const P: Record<string, Pt> = { hub: [cx, cy] };
  const al: Record<string, number> = {};
  const hp = eo(rp(u, 2, 2.45));
  c.clearRect(0, 0, S.vw, S.h);
  for (const n of S.nodes) {
    P[n.id] = pos(S, n, u, t);
    const a = eo(rp(u, n.ap, n.ap + 0.25));
    al[n.id] = n.kind === "dom" && n.id !== "d3" ? a * (0.42 + 0.58 * rp(u, 1.35, 1.9)) : a;
  }
  const halo = (s: string, x: number, y: number) => {
    c.lineWidth = 3.5;
    c.lineJoin = "round";
    c.strokeStyle = C.bg;
    c.strokeText(s, x, y);
    c.fillText(s, x, y);
  };

  for (const l of S.links) {
    const p = eo(rp(u, l.t0, l.t0 + l.dur));
    if (p <= 0) continue;
    const a = P[l.a];
    const e = linkEnd(S, a, P[l.b], l.b === "hub", p);
    c.globalAlpha = G * (l.kind === "ev" ? 0.5 : 0.6);
    c.strokeStyle = C.pt;
    c.lineWidth = l.kind === "ev" ? 1 : 1.2;
    c.setLineDash(l.kind === "rel" ? [3, 4] : []);
    c.beginPath();
    c.moveTo(a[0], a[1]);
    c.lineTo(e[0], e[1]);
    c.stroke();
    c.setLineDash([]);
    if (p < 1) {
      c.globalAlpha = G;
      c.fillStyle = C.text;
      c.beginPath();
      c.arc(e[0], e[1], 2, 0, 6.3);
      c.fill();
    }
  }

  if (hp > 0) {
    c.globalAlpha = G * hp;
    c.fillStyle = C.tint;
    c.beginPath();
    c.arc(cx, cy, R, 0, 6.3);
    c.fill();
    const pg = rp(u, 2.5, 3.1);
    c.strokeStyle = C.pt;
    c.lineWidth = 1;
    if (pg > 0 && pg < 1) {
      c.globalAlpha = G * (1 - pg) * 0.5;
      c.beginPath();
      c.arc(cx, cy, R + pg * 26, 0, 6.3);
      c.stroke();
    }
    c.globalAlpha = G;
    c.lineWidth = 1.6;
    c.beginPath();
    c.arc(cx, cy, R, -1.5708, -1.5708 + 6.2832 * hp);
    c.stroke();
  }

  const removed = (id: string) => {
    const s = S.st[id];
    return s && typeof s === "object" ? cl((u - s.rm) / 0.08) : 0;
  };
  for (const n of S.nodes) {
    const a = al[n.id] * G;
    if (a <= 0) continue;
    const q = P[n.id];
    const rm = removed(n.id);
    const col = C[n.col];
    const r = n.r * (0.85 + 0.15 * eo(rp(u, n.ap, n.ap + 0.25)));
    if (n.id === "d3") {
      const hl = rp(u, 0.1, 0.4) * (1 - rp(u, 1.9, 2.3));
      const pg = rp(u, 0.15, 0.7);
      if (hl > 0) {
        c.globalAlpha = a * hl * 0.85;
        c.strokeStyle = C.pt;
        c.lineWidth = 1.2;
        c.beginPath();
        c.arc(q[0], q[1], r + 6, 0, 6.3);
        c.stroke();
        if (pg < 1) {
          c.globalAlpha = a * hl * (1 - pg) * 0.5;
          c.beginPath();
          c.arc(q[0], q[1], r + 6 + pg * 14, 0, 6.3);
          c.stroke();
        }
      }
    }
    c.lineWidth = 2;
    c.fillStyle = C.bg;
    c.strokeStyle = rm > 0 ? C.muted : col;
    c.globalAlpha = rm > 0 ? a * (0.35 + 0.65 * (1 - rm)) : a;
    c.beginPath();
    c.arc(q[0], q[1], r, 0, 6.3);
    c.fill();
    c.stroke();
    if (rm <= 0) {
      c.fillStyle = col;
      c.globalAlpha = a * 0.9;
      c.beginPath();
      c.arc(q[0], q[1], r * 0.38, 0, 6.3);
      c.fill();
    }
    const pv = S.st[n.id] === "submitted" ? rp(u, 3.35, 3.5) : 0;
    if (pv > 0) {
      c.globalAlpha = a * pv;
      c.strokeStyle = C.high;
      c.lineWidth = 1;
      c.setLineDash([2, 3]);
      c.beginPath();
      c.arc(q[0], q[1], r + 4, 0, 6.3);
      c.stroke();
      c.setLineDash([]);
    }
  }

  c.textBaseline = "alphabetic";
  for (const n of S.nodes) {
    if (!showsLabel(n, cp)) continue;
    const la =
      n.kind === "dom" ? (n.id === "d3" ? rp(u, 0.15, 0.4) : rp(u, 1.7, 2.05)) : n.kind === "soc" || n.kind === "app" ? rp(u, 2.6, 2.9) : rp(u, n.ap + 0.2, n.ap + 0.45);
    const a = al[n.id] * la * G;
    if (a <= 0) continue;
    const q = P[n.id];
    const lp = labelPos(n, q[0], q[1]);
    c.globalAlpha = a * 0.9 * (1 - 0.45 * removed(n.id));
    c.textAlign = lp.a === "middle" ? "center" : lp.a;
    c.font = "400 " + (cp ? 10 : 11) + "px " + MONO;
    c.fillStyle = C.t2;
    halo(n.label as string, lp.x, lp.y);
    if (n.sub && !cp) {
      c.fillStyle = C.muted;
      halo(n.sub, lp.x, lp.y + 13);
    }
  }

  const H = hubText(S);
  c.textAlign = "center";
  let la = rp(u, 2.4, 2.65) * G;
  if (la > 0) {
    c.globalAlpha = la;
    c.fillStyle = C.pt;
    c.font = "500 " + (cp ? 11 : 14) + "px " + MONO;
    c.fillText(HUB_ID, H.id[0], H.id[1]);
    c.fillStyle = C.muted;
    c.font = "400 " + (cp ? 10 : 11) + "px " + MONO;
    halo(HUB_SUB, H.sub[0], H.sub[1]);
  }
  la = rp(u, 2.45, 2.7) * G;
  if (la > 0) {
    c.globalAlpha = la;
    c.fillStyle = C.text;
    c.font = "600 " + (cp ? 12 : 15) + "px " + SANS;
    halo(HUB_TITLE, H.title[0], H.title[1]);
  }
  la = rp(u, 2.7, 2.95) * G;
  if (la > 0) {
    c.globalAlpha = la * 0.9;
    c.fillStyle = C.t2;
    c.font = "400 " + (cp ? 10 : 11) + "px " + MONO;
    halo(ACTOR_LINE, H.actor[0], H.actor[1]);
  }
  c.globalAlpha = 1;
}

/** Takedown card at story position u (8 taken down · 4 submitted · 2 to approve). */
function cardState(u: number) {
  let rem = 0;
  ORDER.forEach((_, o) => {
    if (u >= 3.3 + o * 0.07 + 0.08) rem++;
  });
  const pv = rp(u, 3.2, 3.4);
  const op = rp(u, 3, 3.2);
  return { op, ty: 8 * (1 - eo(op)), rem, sub: Math.round(4 * pv), apr: Math.round(2 * pv), bs: (4 / 14) * 100 * pv, br: (rem / 14) * 100 };
}

export function start(root: HTMLElement): void {
  const g = root.querySelector<HTMLElement>("[data-hero-g]");
  const cv = root.querySelector<HTMLCanvasElement>("canvas");
  const card = root.querySelector<HTMLElement>("[data-hero-card]");
  const rail = root.querySelector<HTMLElement>("[data-hero-rail]");
  const ctx = cv?.getContext("2d");
  if (!g || !cv || !ctx || !card || !rail) return;
  const q = (k: string) => card.querySelector<HTMLElement>(`[data-n="${k}"]`) as HTMLElement;
  const nRem = q("rem"), nSub = q("sub"), nApr = q("apr"), bRem = q("b-rem"), bSub = q("b-sub");
  const btns = Array.from(rail.querySelectorAll<HTMLButtonElement>("[data-step]"));
  const fills = btns.map((b) => b.querySelector<HTMLElement>(".fl") as HTMLElement);
  const cap = rail.querySelector<HTMLElement>("[data-live-cap]") as HTMLElement;
  const pp = rail.querySelector<HTMLButtonElement>("[data-pp]") as HTMLButtonElement;

  let C = readColors();
  let S = build(false);
  let sc = 1;
  let dpr = 1;
  // Story state: tau = timeline seconds, u = story position 0..4, G = fade.
  let tau = 0, u = 0, G = 1, t = 0, plays = 0;
  let mode: "auto" | "paused" = "auto";
  let tw: { a: number; b: number; t: number; d: number } | null = null;
  let step = 1, fill = 0, cur = 0, uiMode = "";
  let capTimer = 0;
  const fv: number[] = [];

  const render = () => {
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, 0, 0);
    draw(ctx, S, C, u, t, G);
    const s = cardState(u);
    card.style.opacity = String(s.op * G);
    card.style.transform = `translateY(${s.ty}px)`;
    nRem.textContent = String(s.rem);
    nSub.textContent = String(s.sub);
    nApr.textContent = String(s.apr);
    bRem.style.width = s.br + "%";
    bSub.style.width = s.bs + "%";
  };

  const ui = () => {
    if (step !== cur) {
      const first = cur === 0;
      cur = step;
      btns.forEach((b, i) => (i + 1 === step ? b.setAttribute("aria-current", "step") : b.removeAttribute("aria-current")));
      const text = btns[step - 1].dataset.cap ?? "";
      window.clearTimeout(capTimer);
      if (first) cap.textContent = text;
      else {
        cap.classList.add("sw");
        capTimer = window.setTimeout(() => {
          cap.textContent = text;
          cap.classList.remove("sw");
        }, 120);
      }
    }
    fills.forEach((e, i) => {
      let v = i + 1 < step ? 1 : i + 1 === step ? (mode === "auto" ? fill : 1) : 0;
      v = Math.round(v * 500) / 500;
      if (fv[i] !== v) {
        fv[i] = v;
        e.style.transform = `scaleX(${v})`;
      }
    });
    if (mode !== uiMode) {
      uiMode = mode;
      pp.setAttribute("aria-label", mode === "paused" ? "Play step animation" : "Pause step animation");
      pp.dataset.state = mode;
    }
  };

  const size = () => {
    const w = g.clientWidth;
    const cp = w <= 619.98; // same threshold as the CSS container query
    if (cp !== S.cp) S = build(cp);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    sc = w / S.vw;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(S.h * sc * dpr);
    render();
  };

  // ── rAF loop: runs only while something moves and the hero is visible ──
  let raf = 0, running = false, visible = true, lastTick = 0;
  const active = () => mode === "auto" || tw !== null;
  const frame = (now: number) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    tick(now);
  };
  const go = () => {
    if (!running && visible && !document.hidden && active()) {
      running = true;
      lastTick = 0;
      raf = requestAnimationFrame(frame);
    }
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };

  const tick = (now: number) => {
    const dt = lastTick ? Math.min((now - lastTick) / 1e3, 0.1) * SPEED : 0;
    lastTick = now;
    if (tw) {
      t += dt;
      const k = cl((now - tw.t) / tw.d);
      u = tw.a + (tw.b - tw.a) * eo4(k);
      if (k >= 1) tw = null;
    } else if (mode === "auto") {
      t += dt;
      tau += dt;
      if (tau >= TOT && plays >= PLAYS - 1) {
        // Final pass: rest on the finished operation, no fade-out.
        u = 4; G = 1; step = 4; fill = 1; mode = "paused"; tau = TOT;
      } else {
        if (tau >= TOT + OUT + GAP) {
          tau = 0;
          plays++;
        }
        let k0 = 3;
        while (k0 > 0 && tau < ST[k0]) k0--;
        const L = SEG[k0][0];
        u = tau - ST[k0] < L ? k0 + (tau - ST[k0]) / L : k0 + 1;
        G = 1 - rp(tau, TOT, TOT + OUT);
        step = k0 + 1;
        fill = cl((tau - ST[k0]) / (L + SEG[k0][1]));
        if (tau >= TOT) {
          u = 4;
          fill = 1;
        }
      }
    }
    render();
    ui();
    if (!active()) stop();
  };

  // The live caption stays silent during autoplay (it changes every few
  // seconds); once the visitor takes control it announces each step.
  const engage = () => cap.setAttribute("aria-live", "polite");

  const jump = (j: number) => {
    engage();
    mode = "paused";
    step = j;
    G = 1;
    tw = { a: u, b: j, t: performance.now(), d: 480 };
    tau = ST[j - 1] + SEG[j - 1][0];
    ui();
    go();
  };
  const toggle = () => {
    engage();
    if (mode === "auto") {
      mode = "paused";
      stop();
      if (G < 1 || tau >= TOT) {
        // Paused during the fade-out / gap between plays: settle on the
        // finished operation instead of freezing a faded or blank frame.
        u = 4; G = 1; step = 4; fill = 1; tau = TOT; tw = null;
      } else if (tw) {
        u = tw.b;
        tw = null;
      }
      render();
      ui();
      return;
    }
    mode = "auto";
    G = 1;
    if (u >= 4 && step === 4 && tau >= TOT) {
      // Finished: Play replays the story from the start.
      tau = 0; u = 0; step = 1; plays = PLAYS - 1;
    } else {
      tw = Math.abs(u - step) > 0.01 ? { a: u, b: step, t: performance.now(), d: 240 } : null;
      tau = ST[step - 1] + SEG[step - 1][0];
    }
    ui();
    go();
  };

  btns.forEach((b) => b.addEventListener("click", () => jump(Number(b.dataset.step))));
  pp.addEventListener("click", toggle);

  new ResizeObserver(size).observe(g);
  // Re-size the backing store when the device pixel ratio changes (zoom,
  // moving the window to another screen).
  const watchDpr = () =>
    matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`).addEventListener?.(
      "change",
      () => {
        size();
        watchDpr();
      },
      { once: true },
    );
  watchDpr();
  new IntersectionObserver((e) => {
    visible = e[0].isIntersecting;
    if (visible) go();
    else stop();
  }).observe(root);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : go()));
  // Theme toggle: re-read the tokens and repaint the current frame.
  new MutationObserver(() => {
    C = readColors();
    render();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  // Reduced motion switched on mid-visit: settle on the finished operation.
  const rm = matchMedia("(prefers-reduced-motion: reduce)");
  rm.addEventListener?.("change", () => {
    if (rm.matches) {
      mode = "paused"; tw = null; u = 4; G = 1; step = 4; tau = TOT;
      stop(); render(); ui();
    }
  });

  size();
  ui();
  root.dataset.hero = "live";
  // Canvas text needs Geist; swap the poster out once fonts are ready.
  const show = () => {
    render();
    root.classList.add("live");
    go();
  };
  if (document.fonts?.ready) document.fonts.ready.then(show, show);
  else show();
}
