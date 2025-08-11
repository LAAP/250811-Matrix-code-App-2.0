/**
 * Matrix-style Profile Stream - main.js
 *
 * README
 * - Single-file vanilla JS driving a canvas-based Matrix rain. No dependencies.
 * - Each rain column binds to a profile and streams a code-like string.
 * - NYC integration via `data/nyc.js` with caching and offline fallback.
 * - Key configs are exposed on the `CONFIG` object and bound to UI controls.
 * - Generators are light-weight arrays with weighted picks; tweak them in `ProfileFactory` below.
 *
 * Controls
 * - Density: scales number of columns and per-column glyph density.
 * - Speed: scales baseline drip speed across columns.
 * - Glow: intensifies neon blur. Also affected by CSS variable `--glow`.
 * - Screenshot: downloads canvas PNG.
 * - Theme: Green (default), Cyan, Magenta.
 * - FPS: tiny meter top-left.
 *
 * Structure
 * - initCanvas()/resizeCanvas()
 * - MatrixRain class (offscreen glyph sheet, update/draw with glow layers)
 * - ProfileFactory (plausible fake profile fields; biased risk)
 * - DataSource (fake or NYC); StringPainter (string+color map per profile)
 * - UI bindings and RAF ticker
 */

// ---------------------------- Utilities ----------------------------------
const rand = (min, max) => Math.random() * (max - min) + min;
const randi = (min, max) => Math.floor(rand(min, max));
const choice = arr => arr[randi(0, arr.length)];

