/**
 * Canvas renderer for the home-page space backdrop: a moon limb catching the
 * first sunlight, a parallax starfield, drifting aurora, shooting stars, and
 * satellites that rise from behind the moon and set behind it again.
 *
 * Static layers (sky, moon skin, rim light, sun flare) are pre-rendered on
 * resize/theme change; each frame only composites them with the moving parts.
 */

type RGB = readonly [number, number, number];

type Palette = {
  dark: boolean;
  bg: RGB;
  brand: RGB;
  glow: RGB;
  hot: RGB;
  skyTop: RGB;
  skyHorizon: RGB;
  stars: RGB[];
  aurora: { color: RGB; alpha: number }[];
  craterShade: RGB;
  satBody: RGB;
  satPanel: RGB;
  additive: GlobalCompositeOperation;
};

type Geometry = {
  w: number;
  h: number;
  cx: number;
  cy: number;
  r: number;
  crestY: number;
  sunX: number;
  skyBottom: number;
};

type Star = {
  u: number;
  v: number;
  depth: 0 | 1 | 2;
  size: number;
  alpha: number;
  twinkle: number;
  phase: number;
  color: number;
  bright: boolean;
};

type Meteor = {
  x: number;
  y: number;
  dx: number;
  dy: number;
  speed: number;
  len: number;
  width: number;
  life: number;
  age: number;
  fireball: boolean;
};

type Satellite = {
  period: number;
  gap: number;
  offset: number;
  dir: 1 | -1;
  altitude: number;
  scale: number;
  blink: number;
  staticU: number;
};

type Layer = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export type NaoSpaceScene = {
  setReduceMotion: (reduce: boolean) => void;
  destroy: () => void;
};

const MAX_STARS = 360;
const DEPTH_DRIFT = [1.2, 2.6, 4.4];
const DEPTH_PARALLAX = [3, 7, 13];
const SUNRISE_SECONDS = 3.4;
const PULSE_EVERY = 12;
const PULSE_SECONDS = 4.6;

const WHITE: RGB = [255, 255, 255];

const rgba = (c: RGB, a: number) =>
  `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.max(0, Math.min(1, a))})`;

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const easeOutCubic = (p: number) => 1 - Math.pow(1 - clamp(p, 0, 1), 3);

function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeLayer(w: number, h: number, dpr: number): Layer | null {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}

function resolveColor(probe: CanvasRenderingContext2D, value: string, fallback: RGB): RGB {
  const v = value.trim();
  if (!v) return fallback;
  probe.fillStyle = '#010203';
  probe.fillStyle = v;
  if (probe.fillStyle === '#010203') return fallback;
  probe.clearRect(0, 0, 1, 1);
  probe.fillRect(0, 0, 1, 1);
  const d = probe.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2]];
}

function readPalette(): Palette {
  const root = document.documentElement;
  const dark = root.classList.contains('dark');
  const css = getComputedStyle(root);
  const probeCanvas = document.createElement('canvas');
  probeCanvas.width = probeCanvas.height = 1;
  const probe = probeCanvas.getContext('2d', { willReadFrequently: true });

  const pick = (name: string, fallback: RGB) =>
    probe ? resolveColor(probe, css.getPropertyValue(name), fallback) : fallback;

  const bg = pick('--background', dark ? [30, 39, 51] : [251, 252, 254]);
  const brand = pick('--brand', dark ? [94, 161, 247] : [52, 92, 236]);
  const glow = pick('--brand-glow', dark ? [138, 190, 250] : [110, 160, 245]);

  if (dark) {
    return {
      dark,
      bg,
      brand,
      glow,
      hot: mix(glow, WHITE, 0.65),
      skyTop: [4, 7, 20],
      skyHorizon: [13, 24, 62],
      stars: [
        [255, 255, 255],
        [206, 222, 255],
        [255, 236, 214],
        [190, 210, 255],
      ],
      aurora: [
        { color: [46, 98, 255], alpha: 0.3 },
        { color: [128, 70, 255], alpha: 0.22 },
        { color: [24, 186, 220], alpha: 0.2 },
        { color: [236, 92, 190], alpha: 0.12 },
      ],
      craterShade: [0, 0, 0],
      satBody: [226, 232, 245],
      satPanel: [120, 160, 230],
      additive: 'lighter',
    };
  }

  return {
    dark,
    bg,
    brand,
    glow,
    hot: mix(glow, WHITE, 0.45),
    skyTop: [214, 225, 252],
    skyHorizon: [238, 243, 255],
    stars: [
      [66, 92, 178],
      [96, 84, 186],
      [70, 120, 200],
    ],
    aurora: [
      { color: [120, 160, 255], alpha: 0.42 },
      { color: [176, 140, 255], alpha: 0.34 },
      { color: [110, 210, 235], alpha: 0.3 },
      { color: [250, 160, 210], alpha: 0.2 },
    ],
    craterShade: [40, 62, 128],
    satBody: [70, 88, 140],
    satPanel: [64, 104, 210],
    additive: 'source-over',
  };
}

