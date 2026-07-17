// ─────────────────────────────────────────────────────────────────────────────
// AVERROW — GLOBAL THREAT HEATMAP COMPONENT
//
// Overhauled from trust-radar-heatmap.html reference implementation.
// Includes inlined Leaflet.heat (no CDN dependency), stats row,
// live feed, legend panel, and top countries.
//
// BUG FIXES DOCUMENTED HERE:
//
// BUG 1 (CRITICAL): Map canvas renders at 0px height — invisible
//   Root cause: #map div had no explicit height declaration.
//   Leaflet requires a real pixel height at mount time.
//   Fix: #threat-map { height: 520px; width: 100%; display: block; }
//   NEVER use height: auto or height: 100% without a sized parent.
//
// BUG 2 (LIGHT MODE): Heat blobs invisible on CartoDB Positron tiles
//   Root cause: cyan/amber/red gradient has near-zero contrast on white.
//   Fix: swap gradient in light mode → cobalt/burnt-orange/deep-red.
//   Also: reduce blur (28→22) and raise minOpacity (0.05→0.25).
//
// BUG 3 (LIGHT MODE): Dark tile layer active on light-mode page
//   Root cause: tile layer not swapped when theme changes.
//   Fix: setTheme() calls applyTileLayer() + applyHeatLayer() together.
// ─────────────────────────────────────────────────────────────────────────────

