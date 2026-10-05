import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, KeyRound, Loader2, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { approveSignup, rejectSignup } from '@/api/adminApi';
import type { SignupRequest } from '@/types/admin';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { AccessKeyDialog } from './AccessKeyDialog';
import { formatDate } from './UserBadges';
import { adminUsersKey, errDetail } from './userActions';
import { signupRequestsKey, useSignupRequests } from './signupRequests';

type Decision = { kind: 'approve' | 'reject'; request: SignupRequest };

function RequestRow({
  request,
  busy,
  onApprove,
  onReject,
  onKey,
}: {
  request: SignupRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onKey: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{request.email}</p>
        <p className="text-xs text-muted-foreground">
          Requested {formatDate(request.requested_at, true)}
          {request.active_key ? ` · Key active until ${formatDate(request.active_key.expires_at, true)}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-1.5">
        <Button size="xs" onClick={onApprove} disabled={busy} aria-label={`Approve ${request.email}`}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Approve
        </Button>
        <Button size="xs" variant="outline" onClick={onKey} disabled={busy}>
          <KeyRound /> {request.active_key ? 'New key' : 'Access key'}
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={onReject}
          disabled={busy}
          aria-label={`Reject ${request.email}`}
        >
          <X /> Reject
        </Button>
      </div>
    </li>
  );
}

/** Pending signups waiting for an admin; hidden when there are none. */
export function SignupRequestsPanel() {
  const qc = useQueryClient();
  const requestsQuery = useSignupRequests();
  const requests = requestsQuery.data ?? [];
  const [keyFor, setKeyFor] = useState<SignupRequest | null>(null);
  const [rejecting, setRejecting] = useState<SignupRequest | null>(null);

  const decide = useMutation({
    mutationFn: ({ kind, request }: Decision) =>
      kind === 'approve' ? approveSignup(request.id) : rejectSignup(request.id),
    onSuccess: (_user, { kind, request }) => {
      qc.setQueryData<SignupRequest[]>(signupRequestsKey, (prev) => prev?.filter((r) => r.id !== request.id));
      toast.success(kind === 'approve' ? `${request.email} approved` : `${request.email} rejected`);
      setRejecting(null);
    },
    onError: (e) => toast.error(errDetail(e, 'Action failed')),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: signupRequestsKey });
      void qc.invalidateQueries({ queryKey: adminUsersKey });
    },
  });

  if (requests.length === 0) return null;
  const busyId = decide.isPending ? decide.variables?.request.id : undefined;

  return (
    <section aria-labelledby="signup-requests-title" className="overflow-hidden rounded-xl border border-brand/30 bg-brand-soft/30">
      <header className="flex items-center gap-2 border-b border-brand/20 px-4 py-2.5">
        <UserPlus className="size-4 text-brand" aria-hidden />
        <h2 id="signup-requests-title" className="text-sm font-semibold">
          Signup requests
        </h2>
        <span className="rounded-full bg-brand px-1.5 text-xs font-semibold text-white tabular-nums">
          {requests.length}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          Approve, or send a one-time access key the user enters themselves.
        </span>
      </header>
      <ul className="divide-y divide-brand/15">
        {requests.map((r) => (
          <RequestRow
            key={r.id}
            request={r}
            busy={busyId === r.id}
            onApprove={() => decide.mutate({ kind: 'approve', request: r })}
            onReject={() => setRejecting(r)}
            onKey={() => setKeyFor(r)}
          />
        ))}
      </ul>

      <AccessKeyDialog request={keyFor} onClose={() => setKeyFor(null)} />

      <AlertDialog open={rejecting != null} onOpenChange={(open) => !open && !decide.isPending && setRejecting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject signup?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong className="text-foreground">{rejecting?.email}</strong> will be signed out and cannot sign in.
              You can still approve the account later from the users list.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={decide.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={decide.isPending}
              onClick={() => rejecting && decide.mutate({ kind: 'reject', request: rejecting })}
            >
              {decide.isPending && <Loader2 className="animate-spin" />} Reject
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
