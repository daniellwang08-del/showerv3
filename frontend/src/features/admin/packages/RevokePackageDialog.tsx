import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Loader2, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { adminRevokePackage } from '@/api/storeApi';
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
import { Textarea } from '@/components/ui/textarea';
import type { AdminPackage } from '@/types/store';
import { extractApiErrorMessage } from '@/utils/profileErrors';

export function RevokePackageDialog({
  pkg,
  onClose,
  onRevoked,
}: {
  pkg: AdminPackage | null;
  onClose: () => void;
  onRevoked: () => void;
}) {
  const [reason, setReason] = useState('');
  const revoke = useMutation({
    mutationFn: (p: AdminPackage) => adminRevokePackage(p.id, reason.trim()),
    onSuccess: () => {
      toast.success('Package revoked');
      setReason('');
      onRevoked();
      onClose();
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not revoke the package.')),
  });

  const holder = pkg?.owner ? `${pkg.owner.name} (${pkg.owner.email})` : (pkg?.pending_email ?? 'its holder');
  const name = pkg?.kind === 'team' ? 'TEAM' : pkg?.name;

  return (
    <AlertDialog
      open={pkg != null}
      onOpenChange={(open) => {
        if (!open && !revoke.isPending) {
          setReason('');
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        {pkg && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Revoke this {name} package?</AlertDialogTitle>
              <AlertDialogDescription>
                It leaves the store of {holder} and can no longer be used or given away. The record stays in the
                package history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="space-y-1.5">
              <label htmlFor="revoke-reason" className="text-xs font-medium text-muted-foreground">
                Reason (kept in the admin history)
              </label>
              <Textarea
                id="revoke-reason"
                rows={2}
                maxLength={300}
                placeholder="Granted to the wrong account"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={revoke.isPending}>Cancel</AlertDialogCancel>
              <Button variant="destructive" disabled={revoke.isPending} onClick={() => revoke.mutate(pkg)}>
                {revoke.isPending ? <Loader2 className="animate-spin" /> : <Undo2 />}
                Revoke
              </Button>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