function weightedChoice(pairs) {
  // pairs: [value, weight]
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * total;
  for (const [v, w] of pairs) {
    if ((roll -= w) <= 0) return v;
  }
  return pairs[pairs.length - 1][0];
}

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function formatMoneyUSD(n) {
  const sign = n < 0 ? '-' : '';
  const x = Math.abs(Math.round(n));
  return `${sign}$${x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

function nowMs() { return performance.now(); }

// ---------------------------- Config -------------------------------------
const CONFIG = {
  densityScale: 1.0, // 0.2..2.0
  speedScale: 1.0,   // 0.5..3.0
  glowIntensity: 0.6, // 0..1
  theme: 'green',
  showFps: false,
  // data controls
  source: 'fake', // 'fake' | 'nyc'
  borough: '',    // '', 'Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'
  nta: '',
  stringStyle: 'json', // 'json' | 'kv' | 'code'
  maxColumns: 160,
  mode: 'file', // 'file' | 'glyph'
  // file mode text rendering
  textCfg: { maxWidth: 420, fontSize: 14, lineHeight: 18 },
  speedMin: 80,
  speedMax: 160,
};

// Apply theme class to body
function applyTheme(theme) {
  document.body.classList.remove('theme-green', 'theme-cyan', 'theme-magenta');
  const cls = theme === 'cyan' ? 'theme-cyan' : theme === 'magenta' ? 'theme-magenta' : 'theme-green';
  document.body.classList.add(cls);
}

// ---------------------------- Canvas setup -------------------------------
const canvas = document.getElementById('rain');
const ctx = canvas.getContext('2d');

function initCanvas() { resizeCanvas(); }

function resizeCanvas() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const { innerWidth: w, innerHeight: h } = window;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resizeCanvas);

// ---------------------------- Matrix Rain --------------------------------
class MatrixRain {
  constructor(ctx) {
    this.ctx = ctx;
    this.columns = [];
    this.fileStrips = [];
    this.glyphSize = 16; // device-independent pixels
    this.columnCount = 0;
    this.characters = this.buildGlyphSet();
    this.sheet = this.buildGlyphSheet();
    this.profilePool = [];
    this.profileIndex = 0;
    this.resetColumns();
  }

  buildGlyphSet() {
    const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    const digits = '0123456789';
    const punct = '!@#$%^&*()_+-=[]{};:\",./<>?';
    const kana = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ';
    return (latin + digits + punct + kana).split('');
  }

  buildGlyphSheet() {
    // prerender characters to an offscreen canvas rows x cols grid
    const size = this.glyphSize;
    const cols = 32; // per row
    const rows = Math.ceil(this.characters.length / cols);
    const off = document.createElement('canvas');
    off.width = cols * size;
    off.height = rows * size;
    const c = off.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, off.width, off.height);
    c.font = `${size - 2}px ui-monospace, monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (let i = 0; i < this.characters.length; i++) {
      const ch = this.characters[i];
      const x = (i % cols) * size + size / 2;
      const y = Math.floor(i / cols) * size + size / 2;
      c.fillStyle = '#0f0';
      c.shadowBlur = 8;
      c.shadowColor = '#0f0';
      c.fillText(ch, x, y);
    }
    return { canvas: off, cols, size };
  }

  resetColumns() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    const density = 0.7 * CONFIG.densityScale; // base density
    if (CONFIG.mode === 'glyph') {
      const numCols = clamp(Math.max(8, Math.floor((w / size) * density)), 8, CONFIG.maxColumns);
      this.columnCount = numCols;
      this.columns.length = 0;
      for (let i = 0; i < numCols; i++) this.columns.push(this.spawnColumn(i, h));
      this.fileStrips.length = 0;
    } else {
      // file mode: maintain N strips based on density
      const target = clamp(Math.floor(40 * CONFIG.densityScale), 10, 100);
      this.fileStrips.length = 0;
      for (let i = 0; i < target; i++) {
        this.spawnFileStrip().then(strip => { if (strip) this.fileStrips.push(strip); });
      }
      this.columns.length = 0;
    }
  }

  spawnColumn(index, screenH) {
    const size = this.glyphSize;
    const x = Math.floor(index * (canvas.clientWidth / this.columnCount));
    const profile = this.takeNextProfile();
    const painter = new StringPainter(profile, CONFIG.stringStyle);
    return {
      x,
      y: randi(-screenH, 0),
      speed: rand(60, 180) * CONFIG.speedScale, // px per second
      streamLength: randi(10, 40),
      glyphIndices: Array.from({ length: 80 }, () => randi(0, this.characters.length)),
      drift: rand(-0.2, 0.2),
      painter,
      textBuffer: painter.buildGlyphStream(),
      headHighlightTimer: 0,
    };
  }

  update(dt) {
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    const speedScale = CONFIG.speedScale;
    if (CONFIG.mode === 'glyph') {
      // Occasionally rebuild columns when density changes or window resized
      const desiredCols = clamp(Math.max(8, Math.floor((canvas.clientWidth / size) * 0.7 * CONFIG.densityScale)), 8, CONFIG.maxColumns);
      if (desiredCols !== this.columnCount) { this.resetColumns(); return; }
      for (const col of this.columns) {
        col.y += col.speed * speedScale * dt;
        const headBufferIndex = Math.floor(col.y / size) % col.textBuffer.length;
        if (col.painter && col.painter.isKeyChar(headBufferIndex)) col.headHighlightTimer = 0.28;
        if (col.y - col.streamLength * size > h + 20) Object.assign(col, this.spawnColumn(Math.random() * this.columnCount, h));
        if (Math.random() < 0.2) {
          const idx = randi(0, col.glyphIndices.length);
          col.glyphIndices[idx] = randi(0, this.characters.length);
        }
        if (Math.random() < 0.002) {
          col.painter = new StringPainter(this.takeNextProfile(), CONFIG.stringStyle);
          col.textBuffer = col.painter.buildGlyphStream();
        }
        col.headHighlightTimer = Math.max(0, col.headHighlightTimer - dt);
      }
    } else {
      // file mode
      // maintain target count
      const target = clamp(Math.floor(40 * CONFIG.densityScale), 10, 100);
      if (this.fileStrips.length < target) {
        const deficit = target - this.fileStrips.length;
        for (let i = 0; i < deficit; i++) this.spawnFileStrip().then(s => { if (s) this.fileStrips.push(s); });
      } else if (this.fileStrips.length > target) {
        this.fileStrips.length = target;
      }
      for (const s of this.fileStrips) {
        s.update(dt, h);
      }
    }
  }

  draw() {
    const { ctx } = this;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const size = this.glyphSize;
    // trail fade
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(0,0,0,0.18)`;
    ctx.fillRect(0, 0, w, h);

    // glow layers: paint dim layer then bright heads
    const glow = clamp(CONFIG.glowIntensity, 0, 1);
    const baseAlpha = 0.65;
    const headAlpha = 0.95;

    // precompute sheet
    const { canvas: sheet, cols, size: cell } = this.sheet;

    if (CONFIG.mode === 'glyph') {
      for (const col of this.columns) {
        let y = col.y;
        const jitterX = Math.sin(performance.now() / 200 + col.x * 0.01) * 0.6;
        for (let i = 0; i < col.streamLength; i++) {
          const bufferIndex = (Math.floor(y / size) - i + 10000) % col.textBuffer.length;
          const ch = col.textBuffer[bufferIndex];
          const gi = this.characters.indexOf(ch);
          const useFiller = gi === -1;
          const glyphIndex = useFiller ? col.glyphIndices[(i + bufferIndex) % col.glyphIndices.length] : gi;
          const sx = (glyphIndex % cols) * cell;
          const sy = Math.floor(glyphIndex / cols) * cell;
          const isHead = i === 0;
          const color = getActiveColor();
          ctx.globalAlpha = isHead ? headAlpha : baseAlpha * (1 - i / col.streamLength);
          ctx.save();
          ctx.shadowBlur = 8 + glow * 14;
          ctx.shadowColor = color;
          if (!useFiller && (col.painter.isKeyChar(bufferIndex) || (isHead && col.headHighlightTimer > 0))) {
            const t = (Math.sin(performance.now() / 120) + 1) * 0.5;
            ctx.globalAlpha *= 0.7 + 0.3 * t;
          }
          ctx.drawImage(sheet, sx, sy, cell, cell, col.x + jitterX, y - i * size, size, size);
          ctx.restore();
        }
      }
    } else {
      // file mode: draw pre-rendered bitmaps with slight blur and occasional glitch
      for (const s of this.fileStrips) {
        ctx.globalAlpha = 0.95;
        s.draw(ctx);
        if (Math.random() < 0.003) {
          ctx.globalAlpha = 0.4;
          ctx.save();
          ctx.translate(1, 0);
          s.draw(ctx);
          ctx.restore();
        }
        ctx.globalAlpha = 1.0;
      }
    }

    // 1px scanline overlay subtle
    ctx.globalAlpha = 0.06;
    ctx.fillStyle = '#ffffff';
    for (let y2 = 0; y2 < h; y2 += 2) ctx.fillRect(0, y2, w, 1);
    ctx.globalAlpha = 1.0;
  }

  takeNextProfile() {
    if (this.profilePool.length === 0) {
      this.profilePool = DataSource.getProfiles(64);
      this.profileIndex = 0;
    }
    const p = this.profilePool[this.profileIndex % this.profilePool.length];
    this.profileIndex++;
    return p;
  }

  async spawnFileStrip() {
    const profile = this.takeNextProfile();
    return spawnFileStripFrom(profile);
  }
}

// ---------------------------- File Strip -----------------------------------
class FileStrip {
  constructor({ bitmap, w, h, x, y, speed }) {
    this.bitmap = bitmap; this.w = w; this.h = h; this.x = x; this.y = y; this.speed = speed;
    this._jitterTimer = 0;
  }
  update(dt, H) {
    this.y += this.speed * dt;
    this._jitterTimer -= dt;
    if (this._jitterTimer <= 0) { this.x += (Math.random() - 0.5) * 12; this._jitterTimer = 2 + Math.random() * 2; }
    if (this.y - this.h > H) { this.y = -this.h; }
  }
  draw(ctx) { ctx.drawImage(this.bitmap, this.x | 0, this.y | 0); }
}

async function spawnFileStripFrom(profile) {
  const bitmap = await composeFileBitmap(profile, CONFIG.stringStyle, CONFIG.textCfg);
  const w = bitmap.width, h = bitmap.height;
  const x = rand(0, canvas.clientWidth - w);
  const y = -h - rand(0, canvas.clientHeight);
  const speed = rand(CONFIG.speedMin, CONFIG.speedMax) * CONFIG.speedScale;
  return new FileStrip({ bitmap, w, h, x, y, speed });
}

async function composeFileBitmap(profile, style, { maxWidth = 420, fontSize = 14, lineHeight = 18 } = {}) {
  const lines = buildLines(profile, style, maxWidth, fontSize);
  const w = Math.min(maxWidth, Math.max(240, Math.max(...lines.map(m => m.width)) + 16));
  const h = lines.length * lineHeight + 24;
  const off = new OffscreenCanvas(w, h);
  const octx = off.getContext('2d');
  octx.clearRect(0, 0, w, h);
  octx.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  octx.textBaseline = 'top';
  const color = getActiveColor();
  octx.shadowColor = color; octx.shadowBlur = 8;
  octx.fillStyle = color;
  octx.globalAlpha = 0.9; octx.fillText('// PROFILE_STREAM', 8, 6); octx.globalAlpha = 1;
  let y = 24;
  for (const { text } of lines) { octx.fillText(text, 8, y); y += lineHeight; }
  const grad = octx.createLinearGradient(0, h - 24, 0, h);
  grad.addColorStop(0, 'rgba(124,255,178,0)');
  grad.addColorStop(1, 'rgba(124,255,178,0.45)');
  octx.fillStyle = grad; octx.fillRect(0, h - 24, w, 24);
  return createImageBitmap(off);
}

function buildLines(profile, style, maxWidth, fontSize) {
  const canvasTmp = document.createElement('canvas');
  const c = canvasTmp.getContext('2d');
  c.font = `${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const text = new StringPainter(profile, style).build(profile, style);
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    const width = c.measureText(test).width + 16;
    if (width > maxWidth && current) {
      lines.push({ text: current, width: c.measureText(current).width });
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push({ text: current, width: c.measureText(current).width });
  return lines;
}


function getActiveColor() {
  const body = getComputedStyle(document.body);
  return body.getPropertyValue('--active').trim() || '#00ff66';
}

// ---------------------------- Profile Factory -----------------------------
const ProfileFactory = (() => {
  const firstNames = ['Ava','Mia','Liam','Noah','Emma','Oliver','Lucas','Amelia','Ethan','Sofia','Zoe','Kai','Nina','Leo','Isla','Maya','Ezra','Ivy','Mila','Aria','Theo','Luna','Finn','Mason','Iris'];
  const lastNames = ['Kim','Lee','Nguyen','Patel','Garcia','Chen','Smith','Khan','Mori','Silva','Rossi','Santos','Brown','Martin','Lopez','Wilson','Dubois','Kowalski'];
  const genders = ['female','male','non-binary'];
  const industries = ['Finance','Healthcare','Tech','Education','Retail','Energy','Gaming','Media','Gov','Aerospace'];
  const jobs = ['Engineer','Designer','Data Scientist','Analyst','PM','Researcher','Nurse','Teacher','Marketer','Artist','Security','Pilot'];
  const relationship = ['single','dating','married','complicated'];
  const education = ['HS','Associate','BSc','MSc','PhD'];
  const emotional = [
    ['focused', 3], ['stressed', 2], ['curious', 3], ['flow', 2],
    ['burnout', 1], ['optimistic', 2], ['calm', 2], ['distracted', 1]
  ];
  const cities = ['New York','Berlin','Tokyo','Seoul','Toronto','Paris','Madrid','Sydney','Sao Paulo','Nairobi','Dublin','Singapore'];

  function makeId() {
    return Math.random().toString(36).slice(2, 8) + '-' + Date.now().toString(36).slice(-4);
  }

  function sampleIncome(industry) {
    const base = {
      Tech: [80000, 220000], Finance: [70000, 250000], Healthcare: [50000, 180000],
      Education: [35000, 120000], Retail: [30000, 90000], Energy: [60000, 200000],
      Gaming: [45000, 150000], Media: [40000, 140000], Gov: [40000, 120000], Aerospace: [70000, 210000]
    }[industry] || [40000, 120000];
    return Math.round(rand(base[0], base[1]) / 1000) * 1000;
  }

  function riskFromIncomeAndMood(income, mood) {
    let r = rand(10, 90);
    if (income > 150000) r -= 10;
    if (income < 40000) r += 10;
    const moodBias = {
      burnout: +15, stressed: +10, distracted: +8, focused: -5, calm: -5, flow: -8, optimistic: -3, curious: 0
    };
    r += moodBias[mood] || 0;
    return clamp(Math.round(r), 0, 100);
  }

  function interestsSet() {
    const pool = ['climbing','reading','ai','music','crypto','gardening','photography','biking','chess','vr','cooking','yoga','travel','gaming'];
    const n = randi(2, 6);
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, n);
  }

  function generate() {
    const ind = choice(industries);
    const job = choice(jobs);
    const mood = weightedChoice(emotional);
    const age = randi(18, 70);
    const inc = sampleIncome(ind);
    const risk = riskFromIncomeAndMood(inc, mood);
    const profile = {
      id: makeId(),
      name: `${choice(firstNames)} ${choice(lastNames)}`,
      age,
      gender: choice(genders),
      job_title: job,
      industry: ind,
      income_usd: inc,
      education: choice(education),
      location_city: choice(cities),
      relationship_status: choice(relationship),
      emotional_state: mood,
      activity: choice(['browsing','coding','commuting','meeting','streaming','learning','exercising','shopping']),
      interests: interestsSet(),
      risk_score: risk,
      last_active: new Date(Date.now() - randi(0, 3600 * 1000)).toISOString(),
    };
    return profile;
  }

  return { generate };
})();

// Capsules removed; all rendering occurs in MatrixRain

// ---------------------------- Data Source ---------------------------------
const DataSource = (() => {
  let cachedProfiles = [];
  function getProfiles(wantCount) {
    if (CONFIG.source === 'nyc' && typeof NYCProfileService !== 'undefined') {
      if (cachedProfiles.length === 0) cachedProfiles = generateFakeBatch(wantCount);
      NYCProfileService.fetchProfiles({ borough: CONFIG.borough, nta: CONFIG.nta, limit: 400 })
        .then(list => { if (Array.isArray(list) && list.length) cachedProfiles = list; })
        .catch(() => {});
      return takeLoop(cachedProfiles, wantCount);
    }
    if (cachedProfiles.length < wantCount) cachedProfiles = generateFakeBatch(Math.max(wantCount, 128));
    return takeLoop(cachedProfiles, wantCount);
  }
  function generateFakeBatch(n) { return Array.from({ length: n }, () => ProfileFactory.generate()); }
  function takeLoop(arr, n) {
    const out = [];
    for (let i = 0; i < n; i++) out.push(arr[i % arr.length]);
    return out;
  }
  return { getProfiles };
})();

// ---------------------------- String Painter -------------------------------
class StringPainter {
  constructor(profile, mode) {
    this.profile = profile;
    this.mode = mode;
    this.string = this.buildString(profile, mode);
    this.keyCharPositions = this.computeKeyPositions(this.string);
  }

  build(profile, mode) { return this.buildString(profile, mode); }

  buildString(p, mode) {
    if (mode === 'kv') {
      const profileLabel = `${p.job_title || 'Agent'}+${(p.gender||'U')[0].toUpperCase()}+${p.age||'?'}`;
      return `profile=${profileLabel} | nta=${p.nta || ''} | mood=${p.emotional_state || ''} | income=${formatMoneyUSD(p.income_usd || 0)} | risk=${p.risk_score ?? ''}`;
    }
    if (mode === 'code') {
      const idHex = (p.id || '0000').replace(/[^a-fA-F0-9]/g, '').slice(-4) || 'A1C3';
      return `let p=Agent( id:0x${idHex}, age:${p.age||'?'}, job:"${p.job_title||'Worker'}", mood:"${p.emotional_state||''}", nta:"${p.nta||''}", income:${p.income_usd||0} );`;
    }
    // default json
    const profileLabel = `${p.job_title || 'Agent'}+${(p.gender||'U')[0].toUpperCase()}+${p.age||'?'}
`;
    const coords = p.coords || [rand(100, 600).toFixed(2), rand(100, 400).toFixed(2), rand(200, 800).toFixed(1)];
    const obj = {
      profile: profileLabel.replace(/\n/g, ''),
      nta: p.nta || '',
      income: p.income_usd || 0,
      mood: p.emotional_state || '',
      coords: coords,
    };
    return JSON.stringify(obj);
  }

  buildGlyphStream() {
    const filler = 'ｱｲｳｴｵ0123456789<>[]{}-=+*/$%';
    const core = Array.from(this.string);
    const pad = 40;
    const left = Array.from({ length: pad }, () => filler[randi(0, filler.length)]);
    const right = Array.from({ length: pad }, () => filler[randi(0, filler.length)]);
    return left.concat(core, right);
  }

  computeKeyPositions(str) {
    const keys = ['profile', 'nta', 'income', 'mood', 'risk'];
    const pos = new Set();
    for (const k of keys) {
      const idx = str.indexOf(k);
      if (idx >= 0) for (let i = 0; i < k.length; i++) pos.add(idx + i);
    }
    return pos;
  }

  isKeyChar(bufferIndex) {
    return this.keyCharPositions.has((bufferIndex - 40 + this.string.length * 10000) % this.string.length);
  }
}

// ---------------------------- UI Bindings ---------------------------------
const UI = (() => {
  function bind() {
    const qs = id => document.getElementById(id);
    qs('density').addEventListener('input', e => { CONFIG.densityScale = parseFloat(e.target.value); rain.resetColumns(); });
    qs('speed').addEventListener('input', e => { CONFIG.speedScale = parseFloat(e.target.value); });
    qs('glow').addEventListener('input', e => {
      CONFIG.glowIntensity = parseFloat(e.target.value);
      document.documentElement.style.setProperty('--glow', CONFIG.glowIntensity.toString());
    });
    qs('mode').addEventListener('change', e => { CONFIG.mode = e.target.value; rain.resetColumns(); });
    qs('stringStyle').addEventListener('change', e => { CONFIG.stringStyle = e.target.value; rain.resetColumns(); });
    qs('source').addEventListener('change', e => { CONFIG.source = e.target.value; triggerDataRefresh(); });
    qs('borough').addEventListener('change', e => { CONFIG.borough = e.target.value; triggerDataRefresh(); });
    qs('nta').addEventListener('change', e => { CONFIG.nta = e.target.value.trim(); triggerDataRefresh(); });
    document.getElementById('btnRefresh').addEventListener('click', triggerDataRefresh);
    qs('stripWidth').addEventListener('input', e => { CONFIG.textCfg.maxWidth = parseInt(e.target.value, 10); if (CONFIG.mode==='file') rain.resetColumns(); });
    qs('fontSize').addEventListener('input', e => { CONFIG.textCfg.fontSize = parseInt(e.target.value, 10); if (CONFIG.mode==='file') rain.resetColumns(); });
    qs('lineHeight').addEventListener('input', e => { CONFIG.textCfg.lineHeight = parseInt(e.target.value, 10); if (CONFIG.mode==='file') rain.resetColumns(); });
    qs('theme').addEventListener('change', e => { CONFIG.theme = e.target.value; applyTheme(CONFIG.theme); });
    qs('showFps').addEventListener('change', e => { CONFIG.showFps = e.target.checked; fpsEl.style.opacity = CONFIG.showFps ? '0.9' : '0'; });
    qs('btnShot').addEventListener('click', screenshot);

    // URL params presets
    try {
      const params = new URLSearchParams(location.search);
      const source = params.get('source');
      const mode = params.get('mode');
      const style = params.get('style');
      const borough = params.get('borough');
      const nta = params.get('nta');
      if (source) { document.getElementById('source').value = source; CONFIG.source = source; }
      if (mode) { document.getElementById('mode').value = mode.toLowerCase(); CONFIG.mode = mode.toLowerCase(); }
      if (style) { document.getElementById('stringStyle').value = style.toLowerCase(); CONFIG.stringStyle = style.toLowerCase(); }
      if (borough) { document.getElementById('borough').value = borough; CONFIG.borough = borough; }
      if (nta) { document.getElementById('nta').value = nta; CONFIG.nta = nta; }
      if (params.has('dense')) { document.getElementById('density').value = '1.6'; document.getElementById('density').dispatchEvent(new Event('input')); }
      if (params.has('fast')) { document.getElementById('speed').value = '2.0'; document.getElementById('speed').dispatchEvent(new Event('input')); }
      const token = params.get('NYC_APP_TOKEN');
      if (token && typeof configureNYC === 'function') configureNYC({ appToken: token });
      if (CONFIG.source === 'nyc') triggerDataRefresh();
    } catch {}
  }
  return { bind };
})();

// ---------------------------- Screenshot ----------------------------------
function screenshot() {
  // Screenshot canvas only
  const w = canvas.clientWidth, h = canvas.clientHeight;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const c = out.getContext('2d');
  c.drawImage(canvas, 0, 0, w, h);
  const url = out.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = url; a.download = `profile_stream_${Date.now()}.png`; a.click();
}

// ---------------------------- Ticker --------------------------------------
const fpsEl = document.getElementById('fps');
let last = nowMs();
let fpsAcc = 0, fpsCount = 0;
const rain = new MatrixRain(ctx);

function tick() {
  const t = nowMs();
  const dt = Math.min(0.05, (t - last) / 1000);
  last = t;

  rain.update(dt);
  rain.draw();

  // FPS meter
  fpsAcc += dt; fpsCount++;
  if (fpsAcc >= 0.5) {
    const fps = Math.round(fpsCount / fpsAcc);
    if (CONFIG.showFps) fpsEl.textContent = `${fps} fps`;
    fpsAcc = 0; fpsCount = 0;
  }

  requestAnimationFrame(tick);
}

// ---------------------------- Bootstrap -----------------------------------
applyTheme(CONFIG.theme);
initCanvas();
UI.bind();
requestAnimationFrame(tick);

function triggerDataRefresh() {
  rain.resetColumns();
}