export const HEATMAP_CSS = `
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css"/>
<style>
  /* ── CRITICAL HEIGHT FIX ──────────────────────────────────────────────── */
  /* height MUST be explicit pixels. Never auto or % without sized parent.   */
  #threat-map {
    height: var(--map-height, 520px);
    width: 100%;
    display: block;  /* Prevent inline/flex collapse to 0 */
    z-index: 1;
  }

  .map-wrap { position: relative; }

  /* ── STATS ROW ──────────────────────────────────────────────────────────── */
  .hm-stats-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 16px;
  }
  .hm-stat-card {
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.08));
    border-radius: 8px;
    padding: 14px 16px;
    position: relative;
    overflow: hidden;
  }
  .hm-stat-card::before {
    content: '';
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 2px;
  }
  .hm-stat-card.c::before { background: var(--cyan, #78A0C8); }
  .hm-stat-card.a::before { background: var(--amber, #E8923C); }
  .hm-stat-card.r::before { background: var(--red, #C83C3C); }
  .hm-stat-card.g::before { background: var(--green, #28A050); }
  .hm-stat-label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 9px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--subtext, #8A8F9C);
    margin-bottom: 6px;
  }
  .hm-stat-value {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 22px;
    font-weight: 700;
    line-height: 1;
    color: var(--text, #F0EDE8);
  }
  .hm-stat-value .unit {
    font-size: 12px;
    color: var(--subtext, #8A8F9C);
    margin-left: 3px;
  }
  .hm-stat-delta { font-size: 11px; margin-top: 4px; }
  .hm-stat-delta.up { color: var(--red, #C83C3C); }
  .hm-stat-delta.dn { color: var(--green, #28A050); }

  /* ── MAP PANEL ──────────────────────────────────────────────────────────── */
  .hm-map-panel {
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.08));
    border-radius: 8px;
    overflow: hidden;
    position: relative;
  }
  .hm-map-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border, rgba(120,160,200,0.08));
    flex-wrap: wrap;
    gap: 8px;
  }
  .hm-map-title {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--text, #F0EDE8);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hm-map-controls {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hm-filter-btn {
    padding: 5px 12px;
    border-radius: 4px;
    border: 1px solid var(--border, rgba(120,160,200,0.08));
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: transparent;
    color: var(--subtext, #8A8F9C);
    transition: all 0.2s;
  }
  .hm-filter-btn:hover { color: var(--text, #F0EDE8); border-color: var(--cyan, #C83C3C); }
  .hm-filter-btn.active {
    background: rgba(200,60,60,0.08);
    color: var(--cyan, #C83C3C);
    border-color: var(--cyan, #C83C3C);
  }
  [data-theme="light"] .hm-filter-btn.active {
    background: rgba(200,60,60,0.08);
    color: var(--cyan, #C83C3C);
    border-color: var(--cyan, #C83C3C);
  }

  /* ── LEAFLET CONTROLS — DARK MODE ────────────────────────────────────── */
  [data-theme="dark"] .leaflet-control-zoom a {
    background: #080E18;
    color: #F0EDE8;
    border-color: rgba(120,160,200,0.15);
  }
  [data-theme="dark"] .leaflet-control-zoom a:hover {
    background: #0C1420;
  }
  [data-theme="dark"] .leaflet-control-attribution {
    background: rgba(8,14,24,0.85);
    color: #8A8F9C;
    font-size: 10px;
  }

  /* ── LEAFLET CONTROLS — LIGHT MODE ──────────────────────────────────── */
  [data-theme="light"] .leaflet-control-zoom a {
    background: #ffffff;
    color: #0F1628;
    border-color: #CBD5E1;
  }
  [data-theme="light"] .leaflet-control-zoom a:hover {
    background: #F1F5F9;
  }
  [data-theme="light"] .leaflet-control-attribution {
    background: rgba(255,255,255,0.85);
    color: #64748B;
    font-size: 10px;
  }

  /* ── TOOLTIPS ─────────────────────────────────────────────────────────── */
  .leaflet-tooltip-threat {
    background: var(--surface, #080E18) !important;
    border: 1px solid var(--border, rgba(120,160,200,0.12)) !important;
    color: var(--text, #F0EDE8) !important;
    font-family: 'IBM Plex Mono', monospace !important;
    font-size: 11px !important;
    border-radius: 5px !important;
    padding: 6px 10px !important;
    box-shadow: 0 4px 16px rgba(0,0,0,0.25) !important;
  }
  [data-theme="light"] .leaflet-tooltip-threat {
    background: #fff !important;
    border: 1px solid rgba(15,30,80,0.15) !important;
    color: #0F1628 !important;
    box-shadow: 0 4px 12px rgba(0,0,0,0.1) !important;
  }

  /* ── MAP OVERLAY BADGE ───────────────────────────────────────────────── */
  .map-live-badge {
    position: absolute;
    top: 14px; left: 14px;
    z-index: 500;
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.12));
    border-radius: 6px;
    padding: 8px 14px;
    pointer-events: none;
    backdrop-filter: blur(8px);
  }
  [data-theme="light"] .map-live-badge {
    background: rgba(255,255,255,0.9);
  }
  .map-live-badge .count {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 18px;
    font-weight: 700;
    color: var(--cyan, #C83C3C);
    line-height: 1;
  }
  .map-live-badge .label {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--subtext, #8A8F9C);
    margin-top: 2px;
    letter-spacing: 0.5px;
  }
  [data-theme="light"] .map-live-badge .count {
    color: #C83C3C;
  }

  /* ── MODE TOGGLE ─────────────────────────────────────────────────────── */
  .map-mode-toggle {
    display: flex;
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.12));
    border-radius: 6px;
    padding: 3px;
    gap: 2px;
  }
  .map-mode-btn {
    padding: 5px 10px;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 0.5px;
    text-transform: uppercase;
    background: transparent;
    color: var(--subtext, #8A8F9C);
    transition: all 0.2s;
  }
  .map-mode-btn.active {
    background: var(--surface2, #0C1420);
    color: var(--text, #F0EDE8);
    box-shadow: 0 1px 3px rgba(0,0,0,0.3);
  }
  [data-theme="light"] .map-mode-btn.active {
    box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  }

  /* ── BOTTOM ROW: FEED + LEGEND ───────────────────────────────────────── */
  .hm-bottom-row {
    display: grid;
    grid-template-columns: 1fr 280px;
    gap: 12px;
    margin-top: 12px;
  }
  @media (max-width: 768px) {
    .hm-bottom-row { grid-template-columns: 1fr; }
  }

  /* ── LIVE FEED ───────────────────────────────────────────────────────── */
  .hm-threat-feed {
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.08));
    border-radius: 8px;
    overflow: hidden;
  }
  .hm-feed-header {
    padding: 10px 14px;
    border-bottom: 1px solid var(--border, rgba(120,160,200,0.08));
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--subtext, #8A8F9C);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .hm-feed-list {
    max-height: 160px;
    overflow: hidden;
  }
  .hm-feed-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-bottom: 1px solid var(--border, rgba(120,160,200,0.08));
    animation: hm-feed-in 0.4s ease;
    font-size: 12px;
  }
  @keyframes hm-feed-in {
    from { opacity: 0; transform: translateY(-8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .hm-feed-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .hm-feed-dot.phishing { background: var(--red, #C83C3C); }
  .hm-feed-dot.malware  { background: var(--amber, #E8923C); }
  .hm-feed-dot.scam     { background: #78A0C8; }
  .hm-feed-dot.safe     { background: var(--green, #28A050); }
  .hm-feed-domain {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    color: var(--text, #F0EDE8);
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hm-feed-meta {
    color: var(--subtext, #8A8F9C);
    font-size: 11px;
    white-space: nowrap;
  }
  .hm-feed-score {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 11px;
    font-weight: 600;
    padding: 2px 6px;
    border-radius: 3px;
  }
  .hm-feed-score.high  { background: rgba(200,60,60,0.15);  color: var(--red, #C83C3C); }
  .hm-feed-score.med   { background: rgba(232,146,60,0.15); color: var(--amber, #E8923C); }
  .hm-feed-score.low   { background: rgba(40,160,80,0.15);  color: var(--green, #28A050); }

  /* ── LEGEND PANEL ────────────────────────────────────────────────────── */
  .hm-legend-panel {
    background: var(--surface, #080E18);
    border: 1px solid var(--border, rgba(120,160,200,0.08));
    border-radius: 8px;
    padding: 14px 16px;
  }
  .hm-legend-title {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--subtext, #8A8F9C);
    margin-bottom: 12px;
  }
  .hm-legend-gradient {
    height: 10px;
    border-radius: 5px;
    margin-bottom: 6px;
  }
  [data-theme="dark"] .hm-legend-gradient {
    background: linear-gradient(to right, #78A0C8, #E8923C, #C83C3C);
  }
  [data-theme="light"] .hm-legend-gradient {
    background: linear-gradient(to right, #5A80A8, #C47428, #A82E2E);
  }
  .hm-legend-labels {
    display: flex;
    justify-content: space-between;
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--subtext, #8A8F9C);
    margin-bottom: 14px;
  }
  .hm-legend-item {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 12px;
    color: var(--text, #F0EDE8);
  }
  .hm-legend-swatch {
    width: 28px; height: 8px;
    border-radius: 4px;
    flex-shrink: 0;
  }
  .hm-top-countries { margin-top: 14px; }
  .hm-tc-title {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    letter-spacing: 1.5px;
    text-transform: uppercase;
    color: var(--subtext, #8A8F9C);
    margin-bottom: 10px;
  }
  .hm-tc-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 7px;
    font-size: 12px;
  }
  .hm-tc-flag { font-size: 14px; }
  .hm-tc-name { flex: 1; color: var(--text, #F0EDE8); }
  .hm-tc-bar-track {
    width: 70px;
    height: 4px;
    background: var(--surface2, #0C1420);
    border-radius: 2px;
    overflow: hidden;
  }
  .hm-tc-bar-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--cyan, #78A0C8);
    transition: width 1s ease;
  }
  .hm-tc-count {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 10px;
    color: var(--subtext, #8A8F9C);
    width: 32px;
    text-align: right;
  }

  /* ── LIVE DOT ────────────────────────────────────────────────────────── */
  .hm-live-dot {
    width: 7px; height: 7px;
    background: var(--red, #C83C3C);
    border-radius: 50%;
    animation: hm-pulse-dot 1.5s ease-in-out infinite;
  }
  @keyframes hm-pulse-dot {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.4; transform: scale(0.7); }
  }
</style>
`;

