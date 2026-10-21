import { useRef, useState } from 'react';
import { Camera, Loader2, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { PhotoCropModal } from '@/components/photo/PhotoCropModal';
import { PHOTO_ACCEPT, readPhotoFile } from '@/components/photo/photoFile';
import { Button } from '@/components/ui/button';
import { useProfilePhoto, useSetProfilePhoto } from '@/hooks/useProfilePhoto';

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || '?';
}

/** Account photo. Resumes copy it only when the user picks it in the studio. */
export function ProfilePhotoCard({ name }: { name: string }) {
  const photo = useProfilePhoto();
  const setPhoto = useSetProfilePhoto();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [cropSrc, setCropSrc] = useState<string | null>(null);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      setCropSrc(await readPhotoFile(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'That image could not be read.');
    }
  };

  const save = (dataUrl: string | null) =>
    setPhoto.mutate(dataUrl, {
      onSuccess: () => toast.success(dataUrl ? 'Profile photo saved' : 'Profile photo removed'),
      onError: () => toast.error(dataUrl ? 'Could not save the photo.' : 'Could not remove the photo.'),
    });

  const current = photo.data ?? null;
  const busy = setPhoto.isPending;

  return (
    <SectionCard
      id="profile-photo"
      title="Profile photo"
      description="Shown on your account. Resumes only include a photo when you add one in the Resume studio."
      icon={Camera}
    >
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative size-20 shrink-0 overflow-hidden rounded-full bg-brand/10 ring-1 ring-border">
          {current ? (
            <img src={current} alt="Your profile photo" className="size-full object-cover" />
          ) : (
            <span aria-hidden className="flex size-full items-center justify-center text-xl font-semibold text-brand">
              {initialsOf(name)}
            </span>
          )}
          {busy ? (
            <span className="absolute inset-0 flex items-center justify-center bg-background/60">
              <Loader2 className="size-5 animate-spin" aria-label="Saving" />
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <Upload />
              {current ? 'Change photo' : 'Upload photo'}
            </Button>
            {current ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => save(null)}
              >
                <Trash2 />
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            JPEG, PNG or WebP. A clear head-and-shoulders shot on a plain background works best.
          </p>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept={PHOTO_ACCEPT}
        className="hidden"
        aria-label="Upload profile photo"
        onChange={(e) => {
          void onFile(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {cropSrc ? (
        <PhotoCropModal
          src={cropSrc}
          title="Position your profile photo"
          confirmLabel="Save photo"
          onConfirm={(dataUrl) => {
            setCropSrc(null);
            save(dataUrl);
          }}
          onCancel={() => setCropSrc(null)}
        />
      ) : null}
    </SectionCard>
  );
}
