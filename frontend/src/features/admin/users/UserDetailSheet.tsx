import { useState, type ReactNode } from 'react';
import { Copy, Shield, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminUser } from '@/types/admin';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmActionDialog } from './ConfirmActionDialog';
import { ResetPasswordForm } from './ResetPasswordForm';
import { formatDate, RoleBadge, StatusBadge, YouBadge } from './UserBadges';
import { userLabel, type PendingAction } from './userActions';

function Section({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
    </section>
  );
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7rem_1fr] items-baseline gap-3 py-1.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function UserDetailSheet({
  user,
  meId,
  onClose,
}: {
  user: AdminUser | null;
  meId?: string;
  onClose: () => void;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);

  return (
    <Sheet open={user != null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        {user && <SheetBody user={user} isSelf={user.id === meId} onAction={setPending} />}
        <ConfirmActionDialog
          action={pending}
          onClose={() => setPending(null)}
          onDone={(a) => a.kind === 'delete' && onClose()}
        />
      </SheetContent>
    </Sheet>
  );
}

function SheetBody({
  user,
  isSelf,
  onAction,
}: {
  user: AdminUser;
  isSelf: boolean;
  onAction: (a: PendingAction) => void;
}) {
  const copyId = () => {
    void navigator.clipboard?.writeText(user.id).then(
      () => toast.success('User ID copied'),
      () => toast.error('Could not copy'),
    );
  };

  return (
    <>
      <SheetHeader className="border-b pr-12">
        <SheetTitle className="flex items-center gap-2">
          <span className="truncate">{userLabel(user)}</span>
          {isSelf && <YouBadge />}
        </SheetTitle>
        <SheetDescription className="truncate">{user.email}</SheetDescription>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <RoleBadge user={user} />
          <StatusBadge user={user} />
        </div>
      </SheetHeader>

      <div className="scrollbar-thin flex-1 space-y-6 overflow-y-auto p-4">
        <Section title="Details">
          <dl className="divide-y">
            <DetailRow label="Email">{user.email}</DetailRow>
            <DetailRow label="Name">{user.name || '-'}</DetailRow>
            <DetailRow label="Display name">{user.display_name || '-'}</DetailRow>
            <DetailRow label="Created">
              <span className="tabular-nums">{formatDate(user.created_at, true)}</span>
            </DetailRow>
            <DetailRow label="User ID">
              <span className="flex items-center gap-1">
                <code className="truncate font-mono text-xs text-muted-foreground">{user.id}</code>
                <Button variant="ghost" size="icon-xs" aria-label="Copy user ID" onClick={copyId}>
                  <Copy />
                </Button>
              </span>
            </DetailRow>
          </dl>
        </Section>

        <Separator />

        <Section
          title="Role"
          description={
            isSelf && user.is_admin
              ? "You can't remove your own admin access."
              : user.is_admin
                ? 'Admins can open the admin console and manage every user.'
                : 'Grant access to the admin console.'
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={isSelf && user.is_admin}
            onClick={() => onAction({ kind: 'role', user, next: !user.is_admin })}
          >
            {user.is_admin ? <ShieldOff /> : <Shield />}
            {user.is_admin ? 'Remove admin' : 'Make admin'}
          </Button>
        </Section>

        <Section
          title="Account status"
          description={
            isSelf && user.is_active
              ? "You can't disable your own account."
              : user.is_active
                ? 'Disabled users cannot sign in.'
                : 'This account is disabled and cannot sign in.'
          }
        >
          <Button
            variant="outline"
            size="sm"
            disabled={isSelf && user.is_active}
            onClick={() => onAction({ kind: 'active', user, next: !user.is_active })}
          >
            {user.is_active ? <UserX /> : <UserCheck />}
            {user.is_active ? 'Disable account' : 'Enable account'}
          </Button>
        </Section>

        <Separator />

        <Section title="Reset password" description="Set a temporary password (min 8 characters) and share it securely.">
          <ResetPasswordForm key={user.id} user={user} />
        </Section>

        <Separator />

        <Section
          title="Danger zone"
          description={
            isSelf
              ? "You can't delete your own account."
              : 'Permanently delete this user and all of their data.'
          }
        >
          <Button variant="destructive" size="sm" disabled={isSelf} onClick={() => onAction({ kind: 'delete', user })}>
            <Trash2 /> Delete user
          </Button>
        </Section>
      </div>
    </>
  );
}
