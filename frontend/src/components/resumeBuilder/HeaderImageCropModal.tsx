import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X, ZoomIn } from 'lucide-react';
import type { HeaderImageText } from '../../types/resumeDesign';
import { bakeFromImage, loadImage, type CropRect } from './headerBackgrounds';

const FRAME_W = 560;

export interface CropResult {
  dataUrl: string;
  crop: CropRect;
}

/**
 * Pan/zoom crop dialog. The frame matches the header band's aspect ratio, so the
 * exported image contains ONLY the region shown - keeping the stored asset small.
 */
export function HeaderImageCropModal({
  src,
  aspect,
  overlay,
  text,
  initialCrop,
  onConfirm,
  onCancel,
}: {
  src: string;
  aspect: number;
  overlay: number;
  text: HeaderImageText;
  initialCrop?: CropRect;
  onConfirm: (result: CropResult) => void;
  onCancel: () => void;
}) {
  const frameH = Math.round(FRAME_W / Math.max(1, aspect));
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);

  // View transform: image drawn at (offsetX, offsetY) scaled by `scale` (canvas px).
  const stateRef = useRef({ scale: 1, minScale: 1, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [zoomPct, setZoomPct] = useState(100);

  const clampOffsets = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const s = stateRef.current;
    const iw = img.naturalWidth * s.scale;
    const ih = img.naturalHeight * s.scale;
    s.offsetX = Math.min(0, Math.max(FRAME_W - iw, s.offsetX));
    s.offsetY = Math.min(0, Math.max(frameH - ih, s.offsetY));
  }, [frameH]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const s = stateRef.current;
    ctx.clearRect(0, 0, FRAME_W, frameH);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, s.offsetX, s.offsetY, img.naturalWidth * s.scale, img.naturalHeight * s.scale);
    // Live overlay so the user previews the final legibility treatment.
    const base = text === 'light' ? '0,0,0' : '255,255,255';
    if (overlay > 0) {
      ctx.fillStyle = `rgba(${base},${overlay * 0.72})`;
      ctx.fillRect(0, 0, FRAME_W, frameH);
    }
  }, [frameH, overlay, text]);

  useEffect(() => {
    let cancelled = false;
    loadImage(src).then((img) => {
      if (cancelled) return;
      imgRef.current = img;
      const minScale = Math.max(FRAME_W / img.naturalWidth, frameH / img.naturalHeight);
      const s = stateRef.current;
      if (initialCrop) {
        // Reconstruct view from a stored crop rectangle.
        const sw = initialCrop.sw * img.naturalWidth;
        s.scale = Math.max(minScale, FRAME_W / sw);
        s.minScale = minScale;
        s.offsetX = -initialCrop.sx * img.naturalWidth * s.scale;
        s.offsetY = -initialCrop.sy * img.naturalHeight * s.scale;
      } else {
        s.scale = minScale;
        s.minScale = minScale;
        s.offsetX = (FRAME_W - img.naturalWidth * minScale) / 2;
        s.offsetY = (frameH - img.naturalHeight * minScale) / 2;
      }
      clampOffsets();
      setZoomPct(Math.round((s.scale / s.minScale) * 100));
      setReady(true);
      draw();
    });
    return () => {
      cancelled = true;
    };
  }, [src, frameH, initialCrop, clampOffsets, draw]);

  useEffect(() => {
    if (ready) draw();
  }, [ready, draw]);

  const applyZoom = (pct: number) => {
    const img = imgRef.current;
    if (!img) return;
    const s = stateRef.current;
    const prev = s.scale;
    const next = s.minScale * (pct / 100);
    // Keep the frame center anchored while zooming.
    const cx = FRAME_W / 2;
    const cy = frameH / 2;
    const imgX = (cx - s.offsetX) / prev;
    const imgY = (cy - s.offsetY) / prev;
    s.scale = next;
    s.offsetX = cx - imgX * next;
    s.offsetY = cy - imgY * next;
    clampOffsets();
    setZoomPct(pct);
    draw();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const s = stateRef.current;
    s.offsetX += e.clientX - dragRef.current.x;
    s.offsetY += e.clientY - dragRef.current.y;
    dragRef.current = { x: e.clientX, y: e.clientY };
    clampOffsets();
    draw();
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const confirm = () => {
    const img = imgRef.current;
    if (!img) return;
    const s = stateRef.current;
    const crop: CropRect = {
      sx: -s.offsetX / s.scale / img.naturalWidth,
      sy: -s.offsetY / s.scale / img.naturalHeight,
      sw: FRAME_W / s.scale / img.naturalWidth,
      sh: frameH / s.scale / img.naturalHeight,
    };
    const dataUrl = bakeFromImage(img, crop, { aspect, overlay, text });
    onConfirm({ dataUrl, crop });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl bg-white p-5 shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">Position your header image</h3>
          <button type="button" onClick={onCancel} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700">
            <X size={18} />
          </button>
        </div>

        <div className="flex justify-center">
          <div
            className="relative overflow-hidden rounded-lg ring-1 ring-slate-200"
            style={{ width: FRAME_W, height: frameH, cursor: 'grab', touchAction: 'none' }}
          >
            <canvas
              ref={canvasRef}
              width={FRAME_W}
              height={frameH}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
              style={{ display: 'block' }}
            />
          </div>
        </div>

        <p className="mt-2 text-center text-xs text-slate-400">Drag to reposition. Only the framed area is stored.</p>

        <div className="mt-3 flex items-center gap-3">
          <ZoomIn size={16} className="shrink-0 text-slate-500" />
          <input
            type="range"
            min={100}
            max={400}
            value={zoomPct}
            onChange={(e) => applyZoom(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-blue-600"
          />
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">{zoomPct}%</span>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg px-3 py-1.5 text-sm font-medium text-slate-600 hover:bg-slate-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={!ready}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            <Check size={16} /> Use image
          </button>
        </div>
      </div>
    </div>
  );
}
