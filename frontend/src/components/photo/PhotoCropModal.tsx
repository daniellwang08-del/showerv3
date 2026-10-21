import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, X, ZoomIn } from 'lucide-react';
import { loadImage } from '../resumeBuilder/headerBackgrounds';

const FRAME = 320;
/** Stored edge in px: sharp at the largest resume size (90 pt) on 2x screens and print. */
export const PHOTO_OUTPUT_PX = 480;
const PHOTO_QUALITY = 0.88;

/** Square pan/zoom crop with a round guide. Returns a compressed JPEG data URL. */
export function PhotoCropModal({
  src,
  title = 'Position your photo',
  confirmLabel = 'Use photo',
  onConfirm,
  onCancel,
}: {
  src: string;
  title?: string;
  confirmLabel?: string;
  onConfirm: (dataUrl: string) => void;
  onCancel: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const stateRef = useRef({ scale: 1, minScale: 1, offsetX: 0, offsetY: 0 });
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [zoomPct, setZoomPct] = useState(100);

  const clampOffsets = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    const s = stateRef.current;
    s.offsetX = Math.min(0, Math.max(FRAME - img.naturalWidth * s.scale, s.offsetX));
    s.offsetY = Math.min(0, Math.max(FRAME - img.naturalHeight * s.scale, s.offsetY));
  }, []);

  const draw = useCallback(() => {
    const ctx = canvasRef.current?.getContext('2d');
    const img = imgRef.current;
    if (!ctx || !img) return;
    const s = stateRef.current;
    ctx.clearRect(0, 0, FRAME, FRAME);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, s.offsetX, s.offsetY, img.naturalWidth * s.scale, img.naturalHeight * s.scale);
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadImage(src)
      .then((img) => {
        if (cancelled) return;
        imgRef.current = img;
        const minScale = Math.max(FRAME / img.naturalWidth, FRAME / img.naturalHeight);
        const s = stateRef.current;
        s.scale = minScale;
        s.minScale = minScale;
        s.offsetX = (FRAME - img.naturalWidth * minScale) / 2;
        // Portraits usually have the face in the upper part of the frame.
        s.offsetY = Math.min(0, (FRAME - img.naturalHeight * minScale) / 4);
        clampOffsets();
        setZoomPct(100);
        setReady(true);
        draw();
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [src, clampOffsets, draw]);

  const applyZoom = (pct: number) => {
    const s = stateRef.current;
    if (!imgRef.current) return;
    const next = s.minScale * (pct / 100);
    const imgX = (FRAME / 2 - s.offsetX) / s.scale;
    const imgY = (FRAME / 2 - s.offsetY) / s.scale;
    s.scale = next;
    s.offsetX = FRAME / 2 - imgX * next;
    s.offsetY = FRAME / 2 - imgY * next;
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
    const out = document.createElement('canvas');
    out.width = PHOTO_OUTPUT_PX;
    out.height = PHOTO_OUTPUT_PX;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    // JPEG has no alpha; transparent PNG areas become white instead of black.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PHOTO_OUTPUT_PX, PHOTO_OUTPUT_PX);
    ctx.imageSmoothingQuality = 'high';
    const k = PHOTO_OUTPUT_PX / FRAME;
    ctx.drawImage(img, s.offsetX * k, s.offsetY * k, img.naturalWidth * s.scale * k, img.naturalHeight * s.scale * k);
    onConfirm(out.toDataURL('image/jpeg', PHOTO_QUALITY));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/70 p-3 backdrop-blur-sm sm:p-4"
    >
      <div className="w-full max-w-md rounded-2xl bg-white p-4 shadow-2xl sm:p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X size={18} />
          </button>
        </div>

        {failed ? (
          <p className="py-10 text-center text-sm text-rose-600">This image could not be read. Try a JPEG or PNG file.</p>
        ) : (
          <>
            <div className="flex justify-center">
              <div
                className="relative overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200"
                style={{ width: FRAME, height: FRAME, maxWidth: '100%', cursor: 'grab', touchAction: 'none' }}
              >
                <canvas
                  ref={canvasRef}
                  width={FRAME}
                  height={FRAME}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerLeave={onPointerUp}
                  style={{ display: 'block' }}
                />
                {/* Round guide: shows what a circle-cropped photo keeps. */}
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: '0 0 0 9999px rgba(15,23,42,0.35)', outline: '2px solid rgba(255,255,255,0.9)' }}
                />
              </div>
            </div>

            <p className="mt-2 text-center text-xs text-slate-400">
              Drag to center your face. Head and shoulders, plain background, looking at the camera.
            </p>

            <div className="mt-3 flex items-center gap-3">
              <ZoomIn size={16} className="shrink-0 text-slate-500" />
              <input
                type="range"
                aria-label="Zoom"
                min={100}
                max={400}
                value={zoomPct}
                onChange={(e) => applyZoom(Number(e.target.value))}
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-200 accent-blue-600"
              />
              <span className="w-12 shrink-0 text-right text-xs tabular-nums text-slate-500">{zoomPct}%</span>
            </div>
          </>
        )}

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
            <Check size={16} /> {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
