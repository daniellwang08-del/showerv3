import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { resetAdminUserPassword } from '@/api/adminApi';
import type { AdminUser } from '@/types/admin';
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
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { errDetail } from './userActions';

export const resetPasswordSchema = z
  .object({
    password: z
      .string()
      .trim()
      .min(8, 'Password must be at least 8 characters')
      .max(255, 'Password must be at most 255 characters')
      .regex(/[A-Z]/, 'Include an uppercase letter')
      .regex(/[a-z]/, 'Include a lowercase letter')
      .regex(/\d/, 'Include a number'),
    confirm: z.string().trim(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], message: 'Passwords do not match' });

type ResetPasswordValues = z.infer<typeof resetPasswordSchema>;

export function ResetPasswordForm({ user }: { user: AdminUser }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [error, setError] = useState('');
  const form = useForm<ResetPasswordValues>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { password: '', confirm: '' },
  });
  const { errors } = form.formState;

  const mutation = useMutation({
    mutationFn: (password: string) => resetAdminUserPassword(user.id, password),
    onSuccess: () => {
      toast.success(`Password updated for ${user.email}`);
      setConfirming(null);
      form.reset();
    },
    onError: (e) => setError(errDetail(e, 'Password reset failed')),
  });

  return (
    <>
      <form
        noValidate
        onSubmit={form.handleSubmit((v) => {
          setError('');
          setConfirming(v.password);
        })}
      >
        <FieldGroup className="gap-3">
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="admin-user-password">New password</FieldLabel>
            <Input
              id="admin-user-password"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.password}
              {...form.register('password')}
            />
            <FieldError errors={[errors.password]} />
          </Field>
          <Field data-invalid={!!errors.confirm}>
            <FieldLabel htmlFor="admin-user-password-confirm">Confirm password</FieldLabel>
            <Input
              id="admin-user-password-confirm"
              type="password"
              autoComplete="new-password"
              aria-invalid={!!errors.confirm}
              {...form.register('confirm')}
            />
            <FieldError errors={[errors.confirm]} />
          </Field>
          <div>
            <Button type="submit" variant="outline" size="sm">
              <KeyRound /> Reset password
            </Button>
          </div>
        </FieldGroup>
      </form>

      <AlertDialog
        open={confirming != null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) {
            setConfirming(null);
            setError('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset password?</AlertDialogTitle>
            <AlertDialogDescription>
              Replace the password for <strong className="text-foreground">{user.email}</strong>. Their current
              password stops working immediately and they are signed out of the web app and the extension.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => confirming != null && mutation.mutate(confirming)}
            >
              {mutation.isPending && <Loader2 className="animate-spin" />}
              Reset
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
