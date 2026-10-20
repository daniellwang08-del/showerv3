import { Copy, Fingerprint } from 'lucide-react';
import { toast } from 'sonner';

export function TeamIdBadge({ publicId }: { publicId: string }) {
  const copy = () => {
    void navigator.clipboard?.writeText(publicId).then(
      () => toast.success('Team ID copied'),
      () => toast.error('Could not copy'),
    );
  };
  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Team ID ${publicId}. Copy`}
      title="Copy team ID"
      className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background/70 px-2.5 py-0.5 font-mono text-xs text-foreground transition-colors hover:bg-muted"
    >
      <Fingerprint className="size-3 text-muted-foreground" aria-hidden />
      {publicId}
      <Copy className="size-3 text-muted-foreground" aria-hidden />
    </button>
  );
}