function geometryFor(w: number, h: number): Geometry {
  const crestY = clamp(h * 0.27, 118, 172);
  const r = Math.max(w * 1.25, 900);
  const cx = w / 2;
  const cy = crestY + r;
  const g: Geometry = { w, h, cx, cy, r, crestY, sunX: cx, skyBottom: 0 };
  g.skyBottom = limbY(g, 0);
  return g;
}

function limbY(g: Geometry, x: number) {
  const dx = x - g.cx;
  if (Math.abs(dx) >= g.r) return Number.POSITIVE_INFINITY;
  return g.cy - Math.sqrt(g.r * g.r - dx * dx);
}

function buildStars(): Star[] {
  const rand = seeded(0x9a0c3);
  const stars: Star[] = [];
  for (let i = 0; i < MAX_STARS; i += 1) {
    const roll = rand();
    const depth: 0 | 1 | 2 = roll < 0.62 ? 0 : roll < 0.9 ? 1 : 2;
    const bright = depth === 2 && rand() < 0.35;
    stars.push({
      u: rand(),
      v: Math.pow(rand(), 1.15),
      depth,
      size: depth === 0 ? 0.35 + rand() * 0.35 : depth === 1 ? 0.6 + rand() * 0.45 : 0.95 + rand() * 0.6,
      alpha: depth === 0 ? 0.35 + rand() * 0.35 : depth === 1 ? 0.55 + rand() * 0.35 : 0.75 + rand() * 0.25,
      twinkle: 0.6 + rand() * 2.2,
      phase: rand() * Math.PI * 2,
      color: Math.floor(rand() * 4),
      bright,
    });
  }
  return stars;
}

const SATELLITES: Satellite[] = [
  { period: 38, gap: 9, offset: 6, dir: 1, altitude: 118, scale: 1.15, blink: 1.4, staticU: 0.28 },
  { period: 54, gap: 14, offset: 31, dir: -1, altitude: 82, scale: 0.9, blink: 1.9, staticU: 0.68 },
  { period: 76, gap: 20, offset: 52, dir: 1, altitude: 150, scale: 0.65, blink: 2.6, staticU: 0.5 },
];

