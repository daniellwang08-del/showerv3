import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
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
import {
  actionConfirmLabel,
  actionSuccess,
  actionTitle,
  adminUsersKey,
  applyResult,
  errDetail,
  isDestructive,
  runAction,
  type PendingAction,
} from './userActions';

function ActionDescription({ action }: { action: PendingAction }) {
  if (action.kind === 'delete') {
    return (
      <>
        Permanently delete <strong className="text-foreground">{action.user.email}</strong> and all of their data. This
        cannot be undone.
      </>
    );
  }
  if (action.kind === 'role') {
    return (
      <>
        {action.next ? 'Grant' : 'Remove'} admin access for{' '}
        <strong className="text-foreground">{action.user.email}</strong>.
      </>
    );
  }
  if (action.kind === 'active') {
    return (
      <>
        {action.next ? 'Re-enable' : 'Disable'} <strong className="text-foreground">{action.user.email}</strong>.
        {action.next ? ' They will be able to sign in again.' : ' Disabled users cannot sign in.'}
      </>
    );
  }
  const n = action.users.length;
  return (
    <>
      {action.bulk === 'delete' ? (
        <>
          Permanently delete <strong className="text-foreground tabular-nums">{n}</strong> user{n === 1 ? '' : 's'} and
          all of their data. This cannot be undone.
        </>
      ) : (
        <>
          Apply <strong className="text-foreground">{action.bulk}</strong> to{' '}
          <strong className="text-foreground tabular-nums">{n}</strong> selected user{n === 1 ? '' : 's'}.
        </>
      )}
      {n <= 8 && (
        <span className="mt-2 block max-h-32 overflow-y-auto text-xs">
          {action.users.map((u) => (
            <span key={u.id} className="block truncate">
              {u.email}
            </span>
          ))}
        </span>
      )}
    </>
  );
}

export function ConfirmActionDialog({
  action,
  onClose,
  onDone,
}: {
  action: PendingAction | null;
  onClose: () => void;
  onDone?: (action: PendingAction) => void;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState('');

  const mutation = useMutation({
    mutationFn: runAction,
    onSuccess: (result, a) => {
      applyResult(qc, result);
      if (result.failures.length) {
        setError(result.failures.slice(0, 5).join('\n'));
        return;
      }
      toast.success(actionSuccess(a));
      onDone?.(a);
      onClose();
    },
    onError: (e) => setError(errDetail(e, 'Action failed')),
    onSettled: () => qc.invalidateQueries({ queryKey: adminUsersKey }),
  });

  const close = () => {
    if (mutation.isPending) return;
    setError('');
    onClose();
  };

  return (
    <AlertDialog open={action != null} onOpenChange={(open) => !open && close()}>
      <AlertDialogContent>
        {action && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{actionTitle(action)}</AlertDialogTitle>
              <AlertDialogDescription render={<div />}>
                <ActionDescription action={action} />
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error && (
              <p role="alert" className="text-sm whitespace-pre-line text-destructive">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
              <Button
                variant={isDestructive(action) ? 'destructive' : 'default'}
                disabled={mutation.isPending}
                onClick={() => {
                  setError('');
                  mutation.mutate(action);
                }}
              >
                {mutation.isPending && <Loader2 className="animate-spin" />}
                {actionConfirmLabel(action)}
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
