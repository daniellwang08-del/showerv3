import { useMemo, useRef, useState } from 'react';
import { ImageIcon, Trash2, Upload, Crop as CropIcon } from 'lucide-react';
import type { HeaderImage, HeaderImageText, ResumeDesign } from '../../types/resumeDesign';
import { headerPadSides } from '../../types/resumeDesign';
import { ControlCard, Segmented, Slider } from './controls';
import {
  HEADER_PRESETS,
  bakeFromImage,
  bakePreset,
  fileToDataUrl,
  loadImage,
  presetThumb,
} from './headerBackgrounds';
import { HeaderImageCropModal, type CropResult } from './HeaderImageCropModal';

/** Header band aspect (page width / band height) estimated from typography + padding.
 * Kept close to the .docx band height so the cropped image fills it with negligible
 * distortion. */
export function estimateBandAspect(design: ResumeDesign): number {
  const base = design.typography.base_font_pt;
  const hp = headerPadSides(design.layout);
  const name = base * design.typography.name_scale * 1.15;
  const title = base * 1.1 * 1.35;
  const contact = base * 0.95 * 1.5;
  const bandH = hp.top + hp.bottom + name + title + contact + 6;
  const pageW = 612; // Letter pt
  return Math.max(2.2, Math.min(9, pageW / bandH));
}

type Working =
  | { kind: 'preset'; presetId: string }
  | { kind: 'upload'; src: string; crop: CropResult['crop'] }
  | null;

export function HeaderImageControls({
  design,
  image,
  onChange,
}: {
  design: ResumeDesign;
  image: HeaderImage | null | undefined;
  onChange: (image: HeaderImage | null) => void;
}) {
  const accent = design.colors.accent;
  const aspect = useMemo(() => estimateBandAspect(design), [design]);
  const overlay = image?.overlay ?? 0.4;
  const text: HeaderImageText = image?.text ?? 'light';

  const workingRef = useRef<Working>(
    image?.source?.startsWith('preset:') ? { kind: 'preset', presetId: image.source.slice('preset:'.length) } : null,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const thumbs = useMemo(
    () => HEADER_PRESETS.map((p) => ({ ...p, thumb: presetThumb(p.id, accent) })),
    [accent],
  );

  const selectPreset = (presetId: string) => {
    workingRef.current = { kind: 'preset', presetId };
    const dataUrl = bakePreset(presetId, accent, { aspect, overlay, text });
    onChange({ data_url: dataUrl, aspect, source: `preset:${presetId}`, overlay, text });
  };

  const reBake = (nextOverlay: number, nextText: HeaderImageText) => {
    const w = workingRef.current;
    if (w?.kind === 'preset') {
      const dataUrl = bakePreset(w.presetId, accent, { aspect, overlay: nextOverlay, text: nextText });
      onChange({ data_url: dataUrl, aspect, source: `preset:${w.presetId}`, overlay: nextOverlay, text: nextText });
    } else if (w?.kind === 'upload') {
      // Re-bake from the retained source + crop so overlay/text apply losslessly.
      const src = w.src;
      const crop = w.crop;
      void loadImage(src).then((img) => {
        const dataUrl = bakeFromImage(img, crop, { aspect, overlay: nextOverlay, text: nextText });
        onChange({ data_url: dataUrl, aspect, source: 'upload', overlay: nextOverlay, text: nextText });
      });
    } else if (image) {
      // Source no longer in memory (e.g. after reload): keep the baked image, update meta.
      onChange({ ...image, overlay: nextOverlay, text: nextText });
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const src = await fileToDataUrl(file);
    setCropSrc(src);
  };

  const onCropConfirm = (result: CropResult) => {
    workingRef.current = { kind: 'upload', src: cropSrc as string, crop: result.crop };
    onChange({ data_url: result.dataUrl, aspect, source: 'upload', overlay, text });
    setCropSrc(null);
  };

  const isUpload = image?.source === 'upload';

  return (
    <ControlCard icon={ImageIcon} title="Header image">
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500">Professional backgrounds</p>
        <div className="flex gap-2 overflow-x-auto pb-1.5" style={{ scrollbarWidth: 'thin' }}>
          {thumbs.map((p) => {
            const selected = image?.source === `preset:${p.id}`;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p.id)}
                title={p.label}
                className={`group relative shrink-0 overflow-hidden rounded-md ring-2 transition ${
                  selected ? 'ring-blue-500' : 'ring-transparent hover:ring-slate-300'
                }`}
                style={{ width: 88, height: 40 }}
              >
                <img src={p.thumb} alt={p.label} className="h-full w-full object-cover" draggable={false} />
              </button>
            );
          })}
        </div>
      </div>

      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-blue-400 hover:text-blue-600"
      >
        <Upload size={14} /> Upload your own image
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />

      {image && (
        <div className="space-y-3 border-t border-slate-100 pt-3">
          <div className="flex items-center gap-3">
            <div className="shrink-0 overflow-hidden rounded-md ring-1 ring-slate-200" style={{ width: 96, height: 44 }}>
              <img src={image.data_url} alt="Header background" className="h-full w-full object-cover" />
            </div>
            <div className="flex flex-1 items-center justify-end gap-1.5">
              {isUpload && (
                <button
                  type="button"
                  onClick={() => {
                    const w = workingRef.current;
                    if (w?.kind === 'upload') setCropSrc(w.src);
                  }}
                  disabled={workingRef.current?.kind !== 'upload'}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-40"
                  title={workingRef.current?.kind === 'upload' ? 'Adjust crop' : 'Re-upload to adjust'}
                >
                  <CropIcon size={13} /> Crop
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  workingRef.current = null;
                  onChange(null);
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-500 hover:bg-rose-50"
              >
                <Trash2 size={13} /> Remove
              </button>
            </div>
          </div>

          <Slider
            label="Overlay strength"
            value={Math.round(overlay * 100)}
            min={0}
            max={85}
            step={5}
            suffix="%"
            onChange={(v) => reBake(v / 100, text)}
          />
          <Segmented<HeaderImageText>
            label="Text color"
            value={text}
            onChange={(v) => reBake(overlay, v)}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      )}

      {cropSrc && (
        <HeaderImageCropModal
          src={cropSrc}
          aspect={aspect}
          overlay={overlay}
          text={text}
          initialCrop={workingRef.current?.kind === 'upload' ? workingRef.current.crop : undefined}
          onConfirm={onCropConfirm}
          onCancel={() => setCropSrc(null)}
        />
      )}
    </ControlCard>
  );
}