function radialSprite(size: number, stops: [number, string][]): HTMLCanvasElement | null {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

export function mountNaoSpaceScene(
  canvas: HTMLCanvasElement,
  options: { reduceMotion: boolean },
): NaoSpaceScene | null {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = canvas.getContext('2d');
  } catch {
    ctx = null;
  }
  if (!ctx) return null;
  const view = ctx;

  const stars = buildStars();
  const meteors: Meteor[] = [];
  const rand = Math.random;

  let reduce = options.reduceMotion;
  let palette = readPalette();
  let geo = geometryFor(1, 1);
  let dpr = 1;
  let sky: Layer | null = null;
  let limb: Layer | null = null;
  let rim: Layer | null = null;
  let flare: Layer | null = null;
  let flareW = 0;
  let flareH = 0;
  let dot: HTMLCanvasElement | null = null;
  let hotDot: HTMLCanvasElement | null = null;
  let auroraSprites: (HTMLCanvasElement | null)[] = [];

  let t = 0;
  let last = 0;
  let raf = 0;
  let running = false;
  let inView = true;
  let nextMeteorAt = 1.4;
  let pointerX = 0;
  let pointerY = 0;
  let parX = 0;
  let parY = 0;
  let destroyed = false;

  function buildSky() {
    sky = makeLayer(geo.w, geo.h, dpr);
    if (!sky) return;
    const c = sky.ctx;
    const g = c.createLinearGradient(0, 0, 0, geo.skyBottom + 8);
    g.addColorStop(0, rgba(palette.skyTop, 1));
    g.addColorStop(0.65, rgba(mix(palette.skyTop, palette.skyHorizon, 0.55), 1));
    g.addColorStop(1, rgba(palette.skyHorizon, 1));
    c.fillStyle = g;
    c.fillRect(0, 0, geo.w, geo.h);

    // Faint milky band across the sky for depth.
    c.save();
    c.translate(geo.w * 0.35, geo.crestY * 0.45);
    c.rotate(-0.18);
    c.scale(1, 0.16);
    const band = c.createRadialGradient(0, 0, 0, 0, 0, geo.w * 0.7);
    band.addColorStop(0, rgba(palette.dark ? [150, 170, 255] : [170, 190, 255], palette.dark ? 0.1 : 0.18));
    band.addColorStop(1, rgba(palette.skyTop, 0));
    c.fillStyle = band;
    c.fillRect(-geo.w, -geo.w, geo.w * 2, geo.w * 2);
    c.restore();
  }

  function buildLimb() {
    limb = makeLayer(geo.w, geo.h, dpr);
    if (!limb) return;
    const c = limb.ctx;
    const { cx, cy, r, w, crestY, sunX } = geo;

    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = rgba(palette.bg, 1);
    c.fill();

    c.save();
    c.clip();

    // Sunlit skin just under the limb, strongest near the sunrise point.
    c.save();
    c.translate(sunX, crestY);
    c.scale(1, 0.2);
    const haze = c.createRadialGradient(0, 0, 0, 0, 0, w * 0.6);
    haze.addColorStop(0, rgba(palette.glow, palette.dark ? 0.34 : 0.26));
    haze.addColorStop(0.35, rgba(palette.glow, palette.dark ? 0.14 : 0.1));
    haze.addColorStop(1, rgba(palette.glow, 0));
    c.fillStyle = haze;
    c.fillRect(-w, -w, w * 2, w * 2);
    c.restore();

    const crand = seeded(0x51ce);

    // Broad maria: soft dark lowlands.
    for (let i = 0; i < 7; i += 1) {
      const x = crand() * w;
      const d = 18 + crand() * 70;
      const y = limbY(geo, x) + d;
      const rx = 60 + crand() * 140;
      const ry = rx * (0.12 + (d / 120) * 0.2);
      c.save();
      c.translate(x, y);
      c.scale(1, ry / rx);
      const m = c.createRadialGradient(0, 0, 0, 0, 0, rx);
      m.addColorStop(0, rgba(palette.craterShade, palette.dark ? 0.16 : 0.035));
      m.addColorStop(1, rgba(palette.craterShade, 0));
      c.fillStyle = m;
      c.fillRect(-rx, -rx, rx * 2, rx * 2);
      c.restore();
    }

    // Craters, foreshortened toward the horizon and lit from beyond the limb.
    const count = Math.round(clamp(w / 15, 30, 100));
    for (let i = 0; i < count; i += 1) {
      const x = crand() * w;
      const d = 3 + 96 * Math.pow(crand(), 1.8);
      const depthT = Math.min(1, d / 96);
      const y = limbY(geo, x) + d;
      const rx = (0.8 + Math.pow(crand(), 2) * 7) * (0.6 + 0.7 * depthT);
      const ry = rx * (0.18 + 0.5 * depthT);
      const sun = 0.15 + 0.85 * Math.exp(-Math.pow((x - sunX) / (w * 0.36), 2));
      const vis = sun * Math.pow(1 - depthT, 1.4);

      const shade = c.createRadialGradient(x, y - ry * 0.25, 0, x, y - ry * 0.25, rx);
      shade.addColorStop(0, rgba(palette.craterShade, vis * (palette.dark ? 0.32 : 0.08)));
      shade.addColorStop(1, rgba(palette.craterShade, 0));
      c.save();
      c.translate(0, y);
      c.scale(1, ry / rx);
      c.translate(0, -y);
      c.fillStyle = shade;
      c.fillRect(x - rx, y - rx * 1.3, rx * 2, rx * 2.6);
      c.restore();

      c.beginPath();
      c.ellipse(x, y, rx, ry, 0, Math.PI * 0.12, Math.PI * 0.88);
      c.strokeStyle = rgba(palette.hot, vis * (palette.dark ? 0.3 : 0.22));
      c.lineWidth = 0.6;
      c.stroke();
    }

    c.restore();
  }

  function buildRim() {
    rim = makeLayer(geo.w, geo.h, dpr);
    if (!rim) return;
    const c = rim.ctx;
    const { cx, cy, r, w, h, sunX } = geo;

    const outer = 78;
    const ring = c.createRadialGradient(cx, cy, r - 1, cx, cy, r + outer);
    ring.addColorStop(0, palette.dark ? rgba(palette.hot, 0.95) : rgba(palette.glow, 0.85));
    ring.addColorStop(0.05, rgba(palette.glow, palette.dark ? 0.6 : 0.5));
    ring.addColorStop(0.28, rgba(palette.brand, palette.dark ? 0.2 : 0.14));
    ring.addColorStop(1, rgba(palette.brand, 0));
    c.fillStyle = ring;
    c.beginPath();
    c.arc(cx, cy, r + outer, 0, Math.PI * 2);
    c.arc(cx, cy, r - 1, 0, Math.PI * 2, true);
    c.fill();

    const inner = c.createRadialGradient(cx, cy, r - 26, cx, cy, r);
    inner.addColorStop(0, rgba(palette.glow, 0));
    inner.addColorStop(1, rgba(palette.glow, palette.dark ? 0.45 : 0.3));
    c.fillStyle = inner;
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.arc(cx, cy, r - 26, 0, Math.PI * 2, true);
    c.fill();

    c.beginPath();
    c.arc(cx, cy, r - 0.4, 0, Math.PI * 2);
    c.strokeStyle = palette.dark ? rgba(palette.hot, 1) : rgba(palette.brand, 0.75);
    c.lineWidth = palette.dark ? 1.3 : 1.1;
    c.stroke();

    // Light fades away from the sunrise point along the limb.
    c.globalCompositeOperation = 'destination-in';
    const fall = c.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 20; i += 1) {
      const x = (i / 20) * w;
      fall.addColorStop(i / 20, rgba(WHITE, 0.14 + 0.86 * Math.exp(-Math.pow((x - sunX) / (w * 0.3), 2))));
    }
    c.fillStyle = fall;
    c.fillRect(0, 0, w, h);
    c.globalCompositeOperation = 'source-over';
  }

  function buildFlare() {
    flareW = Math.min(geo.w * 0.95, 1200);
    flareH = 320;
    flare = makeLayer(flareW, flareH, dpr);
    if (!flare) return;
    const c = flare.ctx;
    const fx = flareW / 2;
    const fy = flareH / 2;

    c.save();
    c.translate(fx, fy);
    c.scale(1, 0.32);
    const bloom = c.createRadialGradient(0, 0, 0, 0, 0, flareW * 0.42);
    bloom.addColorStop(0, rgba(palette.glow, palette.dark ? 0.42 : 0.4));
    bloom.addColorStop(0.4, rgba(palette.brand, palette.dark ? 0.12 : 0.1));
    bloom.addColorStop(1, rgba(palette.brand, 0));
    c.fillStyle = bloom;
    c.fillRect(-flareW, -flareW, flareW * 2, flareW * 2);
    c.restore();

    c.save();
    c.translate(fx, fy);
    c.scale(1, 0.028);
    const streak = c.createRadialGradient(0, 0, 0, 0, 0, flareW / 2);
    streak.addColorStop(0, rgba(WHITE, palette.dark ? 0.85 : 0.9));
    streak.addColorStop(0.25, rgba(palette.glow, 0.35));
    streak.addColorStop(1, rgba(palette.glow, 0));
    c.fillStyle = streak;
    c.fillRect(-flareW / 2, -flareW / 2, flareW, flareW);
    c.restore();

    c.save();
    c.translate(fx, fy);
    c.scale(0.045, 1);
    const ray = c.createRadialGradient(0, 0, 0, 0, 0, flareH / 2);
    ray.addColorStop(0, rgba(palette.hot, 0.3));
    ray.addColorStop(1, rgba(palette.hot, 0));
    c.fillStyle = ray;
    c.fillRect(-flareH / 2, -flareH / 2, flareH, flareH);
    c.restore();

    const core = c.createRadialGradient(fx, fy, 0, fx, fy, 70);
    core.addColorStop(0, rgba(WHITE, 1));
    core.addColorStop(0.08, rgba(palette.hot, 0.9));
    core.addColorStop(0.35, rgba(palette.glow, 0.35));
    core.addColorStop(1, rgba(palette.glow, 0));
    c.fillStyle = core;
    c.fillRect(fx - 70, fy - 70, 140, 140);
  }

  function buildSprites() {
    dot = radialSprite(64, [
      [0, rgba(WHITE, 1)],
      [0.2, rgba(palette.hot, 0.6)],
      [1, rgba(palette.glow, 0)],
    ]);
    hotDot = radialSprite(96, [
      [0, rgba(WHITE, 1)],
      [0.12, rgba(palette.hot, 0.85)],
      [0.4, rgba(palette.glow, 0.25)],
      [1, rgba(palette.glow, 0)],
    ]);
    auroraSprites = palette.aurora.map((a) =>
      radialSprite(256, [
        [0, rgba(a.color, 1)],
        [0.45, rgba(a.color, 0.45)],
        [1, rgba(a.color, 0)],
      ]),
    );
  }

  function rebuild() {
    buildSky();
    buildLimb();
    buildRim();
    buildFlare();
    buildSprites();
  }

  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    const nextDpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === geo.w && h === geo.h && nextDpr === dpr && sky) return;
    dpr = nextDpr;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    geo = geometryFor(w, h);
    rebuild();
    draw();
  }

  function spawnMeteor() {
    const { w, crestY } = geo;
    const leftward = rand() < 0.5;
    const angle = (0.14 + rand() * 0.2) * Math.PI;
    const fireball = rand() < 0.18;
    meteors.push({
      x: w * (0.12 + rand() * 0.76),
      y: crestY * (0.04 + rand() * 0.5),
      dx: (leftward ? -1 : 1) * Math.cos(angle),
      dy: Math.sin(angle),
      speed: 620 + rand() * 520,
      len: fireball ? 210 + rand() * 90 : 90 + rand() * 110,
      width: fireball ? 2 : 1 + rand() * 0.5,
      life: 0.6 + rand() * 0.55,
      age: 0,
      fireball,
    });
  }

  function update(dt: number) {
    parX += (pointerX - parX) * Math.min(1, dt * 2.5);
    parY += (pointerY - parY) * Math.min(1, dt * 2.5);

    if (t >= nextMeteorAt) {
      spawnMeteor();
      if (rand() < 0.16) spawnMeteor();
      nextMeteorAt = t + 3.2 + rand() * 5.5;
    }
    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      meteors[i].age += dt;
      if (meteors[i].age >= meteors[i].life) meteors.splice(i, 1);
    }
  }

  function drawAurora(c: CanvasRenderingContext2D, time: number) {
    const { w, crestY } = geo;
    const placements = [
      { x: 0.18, y: 0.25, sx: 0.55, sy: 1.7, fx: 0.05, fy: 0.07 },
      { x: 0.78, y: 0.15, sx: 0.5, sy: 1.5, fx: 0.04, fy: 0.06 },
      { x: 0.5, y: 0.55, sx: 0.42, sy: 1.1, fx: 0.06, fy: 0.05 },
      { x: 0.92, y: 0.6, sx: 0.32, sy: 1.0, fx: 0.07, fy: 0.08 },
    ];
    c.globalCompositeOperation = palette.additive;
    placements.forEach((p, i) => {
      const sprite = auroraSprites[i];
      const tone = palette.aurora[i];
      if (!sprite || !tone) return;
      const x = (p.x + 0.09 * Math.sin(time * p.fx * Math.PI * 2 + i * 1.7)) * w + parX * 6;
      const y = (p.y + 0.18 * Math.cos(time * p.fy * Math.PI * 2 + i)) * crestY + parY * 4;
      const sw = w * p.sx * (1 + 0.08 * Math.sin(time * 0.11 + i));
      const sh = crestY * p.sy;
      c.globalAlpha = tone.alpha * (0.75 + 0.25 * Math.sin(time * 0.23 + i * 2.1));
      c.drawImage(sprite, x - sw / 2, y - sh / 2, sw, sh);
    });
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  function drawStars(c: CanvasRenderingContext2D, time: number) {
    const { w, skyBottom } = geo;
    const area = w * skyBottom;
    const n = Math.round(clamp(area / 1250, 90, MAX_STARS));
    const span = w + 40;
    for (let i = 0; i < n; i += 1) {
      const s = stars[i];
      let x = s.u * span + time * DEPTH_DRIFT[s.depth] + parX * DEPTH_PARALLAX[s.depth];
      x = (((x % span) + span) % span) - 20;
      const y = s.v * skyBottom + parY * DEPTH_PARALLAX[s.depth] * 0.6;
      const horizon = limbY(geo, x);
      if (y > horizon - 1.5) continue;
      const extinction = Math.min(1, (horizon - y) / 42);
      const tw = 0.62 + 0.38 * Math.sin(time * s.twinkle + s.phase);
      const a = s.alpha * tw * extinction * (palette.dark ? 1 : 0.55);
      const color = palette.stars[s.color % palette.stars.length];
      c.fillStyle = rgba(color, a);
      c.beginPath();
      c.arc(x, y, s.size, 0, Math.PI * 2);
      c.fill();
      if (s.bright && dot) {
        const size = s.size * (10 + 3 * tw);
        c.globalCompositeOperation = palette.additive;
        c.globalAlpha = a * (palette.dark ? 0.55 : 0.3);
        c.drawImage(dot, x - size / 2, y - size / 2, size, size);
        if (palette.dark) {
          c.globalAlpha = a * 0.28;
          c.fillStyle = rgba(WHITE, 1);
          const spike = s.size * 7 * tw;
          c.fillRect(x - spike, y - 0.25, spike * 2, 0.5);
          c.fillRect(x - 0.25, y - spike, 0.5, spike * 2);
        }
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      }
    }
  }

  function drawMeteors(c: CanvasRenderingContext2D) {
    c.globalCompositeOperation = palette.additive;
    c.lineCap = 'round';
    for (const m of meteors) {
      const p = m.age / m.life;
      const env = Math.pow(Math.sin(Math.PI * p), 0.7);
      const travel = m.speed * m.age;
      const hx = m.x + m.dx * travel;
      const hy = m.y + m.dy * travel;
      const trail = m.len * Math.min(1, m.age / 0.16);
      const tx = hx - m.dx * trail;
      const ty = hy - m.dy * trail;
      const head = palette.dark ? WHITE : palette.brand;
      const tail = m.fireball ? (palette.dark ? [255, 200, 150] as RGB : palette.glow) : palette.glow;
      const g = c.createLinearGradient(tx, ty, hx, hy);
      g.addColorStop(0, rgba(tail, 0));
      g.addColorStop(0.65, rgba(tail, 0.32 * env));
      g.addColorStop(1, rgba(head, 0.95 * env));
      c.strokeStyle = g;
      c.lineWidth = m.width;
      c.beginPath();
      c.moveTo(tx, ty);
      c.lineTo(hx, hy);
      c.stroke();
      if (dot) {
        const size = m.width * (m.fireball ? 16 : 10);
        c.globalAlpha = env * 0.85;
        c.drawImage(dot, hx - size / 2, hy - size / 2, size, size);
        c.globalAlpha = 1;
      }
    }
    c.globalCompositeOperation = 'source-over';
  }

  function satellitePoint(sat: Satellite, u: number) {
    const { w } = geo;
    const x = sat.dir > 0 ? -0.08 * w + u * 1.16 * w : 1.08 * w - u * 1.16 * w;
    const alt = sat.altitude * Math.sin(Math.PI * u) - 26;
    return { x, y: limbY(geo, x) - alt };
  }

  function drawSatellites(c: CanvasRenderingContext2D, time: number) {
    for (const sat of SATELLITES) {
      let u: number;
      if (reduce) {
        u = sat.staticU;
      } else {
        const cycle = sat.period + sat.gap;
        u = (((time + sat.offset) % cycle) + cycle) % cycle / sat.period;
        if (u > 1) continue;
      }
      const p = satellitePoint(sat, u);
      const q = satellitePoint(sat, Math.min(1, u + 0.004));
      const angle = Math.atan2(q.y - p.y, q.x - p.x);
      const sunlight = Math.exp(-Math.pow((p.x - geo.sunX) / (geo.w * 0.16), 2));

      c.save();
      c.translate(p.x, p.y);
      c.rotate(angle);
      c.scale(sat.scale, sat.scale);
      c.fillStyle = rgba(palette.satPanel, palette.dark ? 0.85 : 0.75);
      c.fillRect(-7.5, -1.1, 5, 2.2);
      c.fillRect(2.5, -1.1, 5, 2.2);
      c.fillStyle = rgba(palette.satBody, 0.95);
      c.fillRect(-2.5, -0.35, 5, 0.7);
      c.fillRect(-1.5, -1.5, 3, 3);
      c.restore();

      if (dot && sunlight > 0.04) {
        const size = 22 * sat.scale * (0.6 + sunlight);
        c.globalCompositeOperation = palette.additive;
        c.globalAlpha = sunlight * (palette.dark ? 0.9 : 0.6);
        c.drawImage(dot, p.x - size / 2, p.y - size / 2, size, size);
        c.globalAlpha = 1;
        c.globalCompositeOperation = 'source-over';
      }

      const blinkOn = reduce ? false : ((time + sat.offset) / sat.blink) % 1 < 0.07;
      if (blinkOn) {
        c.fillStyle = 'rgba(255,92,92,0.95)';
        c.beginPath();
        c.arc(p.x, p.y, 1.1 * sat.scale + 0.4, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  function draw() {
    if (!sky || !limb || !rim || !flare) return;
    const c = view;
    const { w, h, crestY, sunX } = geo;
    const time = reduce ? 9 : t;

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, w, h);
    c.drawImage(sky.canvas, 0, 0, w, h);

    drawAurora(c, time);
    drawStars(c, time);
    if (!reduce) drawMeteors(c);
    drawSatellites(c, time);

    const rise = reduce ? 1 : easeOutCubic(t / SUNRISE_SECONDS);
    const breath = reduce ? 1 : 0.9 + 0.1 * Math.sin((t / 8) * Math.PI * 2);
    const sunLevel = (0.3 + 0.7 * rise) * breath;

    c.globalCompositeOperation = palette.additive;
    c.globalAlpha = sunLevel;
    const fs = 0.82 + 0.18 * rise;
    const fw = flareW * fs;
    const fh = flareH * fs;
    c.drawImage(flare.canvas, sunX - fw / 2, crestY + 4 - fh / 2, fw, fh);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';

    c.drawImage(limb.canvas, 0, 0, w, h);

    c.globalCompositeOperation = palette.additive;
    c.globalAlpha = 0.5 + 0.5 * sunLevel;
    c.drawImage(rim.canvas, 0, 0, w, h);

    if (!reduce && hotDot && t > SUNRISE_SECONDS) {
      const phase = ((t - SUNRISE_SECONDS) % PULSE_EVERY) / PULSE_SECONDS;
      if (phase < 1) {
        const reach = easeOutCubic(phase) * w * 0.56;
        const fade = Math.pow(1 - phase, 1.4) * (palette.dark ? 0.75 : 0.55);
        for (const side of [-1, 1]) {
          const x = sunX + side * reach;
          const y = limbY(geo, x);
          if (!Number.isFinite(y)) continue;
          const size = 70 - 30 * phase;
          c.globalAlpha = fade;
          c.drawImage(hotDot, x - size / 2, y - size / 2, size, size);
        }
      }
    }

    if (hotDot) {
      const size = 34 + 26 * sunLevel;
      c.globalAlpha = Math.min(1, sunLevel * 1.1);
      c.drawImage(hotDot, sunX - size / 2, crestY - size / 2 + 1, size, size);
    }

    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';

    if (!canvas.hasAttribute('data-ready')) canvas.setAttribute('data-ready', '');
  }

  function frame(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    t += dt;
    update(dt);
    draw();
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running || reduce || !inView || document.hidden || destroyed) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
  }

  const onVisibility = () => (document.hidden ? stop() : start());
  const onPointer = (e: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    pointerX = clamp(((e.clientX - rect.left) / rect.width) * 2 - 1, -1, 1);
    pointerY = clamp(((e.clientY - rect.top) / rect.height) * 2 - 1, -1, 1);
  };

  const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
  resizeObserver?.observe(canvas);
  if (!resizeObserver) window.addEventListener('resize', resize);

  const intersection =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          inView = entries.some((e) => e.isIntersecting);
          if (inView) start();
          else stop();
        })
      : null;
  intersection?.observe(canvas);

  const themeObserver = new MutationObserver(() => {
    const next = readPalette();
    if (next.dark === palette.dark && next.bg.join() === palette.bg.join()) return;
    palette = next;
    if (geo.w > 1) {
      rebuild();
      draw();
    }
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pointermove', onPointer, { passive: true });

  resize();
  start();

  return {
    setReduceMotion(next) {
      if (next === reduce) return;
      reduce = next;
      meteors.length = 0;
      if (reduce) stop();
      draw();
      start();
    },
    destroy() {
      destroyed = true;
      stop();
      resizeObserver?.disconnect();
      if (!resizeObserver) window.removeEventListener('resize', resize);
      intersection?.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pointermove', onPointer);
    },
  };
}
