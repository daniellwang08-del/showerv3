/**
 * Built-in, royalty-free header backgrounds + the crop/overlay/compress pipeline.
 *
 * Presets are *generated* on a canvas (gradients + subtle abstract/geometric art)
 * that derive their main hue from the design accent so they match the theme. The
 * same compose step also handles user uploads: it crops to the band's exact aspect,
 * bakes a legibility overlay, and exports a compressed image holding ONLY the pixels
 * shown - so the stored design and the embedded .docx asset stay small.
 */

import type { HeaderImageText } from '../../types/resumeDesign';

export interface HeaderPreset {
  id: string;
  label: string;
  /** Hint used by the gallery to group; purely cosmetic. */
  group: 'gradient' | 'abstract';
}

export const HEADER_PRESETS: HeaderPreset[] = [
  { id: 'aurora', label: 'Aurora', group: 'gradient' },
  { id: 'midnight', label: 'Midnight', group: 'gradient' },
  { id: 'ocean', label: 'Ocean', group: 'gradient' },
  { id: 'royal', label: 'Royal', group: 'gradient' },
  { id: 'sunset', label: 'Sunset', group: 'gradient' },
  { id: 'emerald', label: 'Emerald', group: 'gradient' },
  { id: 'graphite', label: 'Graphite', group: 'gradient' },
  { id: 'mesh', label: 'Mesh', group: 'gradient' },
  { id: 'diagonal', label: 'Diagonal', group: 'abstract' },
  { id: 'dots', label: 'Dots', group: 'abstract' },
  { id: 'grid', label: 'Grid', group: 'abstract' },
  { id: 'waves', label: 'Waves', group: 'abstract' },
  { id: 'lowpoly', label: 'Low Poly', group: 'abstract' },
  { id: 'glow', label: 'Corner Glow', group: 'abstract' },
  { id: 'topo', label: 'Topographic', group: 'abstract' },
  { id: 'circuit', label: 'Circuit', group: 'abstract' },
];

const OUTPUT_WIDTH = 1400; // exported pixel width; height derives from aspect
const THUMB_ASPECT = 4.4;

// ── Color helpers ──────────────────────────────────────────────────────────
function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n));
}

function hexToRgb(hex: string): [number, number, number] {
  let v = (hex || '#2563eb').replace('#', '');
  if (v.length === 3) v = v.split('').map((c) => c + c).join('');
  const n = parseInt(v, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, s, l];
}

function hslToCss(h: number, s: number, l: number, a = 1): string {
  return `hsla(${((h % 360) + 360) % 360}, ${clamp(s, 0, 1) * 100}%, ${clamp(l, 0, 1) * 100}%, ${a})`;
}

function accentHsl(accent: string): [number, number, number] {
  const [r, g, b] = hexToRgb(accent);
  const [h, s, l] = rgbToHsl(r, g, b);
  // Keep a confident, professional saturation floor.
  return [h, clamp(s, 0.45, 0.85), l];
}

