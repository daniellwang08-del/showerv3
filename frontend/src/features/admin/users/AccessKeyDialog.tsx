import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { issueSignupAccessKey } from '@/api/adminApi';
import type { IssuedAccessKey, SignupRequest } from '@/types/admin';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  EXPIRY_PRESETS,
  MAX_KEY_LIFETIME_MS,
  MIN_KEY_LIFETIME_MS,
  resolveExpiry,
  toLocalInputValue,
  type ExpiryPreset,
} from './accessKeyExpiry';
import { formatDate } from './UserBadges';
import { errDetail } from './userActions';
import { signupRequestsKey } from './signupRequests';

const DAY_MS = 24 * 60 * 60 * 1000;

function KeyForm({ request, onIssued }: { request: SignupRequest; onIssued: (k: IssuedAccessKey) => void }) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<ExpiryPreset>('3d');
  const [custom, setCustom] = useState(() => toLocalInputValue(new Date(Date.now() + 7 * DAY_MS)));
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: (expiresAt: Date) => issueSignupAccessKey(request.id, expiresAt),
    onSuccess: (issued) => {
      void qc.invalidateQueries({ queryKey: signupRequestsKey });
      onIssued(issued);
    },
    onError: (e) => setError(errDetail(e, 'Could not generate a key')),
  });

  const submit = () => {
    setError('');
    const result = resolveExpiry(preset, custom);
    if ('error' in result) {
      setError(result.error);
      return;
    }
    mutation.mutate(result.expiresAt);
  };

  const now = Date.now();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Generate access key</DialogTitle>
        <DialogDescription>
          A one-time key for <strong className="text-foreground">{request.email}</strong>. Entering it on their
          waiting screen approves the account.
          {request.active_key ? ' Their current key stops working.' : ''}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="access-key-expiry">Expires in</Label>
          <Select
            value={preset}
            items={EXPIRY_PRESETS}
            onValueChange={(v) => setPreset((v as ExpiryPreset | null) ?? '3d')}
          >
            <SelectTrigger id="access-key-expiry" className="w-full" aria-label="Key expiry">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {preset === 'custom' && (
          <div className="space-y-1.5">
            <Label htmlFor="access-key-custom">Expires at (your local time)</Label>
            <Input
              id="access-key-custom"
              type="datetime-local"
              value={custom}
              min={toLocalInputValue(new Date(now + MIN_KEY_LIFETIME_MS))}
              max={toLocalInputValue(new Date(now + MAX_KEY_LIFETIME_MS))}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>

      <DialogFooter showCloseButton>
        <Button onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />} Generate key
        </Button>
      </DialogFooter>
    </>
  );
}

function IssuedKey({ request, issued }: { request: SignupRequest; issued: IssuedAccessKey }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void Promise.resolve(navigator.clipboard?.writeText(issued.key)).then(
      () => {
        setCopied(true);
        toast.success('Key copied');
      },
      () => toast.error('Copy failed. Select the key and copy it manually.'),
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Access key ready</DialogTitle>
        <DialogDescription>
          Send this to <strong className="text-foreground">{request.email}</strong>. It is shown only once and works a
          single time.
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3">
        <code
          data-testid="issued-access-key"
          className="min-w-0 flex-1 font-mono text-base font-semibold tracking-[0.15em] break-all select-all sm:text-lg sm:tracking-[0.3em]"
        >
          {issued.key}
        </code>
        <Button variant="outline" size="sm" onClick={copy} aria-label="Copy key">
          {copied ? <Check /> : <Copy />} {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Expires {formatDate(issued.expires_at, true)}</p>

      <DialogFooter showCloseButton />
    </>
  );
}

export function AccessKeyDialog({ request, onClose }: { request: SignupRequest | null; onClose: () => void }) {
  const [issued, setIssued] = useState<IssuedAccessKey | null>(null);

  return (
    <Dialog
      open={request != null}
      onOpenChange={(open) => {
        if (!open) {
          setIssued(null);
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        {request &&
          (issued ? <IssuedKey request={request} issued={issued} /> : <KeyForm request={request} onIssued={setIssued} />)}
      </DialogContent>
    </Dialog>
  );
}
