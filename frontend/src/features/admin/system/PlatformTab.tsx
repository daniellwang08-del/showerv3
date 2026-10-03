import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { SaveBar } from '@/components/app/SaveBar';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { addBlockedDomain, fetchBlockedDomains, removeBlockedDomain, updateSystemSettings } from '@/api/adminApi';
import type { SystemSettingsResponse } from '@/types/admin';
import { ConfirmDialog, NumberSetting, QueryError, TextSetting, ToggleSetting } from './fields';
import { BLOCKED_DOMAINS_KEY, useSetSystemSettings } from './queries';
import { errDetail } from './settingsModel';
import { useReportDirty, useSettingsDraft } from './useSettingsDraft';

const DRAFT_KEYS = ['default_min_match_score', 'default_dedup_recycle_days', 'extension_token_expire_days', 'auth_password'];

export function PlatformTab({
  settings,
  active,
  onDirtyChange,
}: {
  settings: SystemSettingsResponse;
  active: boolean;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const setSettings = useSetSystemSettings();
  const draft = useSettingsDraft(settings, DRAFT_KEYS);
  const [saving, setSaving] = useState(false);
  useReportDirty(draft.dirty, onDirtyChange);

  const handleSave = async () => {
    setSaving(true);
    try {
      setSettings(await updateSystemSettings(draft.payload()));
      draft.clear();
      toast.success('Platform defaults saved');
    } catch (err) {
      toast.error(errDetail(err, 'Failed to save platform defaults'));
    } finally {
      setSaving(false);
    }
  };

  const passwordOverridden = draft.item('auth_password')?.overridden;

  return (
    <div className="space-y-6">
      <SectionCard title="Platform defaults" description="Defaults for users who haven't customised these, plus shared auth.">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <NumberSetting draft={draft} k="default_min_match_score" label="Min match score" hint="0–100. 0 shows all jobs." />
          <NumberSetting draft={draft} k="default_dedup_recycle_days" label="Dedup recycle" suffix="days" />
          <NumberSetting draft={draft} k="extension_token_expire_days" label="Extension token lifetime" suffix="days" />
          <TextSetting
            draft={draft}
            k="auth_password"
            label="Auth password"
            type="password"
            className="sm:col-span-2 lg:col-span-3"
            placeholder={passwordOverridden ? 'Override set; type a new value to replace it' : 'Using .env value'}
            hint="Leave empty to keep the current value."
          />
        </div>
      </SectionCard>

      <SectionCard title="Duplicate rules" description="Platform defaults for dedup rules. These switches save immediately.">
        <div className="space-y-3">
          <ToggleSetting
            item={draft.item('dedup_rule_applied_company_enabled')}
            label="Hide applied companies"
            description="Hide jobs at companies a user applied to within the recycle window."
          />
          <Separator />
          <ToggleSetting
            item={draft.item('dedup_rule_score_comparison_enabled')}
            label="Score comparison"
            description="At the same company, keep only the higher-scoring job."
          />
        </div>
      </SectionCard>

      <BlockedDomainsSection />

      <SaveBar
        dirty={draft.dirty && active}
        saving={saving}
        disabled={!draft.valid}
        onSave={() => void handleSave()}
        onDiscard={() => draft.clear()}
      />
    </div>
  );
}

function BlockedDomainsSection() {
  const queryClient = useQueryClient();
  const domains = useQuery({ queryKey: BLOCKED_DOMAINS_KEY, queryFn: fetchBlockedDomains });
  const [domain, setDomain] = useState('');
  const [reason, setReason] = useState('');
  const [toRemove, setToRemove] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => addBlockedDomain(domain.trim(), reason.trim()),
    onSuccess: () => {
      setDomain('');
      setReason('');
      void queryClient.invalidateQueries({ queryKey: BLOCKED_DOMAINS_KEY });
      toast.success('Domain blocked');
    },
    onError: (err) => toast.error(errDetail(err, 'Failed to add domain')),
  });
  const remove = useMutation({
    mutationFn: (d: string) => removeBlockedDomain(d),
    onSuccess: (_r, d) => {
      void queryClient.invalidateQueries({ queryKey: BLOCKED_DOMAINS_KEY });
      toast.success(`Unblocked ${d}`);
    },
    onError: () => toast.error('Failed to remove domain'),
  });

  return (
    <SectionCard title="Blocked domains" description="Domains that reject automatic job extraction.">
      <form
        className="mb-4 grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim() && reason.trim()) add.mutate();
        }}
      >
        <Field>
          <FieldLabel htmlFor="block-domain">Domain</FieldLabel>
          <Input id="block-domain" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
        </Field>
        <Field>
          <FieldLabel htmlFor="block-reason">Reason</FieldLabel>
          <Input id="block-reason" placeholder="Why extraction is blocked" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
        <Button type="submit" disabled={add.isPending || !domain.trim() || !reason.trim()}>
          {add.isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          Block
        </Button>
      </form>

      {domains.isError ? (
        <QueryError message={errDetail(domains.error, 'Failed to load blocked domains.')} onRetry={() => void domains.refetch()} />
      ) : !domains.data ? (
        <Skeleton className="h-24 rounded-lg" aria-label="Loading blocked domains" />
      ) : domains.data.length === 0 ? (
        <p className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">No blocked domains</p>
      ) : (
        <ul className="max-h-96 divide-y overflow-y-auto rounded-lg border" aria-label="Blocked domains">
          {domains.data.map((d) => (
            <li key={d.domain} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{d.domain}</p>
                <p className="truncate text-sm text-muted-foreground">{d.reason}</p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${d.domain}`}
                disabled={remove.isPending && remove.variables === d.domain}
                onClick={() => setToRemove(d.domain)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={toRemove !== null}
        onOpenChange={(open) => !open && setToRemove(null)}
        title="Unblock domain?"
        description={`Jobs from ${toRemove ?? ''} will be extracted automatically again.`}
        confirmLabel="Unblock"
        destructive
        onConfirm={() => toRemove && remove.mutate(toRemove)}
      />
    </SectionCard>
  );
}