export const HEATMAP_HTML = `
<!-- STATS ROW -->
<div class="hm-stats-row">
  <div class="hm-stat-card c">
    <div class="hm-stat-label">Scans Today</div>
    <div class="hm-stat-value" id="hm-stat-scans">\u2014<span class="unit">urls</span></div>
    <div class="hm-stat-delta up" id="hm-stat-scans-d"></div>
  </div>
  <div class="hm-stat-card r">
    <div class="hm-stat-label">Threats Flagged</div>
    <div class="hm-stat-value" id="hm-stat-threats">\u2014</div>
    <div class="hm-stat-delta up" id="hm-stat-threats-d"></div>
  </div>
  <div class="hm-stat-card a">
    <div class="hm-stat-label">Countries Active</div>
    <div class="hm-stat-value" id="hm-stat-countries">\u2014</div>
  </div>
  <div class="hm-stat-card g">
    <div class="hm-stat-label">Avg Trust Score</div>
    <div class="hm-stat-value" id="hm-stat-avg">\u2014<span class="unit">/100</span></div>
  </div>
</div>

<!-- MAP PANEL -->
<div class="hm-map-panel">
  <div class="hm-map-toolbar">
    <div class="hm-map-title">
      <div class="hm-live-dot"></div>
      Global Threat Heatmap \u2014 Live
    </div>
    <div class="hm-map-controls">
      <button class="hm-filter-btn active" onclick="window._hmSetFilter('all', this)">All</button>
      <button class="hm-filter-btn" onclick="window._hmSetFilter('phishing', this)">Phishing</button>
      <button class="hm-filter-btn" onclick="window._hmSetFilter('malware', this)">Malware</button>
    </div>
  </div>

  <div class="map-wrap">
    <div id="threat-map"></div>
    <div class="map-live-badge">
      <div class="count" id="hm-threat-count">\u2014</div>
      <div class="label">threats \u00b7 24h</div>
    </div>
  </div>
</div>

<!-- BOTTOM ROW -->
<div class="hm-bottom-row">
  <!-- LIVE FEED -->
  <div class="hm-threat-feed">
    <div class="hm-feed-header">
      <div class="hm-live-dot"></div>
      Live Scan Feed
    </div>
    <div class="hm-feed-list" id="hm-feed-list"></div>
  </div>

  <!-- LEGEND + TOP COUNTRIES -->
  <div class="hm-legend-panel">
    <div class="hm-legend-title">Heat Scale</div>
    <div class="hm-legend-gradient"></div>
    <div class="hm-legend-labels">
      <span>Low risk</span>
      <span>Medium</span>
      <span>High risk</span>
    </div>
    <div class="hm-legend-item">
      <div class="hm-legend-swatch" style="background:rgba(200,60,60,0.8)"></div>
      Phishing / High Threat
    </div>
    <div class="hm-legend-item">
      <div class="hm-legend-swatch" style="background:rgba(232,146,60,0.8)"></div>
      Malware / Suspicious
    </div>
    <div class="hm-legend-item">
      <div class="hm-legend-swatch" style="background:rgba(120,160,200,0.6)"></div>
      Low Risk / Monitored
    </div>

    <div class="hm-top-countries">
      <div class="hm-tc-title">Top Origins</div>
      <div id="hm-tc-list"></div>
    </div>
  </div>
</div>
`;