// ── Preset painters ────────────────────────────────────────────────────────
function paintPreset(ctx: CanvasRenderingContext2D, w: number, h: number, accent: string, id: string): void {
  const [hue, sat] = accentHsl(accent);
  ctx.clearRect(0, 0, w, h);

  const linear = (stops: [number, string][], x0: number, y0: number, x1: number, y1: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    stops.forEach(([o, c]) => g.addColorStop(o, c));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };

  switch (id) {
    case 'aurora':
      linear(
        [
          [0, hslToCss(hue, sat, 0.16)],
          [0.5, hslToCss(hue + 18, sat, 0.34)],
          [1, hslToCss(hue + 40, sat * 0.9, 0.22)],
        ],
        0, 0, w, h,
      );
      break;
    case 'midnight':
      linear(
        [
          [0, hslToCss(hue, sat * 0.7, 0.1)],
          [1, hslToCss(hue, sat, 0.32)],
        ],
        0, h, w, 0,
      );
      break;
    case 'ocean':
      linear(
        [
          [0, hslToCss(hue + 8, sat, 0.2)],
          [1, hslToCss(hue + 150, sat * 0.8, 0.28)],
        ],
        0, 0, w, h,
      );
      break;
    case 'royal':
      linear(
        [
          [0, hslToCss(265, 0.6, 0.22)],
          [1, hslToCss(225, 0.65, 0.3)],
        ],
        0, 0, w, h,
      );
      break;
    case 'sunset':
      linear(
        [
          [0, hslToCss(18, 0.78, 0.34)],
          [0.55, hslToCss(338, 0.62, 0.34)],
          [1, hslToCss(268, 0.5, 0.3)],
        ],
        0, 0, w, h,
      );
      break;
    case 'emerald':
      linear(
        [
          [0, hslToCss(160, 0.5, 0.18)],
          [1, hslToCss(190, 0.55, 0.3)],
        ],
        0, 0, w, h,
      );
      break;
    case 'graphite':
      linear(
        [
          [0, hslToCss(hue, 0.12, 0.16)],
          [1, hslToCss(hue, 0.16, 0.28)],
        ],
        0, 0, w, h,
      );
      break;
    case 'mesh': {
      linear([[0, hslToCss(hue, sat * 0.5, 0.14)], [1, hslToCss(hue, sat * 0.6, 0.2)]], 0, 0, 0, h);
      const blob = (cx: number, cy: number, r: number, hh: number) => {
        const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        g.addColorStop(0, hslToCss(hh, sat, 0.5, 0.85));
        g.addColorStop(1, hslToCss(hh, sat, 0.5, 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);
      };
      blob(w * 0.15, h * 0.2, h * 1.4, hue);
      blob(w * 0.55, h * 0.85, h * 1.6, hue + 40);
      blob(w * 0.9, h * 0.3, h * 1.3, hue - 30);
      break;
    }
    case 'diagonal': {
      linear([[0, hslToCss(hue, sat, 0.14)], [1, hslToCss(hue, sat, 0.26)]], 0, 0, w, h);
      ctx.save();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = '#ffffff';
      const step = h * 0.55;
      for (let x = -h; x < w + h; x += step * 2) {
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x + h, 0);
        ctx.lineTo(x + h + step, 0);
        ctx.lineTo(x + step, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 'dots': {
      linear([[0, hslToCss(hue, sat, 0.13)], [1, hslToCss(hue, sat, 0.24)]], 0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      const r = Math.max(1.5, h * 0.012);
      const gap = h * 0.12;
      for (let y = gap; y < h; y += gap) {
        for (let x = gap; x < w; x += gap) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      break;
    }
    case 'grid': {
      linear([[0, hslToCss(hue, sat, 0.12)], [1, hslToCss(hue, sat, 0.22)]], 0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = Math.max(1, h * 0.006);
      const gap = h * 0.16;
      ctx.beginPath();
      for (let x = gap; x < w; x += gap) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = gap; y < h; y += gap) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      break;
    }
    case 'waves': {
      linear([[0, hslToCss(hue, sat, 0.14)], [1, hslToCss(hue + 20, sat, 0.28)]], 0, 0, w, h);
      ctx.save();
      for (let i = 0; i < 4; i++) {
        ctx.globalAlpha = 0.08 + i * 0.03;
        ctx.fillStyle = i % 2 ? '#ffffff' : hslToCss(hue + 30, sat, 0.6);
        ctx.beginPath();
        ctx.moveTo(0, h);
        const baseY = h * (0.35 + i * 0.16);
        const amp = h * 0.12;
        for (let x = 0; x <= w; x += w / 32) {
          ctx.lineTo(x, baseY + Math.sin((x / w) * Math.PI * 3 + i) * amp);
        }
        ctx.lineTo(w, h);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
      break;
    }
    case 'lowpoly': {
      linear([[0, hslToCss(hue, sat, 0.16)], [1, hslToCss(hue, sat, 0.3)]], 0, 0, w, h);
      const cols = 10;
      const rows = 3;
      const cw = w / cols;
      const ch = h / rows;
      const jitter = (n: number) => (Math.sin(n * 12.9898) * 43758.5453) % 1;
      for (let r2 = 0; r2 < rows; r2++) {
        for (let c2 = 0; c2 < cols; c2++) {
          const lx = c2 * cw;
          const ty = r2 * ch;
          const shade = 0.16 + Math.abs(jitter(r2 * 31 + c2)) * 0.22;
          ctx.fillStyle = hslToCss(hue, sat, shade);
          ctx.beginPath();
          ctx.moveTo(lx, ty);
          ctx.lineTo(lx + cw, ty);
          ctx.lineTo(lx, ty + ch);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = hslToCss(hue, sat, shade + 0.05);
          ctx.beginPath();
          ctx.moveTo(lx + cw, ty);
          ctx.lineTo(lx + cw, ty + ch);
          ctx.lineTo(lx, ty + ch);
          ctx.closePath();
          ctx.fill();
        }
      }
      break;
    }
    case 'glow': {
      linear([[0, hslToCss(hue, sat * 0.6, 0.1)], [1, hslToCss(hue, sat * 0.7, 0.16)]], 0, 0, 0, h);
      const g = ctx.createRadialGradient(w * 0.85, h * 0.1, 0, w * 0.85, h * 0.1, w * 0.6);
      g.addColorStop(0, hslToCss(hue, sat, 0.55, 0.85));
      g.addColorStop(1, hslToCss(hue, sat, 0.5, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
      break;
    }
    case 'topo': {
      linear([[0, hslToCss(hue, sat, 0.13)], [1, hslToCss(hue, sat, 0.24)]], 0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.1)';
      ctx.lineWidth = Math.max(1, h * 0.006);
      for (let i = 1; i < 7; i++) {
        ctx.beginPath();
        for (let x = 0; x <= w; x += w / 48) {
          const y = h * 0.5 + Math.sin(x / (w / 6) + i) * h * (0.12 + i * 0.04) + (i - 3) * h * 0.12;
          if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      break;
    }
    case 'circuit': {
      linear([[0, hslToCss(hue, sat, 0.12)], [1, hslToCss(hue, sat, 0.2)]], 0, 0, w, h);
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = Math.max(1, h * 0.006);
      const gap = h * 0.2;
      const rnd = (n: number) => Math.abs(Math.sin(n * 7.13) * 1000) % 1;
      // Horizontal traces with occasional short vertical jogs (drawn as separate strokes).
      for (let y = gap; y < h; y += gap) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
        for (let x = gap; x < w; x += gap) {
          if (rnd(x * 1.7 + y) > 0.55) {
            const ny = y + (rnd(x) > 0.5 ? 1 : -1) * gap * 0.5;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x, ny);
            ctx.stroke();
          }
        }
      }
      // Solder nodes.
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      for (let y = gap; y < h; y += gap) {
        for (let x = gap; x < w; x += gap) {
          if (rnd(x * 0.3 + y * 0.7) > 0.6) {
            ctx.beginPath();
            ctx.arc(x, y, Math.max(2, h * 0.014), 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      break;
    }
    default:
      linear([[0, hslToCss(hue, sat, 0.16)], [1, hslToCss(hue, sat, 0.3)]], 0, 0, w, h);
  }
}

// ── Compose (overlay + export) ─────────────────────────────────────────────
function pickMime(): { mime: string; quality: number } {
  try {
    const c = document.createElement('canvas');
    c.width = 2;
    c.height = 2;
    const webp = c.toDataURL('image/webp');
    if (webp.startsWith('data:image/webp')) return { mime: 'image/webp', quality: 0.82 };
  } catch {
    /* ignore */
  }
  return { mime: 'image/jpeg', quality: 0.86 };
}

function applyOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, overlay: number, text: HeaderImageText): void {
  if (overlay <= 0) return;
  // Light text → darken; dark text → lighten. A gentle gradient adds depth while a
  // flat floor guarantees contrast across the whole band.
  const base = text === 'light' ? '0,0,0' : '255,255,255';
  ctx.fillStyle = `rgba(${base},${overlay * 0.72})`;
  ctx.fillRect(0, 0, w, h);
  const g = ctx.createLinearGradient(0, h, 0, 0);
  g.addColorStop(0, `rgba(${base},${clamp(overlay * 0.5, 0, 0.6)})`);
  g.addColorStop(1, `rgba(${base},0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

function dims(aspect: number, width = OUTPUT_WIDTH): { w: number; h: number } {
  const a = clamp(aspect || 5, 1, 14);
  return { w: width, h: Math.round(width / a) };
}

/** Paint a preset and export a compressed, overlay-baked data URL. */
export function bakePreset(
  presetId: string,
  accent: string,
  opts: { aspect: number; overlay: number; text: HeaderImageText },
): string {
  const { w, h } = dims(opts.aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  paintPreset(ctx, w, h, accent, presetId);
  applyOverlay(ctx, w, h, opts.overlay, opts.text);
  const { mime, quality } = pickMime();
  return canvas.toDataURL(mime, quality);
}

export interface CropRect {
  /** Normalized (0..1) source rectangle to draw into the full band. */
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Crop a loaded image to the band aspect and export a compressed data URL. */
export function bakeFromImage(
  img: HTMLImageElement,
  crop: CropRect,
  opts: { aspect: number; overlay: number; text: HeaderImageText },
): string {
  const { w, h } = dims(opts.aspect);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingQuality = 'high';
  const sx = crop.sx * img.naturalWidth;
  const sy = crop.sy * img.naturalHeight;
  const sw = crop.sw * img.naturalWidth;
  const sh = crop.sh * img.naturalHeight;
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  applyOverlay(ctx, w, h, opts.overlay, opts.text);
  const { mime, quality } = pickMime();
  return canvas.toDataURL(mime, quality);
}

/** Small, vivid (no overlay) preview swatch for the preset gallery. */
export function presetThumb(presetId: string, accent: string): string {
  const w = 240;
  const h = Math.round(w / THUMB_ASPECT);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  paintPreset(ctx, w, h, accent, presetId);
  return canvas.toDataURL('image/webp');
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
