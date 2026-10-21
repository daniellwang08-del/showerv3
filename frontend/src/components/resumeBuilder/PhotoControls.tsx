import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Info, Trash2, Upload, UserRound } from 'lucide-react';
import type { PhotoShape, PhotoSize, ResumePhoto } from '../../types/resumeDesign';
import { ControlCard, Segmented, Toggle } from './controls';
import { PhotoCropModal } from '../photo/PhotoCropModal';
import { PHOTO_ACCEPT, readPhotoFile } from '../photo/photoFile';

const SHAPE_RADIUS: Record<PhotoShape, string> = { circle: '50%', rounded: '16.67%', square: '0' };

/** Optional resume headshot. Copies from the profile photo, never back to it. */
export function PhotoControls({
  photo,
  profilePhoto,
  onChange,
}: {
  photo: ResumePhoto | null | undefined;
  /** The account's profile photo, when one is set. */
  profilePhoto: string | null | undefined;
  onChange: (photo: ResumePhoto | null) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const place = (dataUrl: string, source: ResumePhoto['source']) => {
    setError(null);
    onChange({
      data_url: dataUrl,
      enabled: true,
      shape: photo?.shape ?? 'circle',
      size: photo?.size ?? 'md',
      source,
    });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCropSrc(await readPhotoFile(file));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That image could not be read.');
    }
  };

  const usingProfile = !!photo && photo.source === 'profile' && photo.data_url === profilePhoto;

  return (
    <ControlCard icon={UserRound} title="Photo (optional)">
      <div className="space-y-3">
        {photo ? (
          <>
            <div className="flex items-center gap-3">
              <img
                src={photo.data_url}
                alt="Resume photo"
                className="h-14 w-14 shrink-0 object-cover ring-1 ring-slate-200"
                style={{ borderRadius: SHAPE_RADIUS[photo.shape], opacity: photo.enabled ? 1 : 0.45 }}
              />
              <div className="min-w-0 flex-1 text-xs text-muted-foreground">
                {photo.source === 'profile' ? 'Copied from your profile photo.' : 'Uploaded for this resume.'}
                {!photo.enabled && <span className="block">Hidden on this resume.</span>}
              </div>
              <button
                type="button"
                onClick={() => onChange(null)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-rose-500 hover:bg-rose-50"
              >
                <Trash2 size={13} /> Remove
              </button>
            </div>
            <Toggle
              label="Show photo on this resume"
              checked={photo.enabled}
              onChange={(enabled) => onChange({ ...photo, enabled })}
            />
            <Segmented<PhotoShape>
              label="Shape"
              value={photo.shape}
              onChange={(shape) => onChange({ ...photo, shape })}
              options={[
                { value: 'circle', label: 'Circle' },
                { value: 'rounded', label: 'Rounded' },
                { value: 'square', label: 'Square' },
              ]}
            />
            <Segmented<PhotoSize>
              label="Size"
              value={photo.size}
              onChange={(size) => onChange({ ...photo, size })}
              options={[
                { value: 'sm', label: 'Small' },
                { value: 'md', label: 'Medium' },
                { value: 'lg', label: 'Large' },
              ]}
            />
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Add a headshot beside your name. It is off unless you add one, and never appears on cover letters.
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => profilePhoto && place(profilePhoto, 'profile')}
            disabled={!profilePhoto || usingProfile}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:border-blue-400 hover:text-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {profilePhoto ? (
              <img src={profilePhoto} alt="" className="h-5 w-5 rounded-full object-cover" />
            ) : (
              <UserRound size={14} />
            )}
            {usingProfile ? 'Using profile photo' : 'Use profile photo'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-600 transition hover:border-blue-400 hover:text-blue-600"
          >
            <Upload size={14} /> {photo ? 'Upload a different photo' : 'Upload photo'}
          </button>
        </div>
        {!profilePhoto && (
          <p className="text-[11px] text-muted-foreground">
            No profile photo yet.{' '}
            <Link to="/app/profile" className="font-medium text-blue-600 hover:underline">
              Add one on your profile
            </Link>{' '}
            to reuse it across resumes.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-rose-600">
            {error}
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={PHOTO_ACCEPT}
          className="hidden"
          aria-label="Upload resume photo"
          onChange={(e) => {
            void onFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />

        <div className="flex gap-2 rounded-lg bg-slate-50 p-2.5 text-[11px] leading-relaxed text-slate-600">
          <Info size={14} className="mt-0.5 shrink-0 text-slate-400" />
          <div className="space-y-1">
            <p>
              <span className="font-semibold text-slate-700">ATS safe.</span> Your name and contact details stay as
              real text before the photo, so applicant tracking systems read them the same way with or without it.
            </p>
            <p>
              <span className="font-semibold text-slate-700">Where it fits.</span> Expected in Germany, Austria,
              Switzerland and much of Europe, Asia and the Middle East. Leave it off for the US, UK, Canada, Ireland and
              Australia, where many recruiters reject resumes with photos to avoid bias.
            </p>
          </div>
        </div>
      </div>

      {cropSrc && (
        <PhotoCropModal
          src={cropSrc}
          onConfirm={(dataUrl) => {
            place(dataUrl, 'upload');
            setCropSrc(null);
          }}
          onCancel={() => setCropSrc(null)}
        />
      )}
    </ControlCard>
  );
}