export const HEATMAP_SCRIPTS = `
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"><\/script>
<!-- Inline Leaflet.heat — avoids CDN dependency. Source: Leaflet/Leaflet.heat, MIT License -->
<script>
(function(){
  function simpleheat(canvas) {
    if (!(this instanceof simpleheat)) return new simpleheat(canvas);
    this._canvas = canvas = typeof canvas === 'string' ? document.getElementById(canvas) : canvas;
    this._ctx = canvas.getContext('2d');
    this._width = canvas.width;
    this._height = canvas.height;
    this._max = 1;
    this._data = [];
  }
  simpleheat.prototype = {
    defaultRadius: 25,
    defaultGradient: {0.4:'blue',0.65:'lime',1:'red'},
    data: function(data){ this._data = data; return this; },
    max: function(max){ this._max = max; return this; },
    add: function(point){ this._data.push(point); return this; },
    clear: function(){ this._data = []; return this; },
    radius: function(r, blur){
      blur = blur === undefined ? 15 : blur;
      var circle = this._circle = this._createCanvas(),
          ctx = circle.getContext('2d'),
          r2 = this._r = r + blur;
      circle.width = circle.height = r2 * 2;
      ctx.shadowOffsetX = ctx.shadowOffsetY = r2 * 2;
      ctx.shadowBlur = blur;
      ctx.shadowColor = 'black';
      ctx.beginPath();
      ctx.arc(-r2, -r2, r, 0, Math.PI * 2, true);
      ctx.closePath();
      ctx.fill();
      return this;
    },
    resize: function(){
      this._width = this._canvas.width;
      this._height = this._canvas.height;
    },
    gradient: function(grad){
      var canvas = this._createCanvas(),
          ctx = canvas.getContext('2d'),
          gradient = ctx.createLinearGradient(0, 0, 0, 256);
      canvas.width = 1; canvas.height = 256;
      for (var i in grad) gradient.addColorStop(+i, grad[i]);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1, 256);
      this._grad = ctx.getImageData(0, 0, 1, 256).data;
      return this;
    },
    draw: function(minOpacity){
      if (!this._circle) this.radius(this.defaultRadius);
      if (!this._grad) this.gradient(this.defaultGradient);
      var ctx = this._ctx;
      ctx.clearRect(0, 0, this._width, this._height);
      for (var i = 0, len = this._data.length, p; i < len; i++) {
        p = this._data[i];
        ctx.globalAlpha = Math.min(Math.max(p[2] / this._max, minOpacity === undefined ? 0.05 : minOpacity), 1);
        ctx.drawImage(this._circle, p[0] - this._r, p[1] - this._r);
      }
      var colored = ctx.getImageData(0, 0, this._width, this._height);
      this._colorize(colored.data, this._grad);
      ctx.putImageData(colored, 0, 0);
      return this;
    },
    _colorize: function(pixels, gradient){
      for (var i = 0, len = pixels.length, j; i < len; i += 4) {
        j = pixels[i + 3] * 4;
        if (j) {
          pixels[i]     = gradient[j];
          pixels[i + 1] = gradient[j + 1];
          pixels[i + 2] = gradient[j + 2];
        }
      }
    },
    _createCanvas: function(){
      if (typeof document !== 'undefined') return document.createElement('canvas');
      return new (typeof Canvas !== 'undefined' ? Canvas : Object)();
    }
  };
  window.simpleheat = simpleheat;
  if (typeof L === 'undefined') return;
  L.HeatLayer = (L.Layer ? L.Layer : L.Class).extend({
    initialize: function(latlngs, options) {
      this._latlngs = latlngs;
      L.setOptions(this, options);
    },
    setLatLngs: function(latlngs) { this._latlngs = latlngs; return this.redraw(); },
    addLatLng: function(latlng) { this._latlngs.push(latlng); return this.redraw(); },
    setOptions: function(options) {
      L.setOptions(this, options);
      if (this._heat) { this._updateOptions(); }
      return this.redraw();
    },
    redraw: function() {
      if (this._heat && !this._frame && this._map && !this._map._animating) {
        this._frame = L.Util.requestAnimFrame(this._redraw, this);
      }
      return this;
    },
    onAdd: function(map) {
      this._map = map;
      if (!this._canvas) { this._initCanvas(); }
      if (this.options.pane) { this.getPane().appendChild(this._canvas); }
      else { map._panes.overlayPane.appendChild(this._canvas); }
      map.on('moveend', this._reset, this);
      if (map.options.zoomAnimation && L.Browser.any3d) {
        map.on('zoomanim', this._animateZoom, this);
      }
      this._reset();
    },
    onRemove: function(map) {
      if (this.options.pane) { this.getPane().removeChild(this._canvas); }
      else { map.getPanes().overlayPane.removeChild(this._canvas); }
      map.off('moveend', this._reset, this);
      if (map.options.zoomAnimation) { map.off('zoomanim', this._animateZoom, this); }
    },
    addTo: function(map) { map.addLayer(this); return this; },
    _initCanvas: function() {
      var canvas = this._canvas = L.DomUtil.create('canvas', 'leaflet-heatmap-layer leaflet-layer');
      var originProp = L.DomUtil.testProp(['transformOrigin', 'WebkitTransformOrigin', 'msTransformOrigin']);
      canvas.style[originProp] = '50% 50%';
      var animated = this._map.options.zoomAnimation && L.Browser.any3d;
      L.DomUtil.addClass(canvas, 'leaflet-zoom-' + (animated ? 'animated' : 'hide'));
      this._heat = simpleheat(canvas);
      this._updateOptions();
    },
    _updateOptions: function() {
      this._heat.radius(this.options.radius || this._heat.defaultRadius, this.options.blur);
      if (this.options.gradient) { this._heat.gradient(this.options.gradient); }
      if (this.options.max) { this._heat.max(this.options.max); }
    },
    _reset: function() {
      var topLeft = this._map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      var size = this._map.getSize();
      if (this._heat._width !== size.x) { this._canvas.width = this._heat._width = size.x; }
      if (this._heat._height !== size.y) { this._canvas.height = this._heat._height = size.y; }
      this._redraw();
    },
    _redraw: function() {
      this._frame = null;
      if (!this._map) return;
      var data = [], r = this._heat._r, size = this._map.getSize(),
          bounds = new L.Bounds(L.point([-r, -r]), size.add([r, r])),
          max = this.options.max === undefined ? 1 : this.options.max,
          maxZoom = this.options.maxZoom === undefined ? this._map.getMaxZoom() : this.options.maxZoom,
          v = 1 / Math.pow(2, Math.max(0, Math.min(maxZoom - this._map.getZoom(), 12))),
          cellSize = r / 2, grid = [],
          panePos = this._map._getMapPanePos(),
          offsetX = panePos.x % cellSize, offsetY = panePos.y % cellSize,
          i, len, p, cell, x, y, j, len2, k;
      for (i = 0, len = this._latlngs.length; i < len; i++) {
        p = this._map.latLngToContainerPoint(this._latlngs[i]);
        if (bounds.contains(p)) {
          x = Math.floor((p.x - offsetX) / cellSize) + 2;
          y = Math.floor((p.y - offsetY) / cellSize) + 2;
          var alt = this._latlngs[i].alt !== undefined ? this._latlngs[i].alt :
                    (this._latlngs[i][2] !== undefined ? +this._latlngs[i][2] : 1);
          k = alt * v;
          grid[y] = grid[y] || [];
          cell = grid[y][x];
          if (!cell) { grid[y][x] = [p.x, p.y, k]; }
          else {
            cell[0] = (cell[0] * cell[2] + p.x * k) / (cell[2] + k);
            cell[1] = (cell[1] * cell[2] + p.y * k) / (cell[2] + k);
            cell[2] += k;
          }
        }
      }
      for (i = 0, len = grid.length; i < len; i++) {
        if (grid[i]) {
          for (j = 0, len2 = grid[i].length; j < len2; j++) {
            cell = grid[i][j];
            if (cell) data.push([Math.round(cell[0]), Math.round(cell[1]), Math.min(cell[2], max)]);
          }
        }
      }
      this._heat.data(data).draw(this.options.minOpacity);
      this._frame = null;
    },
    _animateZoom: function(e) {
      var scale = this._map.getZoomScale(e.zoom),
          offset = this._map._getCenterOffset(e.center)._multiplyBy(-scale).subtract(this._map._getMapPanePos());
      if (L.DomUtil.setTransform) { L.DomUtil.setTransform(this._canvas, offset, scale); }
      else { this._canvas.style[L.DomUtil.TRANSFORM] = L.DomUtil.getTranslateString(offset) + ' scale(' + scale + ')'; }
    }
  });
  L.heatLayer = function(latlngs, options) { return new L.HeatLayer(latlngs, options); };
})();
<\/script>

<script>
(function() {
  var TILE_CONFIGS = {
    dark: {
      url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
      gradient: { 0.15: '#78A0C8', 0.45: '#E8923C', 0.75: '#C83C3C', 1.0: '#8B1A1A' },
      minOpacity: 0.07,
      blur: 28,
      radius: 38
    },
    light: {
      url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
      gradient: { 0.15: '#5A80A8', 0.45: '#C47428', 0.75: '#A82E2E', 1.0: '#8B1A1A' },
      minOpacity: 0.25,
      blur: 22,
      radius: 38
    }
  };

  var map, tileLayer, heatLayer, markerLayer;
  var currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  var currentFilter = 'all';
  var heatData = [];

  function initMap() {
    map = L.map('threat-map', {
      zoomControl: true,
      scrollWheelZoom: true,
      attributionControl: true,
      preferCanvas: true
    }).setView([25, 15], 2);

    markerLayer = L.layerGroup().addTo(map);
    applyTileLayer(currentTheme);
    loadHeatData();
  }

  function applyTileLayer(theme) {
    if (tileLayer) tileLayer.remove();
    tileLayer = L.tileLayer(TILE_CONFIGS[theme].url, {
      maxZoom: 19,
      subdomains: 'abcd',
      attribution: '\\u00a9 <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> \\u00a9 <a href="https://carto.com/attributions">CARTO</a>'
    }).addTo(map);
  }

  function applyHeatLayer(theme, data) {
    var cfg = TILE_CONFIGS[theme];
    if (heatLayer) heatLayer.remove();
    if (!data || data.length === 0) return;
    heatLayer = L.heatLayer(data.map(function(p) { return [p.lat, p.lng, p.intensity]; }), {
      radius: cfg.radius,
      blur: cfg.blur,
      maxZoom: 6,
      max: 1.0,
      minOpacity: cfg.minOpacity,
      gradient: cfg.gradient
    }).addTo(map);
  }

  async function loadHeatData() {
    try {
      var params = new URLSearchParams({ hours: '24', filter: currentFilter });
      var res = await fetch('/api/heatmap?' + params);
      var json = await res.json();
      var payload = json.data || json;
      heatData = payload.points || [];
      var stats = payload.stats || {};

      var el = document.getElementById('hm-threat-count');
      if (el) el.textContent = (stats.totalThreats || 0).toLocaleString();

      updateStatCards(stats);
      if (markerLayer) markerLayer.clearLayers();
      addMarkers(heatData.slice(0, 20));
      applyHeatLayer(currentTheme, heatData);
    } catch (err) {
      console.error('Heatmap data load failed:', err);
    }
  }

  function updateStatCards(stats) {
    var scansEl = document.getElementById('hm-stat-scans');
    var threatsEl = document.getElementById('hm-stat-threats');
    var countriesEl = document.getElementById('hm-stat-countries');
    if (scansEl && stats.totalScans != null) animateCounter(scansEl, stats.totalScans);
    if (threatsEl && stats.totalThreats != null) animateCounter(threatsEl, stats.totalThreats);
    if (countriesEl && stats.uniqueCountries != null) countriesEl.textContent = stats.uniqueCountries;
  }

  function animateCounter(el, target) {
    var v = 0;
    var step = Math.max(1, Math.ceil(target / 60));
    var t = setInterval(function() {
      v = Math.min(v + step, target);
      el.textContent = v.toLocaleString();
      if (v >= target) clearInterval(t);
    }, 16);
  }

  function addMarkers(points) {
    points.forEach(function(p) {
      var score = Math.round((1 - p.intensity) * 100);
      var color = score < 30 ? '#C83C3C' : score < 60 ? '#E8923C' : '#28A050';
      L.circleMarker([p.lat, p.lng], {
        radius: 5,
        color: color,
        fillColor: color,
        fillOpacity: 0.9,
        weight: 1.5
      })
      .bindTooltip(
        '<strong>' + p.city + ', ' + p.country + '</strong><br/>' +
        'Trust score: <strong style="color:' + color + '">' + score + '</strong>',
        { className: 'leaflet-tooltip-threat', sticky: true, direction: 'top' }
      )
      .addTo(markerLayer);
    });
  }

  // ── Live feed (demo data, replaced by real feed when API supports it) ──
  var FEED_DATA = [
    { type: 'phishing', domain: 'secure-update-bank.net',   loc: 'Lagos, NG',       score: 11, cls: 'high' },
    { type: 'malware',  domain: 'cdn-bootstrap-files.ru',   loc: 'Moscow, RU',      score: 8,  cls: 'high' },
    { type: 'scam',     domain: 'getrichfast2025.xyz',       loc: 'Manila, PH',      score: 19, cls: 'high' },
    { type: 'phishing', domain: 'paypal-confirm-login.com',  loc: 'Kyiv, UA',        score: 14, cls: 'high' },
    { type: 'malware',  domain: 'windows-update-kb5.cc',     loc: 'Beijing, CN',     score: 22, cls: 'high' },
    { type: 'safe',     domain: 'github.com',                loc: 'San Jose, US',    score: 97, cls: 'low'  },
    { type: 'phishing', domain: 'amazon-prime-renewal.site', loc: 'Mumbai, IN',      score: 16, cls: 'high' },
    { type: 'malware',  domain: 'free-vpn-unlimited.top',    loc: 'Bucharest, RO',   score: 31, cls: 'med'  },
    { type: 'safe',     domain: 'cloudflare.com',            loc: 'San Francisco',   score: 99, cls: 'low'  },
    { type: 'scam',     domain: 'crypto-airdrop-2025.io',    loc: 'Jakarta, ID',     score: 9,  cls: 'high' },
  ];
  var feedIdx = 0;
  function renderFeed() {
    var list = document.getElementById('hm-feed-list');
    if (!list) return;
    list.innerHTML = '';
    var visible = FEED_DATA.concat(FEED_DATA).slice(feedIdx % FEED_DATA.length, (feedIdx % FEED_DATA.length) + 6);
    visible.forEach(function(item) {
      var el = document.createElement('div');
      el.className = 'hm-feed-item';
      el.innerHTML =
        '<div class="hm-feed-dot ' + item.type + '"></div>' +
        '<div class="hm-feed-domain">' + item.domain + '</div>' +
        '<div class="hm-feed-meta">' + item.loc + '</div>' +
        '<div class="hm-feed-score ' + item.cls + '">' + item.score + '</div>';
      list.appendChild(el);
    });
    feedIdx++;
  }

  // ── Top countries ─────────────────────────────────────────────────────
  var TOP_COUNTRIES = [
    { flag: '\\ud83c\\uddf7\\ud83c\\uddfa', name: 'Russia',  count: 312 },
    { flag: '\\ud83c\\udde8\\ud83c\\uddf3', name: 'China',   count: 401 },
    { flag: '\\ud83c\\uddfa\\ud83c\\udde6', name: 'Ukraine', count: 287 },
    { flag: '\\ud83c\\uddf3\\ud83c\\uddec', name: 'Nigeria', count: 198 },
    { flag: '\\ud83c\\uddee\\ud83c\\uddf7', name: 'Iran',    count: 156 },
  ];
  function renderTopCountries() {
    var el = document.getElementById('hm-tc-list');
    if (!el) return;
    var max = Math.max.apply(null, TOP_COUNTRIES.map(function(c) { return c.count; }));
    el.innerHTML = TOP_COUNTRIES.map(function(c) {
      return '<div class="hm-tc-row">' +
        '<span class="hm-tc-flag">' + c.flag + '</span>' +
        '<span class="hm-tc-name">' + c.name + '</span>' +
        '<div class="hm-tc-bar-track"><div class="hm-tc-bar-fill" style="width:' + Math.round(c.count / max * 100) + '%"></div></div>' +
        '<span class="hm-tc-count">' + c.count + '</span>' +
      '</div>';
    }).join('');
  }

  // ── Public API ────────────────────────────────────────────────────────
  window.heatmapSetTheme = function(theme) {
    currentTheme = theme;
    applyTileLayer(theme);
    applyHeatLayer(theme, heatData);
    setTimeout(function() { map.invalidateSize(); }, 50);
  };
  window.heatmapSetFilter = function(filter) {
    currentFilter = filter;
    loadHeatData();
  };
  window._hmSetFilter = function(filter, btn) {
    document.querySelectorAll('.hm-filter-btn').forEach(function(b) { b.classList.remove('active'); });
    btn.classList.add('active');
    window.heatmapSetFilter(filter);
  };

  // ── Boot ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', function() {
    initMap();
    renderFeed();
    renderTopCountries();
  });
  setInterval(renderFeed, 2500);
  setInterval(loadHeatData, 60000);
})();
<\/script>
`;
