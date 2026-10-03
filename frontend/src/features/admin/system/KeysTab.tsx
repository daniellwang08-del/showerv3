import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, AlertCircle, Loader2, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { createLlmKey, deleteLlmKey, updateLlmKey, validateLlmKey } from '@/api/adminApi';
import type { LlmKeysResponse, LlmProvider, LlmProviderKey, SystemSettingsResponse } from '@/types/admin';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './fields';
import { LLM_KEYS_KEY, patchLlmKeys, useRefreshLlm } from './queries';
import { errDetail, formatLabel, PROVIDERS } from './settingsModel';

export function KeysTab({ settings, llm }: { settings: SystemSettingsResponse; llm: LlmKeysResponse }) {
  const queryClient = useQueryClient();
  const refreshLlm = useRefreshLlm();
  const [toDelete, setToDelete] = useState<LlmProviderKey | null>(null);

  const toggleKey = useMutation({
    mutationFn: ({ key, enabled }: { key: LlmProviderKey; enabled: boolean }) => updateLlmKey(key.id, { is_enabled: enabled }),
    onMutate: async ({ key, enabled }) => {
      await queryClient.cancelQueries({ queryKey: LLM_KEYS_KEY });
      const previous = patchLlmKeys(queryClient, (prev) => ({
        ...prev,
        keys: prev.keys.map((k) => (k.id === key.id ? { ...k, is_enabled: enabled } : k)),
      }));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.previous) queryClient.setQueryData(LLM_KEYS_KEY, ctx.previous);
      toast.error(errDetail(err, 'Update failed'));
    },
    onSuccess: () => void refreshLlm(),
  });

  const removeKey = useMutation({
    mutationFn: (key: LlmProviderKey) => deleteLlmKey(key.id),
    onSuccess: async (_d, key) => {
      await refreshLlm();
      toast.success(`Removed ${key.label}`);
    },
    onError: (err) => toast.error(errDetail(err, 'Delete failed')),
  });

  const otherSecrets = Object.entries(settings.secrets_presence ?? {}).filter(([k]) => !k.endsWith('_api_key'));
  const boundJobs = (key: LlmProviderKey) => llm.bindings.filter((b) => b.provider_key_id === key.id).map((b) => b.label);

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Register native provider keys for the pool. A key must pass validation before it can be saved. The gateway key in
        the server .env is never managed here.
      </p>
      <div className="grid gap-6 lg:grid-cols-3">
        {PROVIDERS.map((p) => {
          const keys = llm.keys.filter((k) => k.provider === p.id);
          const envReady = Boolean(settings.secrets_presence?.[`${p.id}_api_key`]);
          return (
            <SectionCard
              key={p.id}
              title={p.label}
              actions={<Badge variant={envReady ? 'secondary' : 'outline'}>{envReady ? '.env key ready' : 'No .env key'}</Badge>}
            >
              <div className="space-y-4">
                <div>
                  <p className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground">
                    Registered keys <span className="tabular-nums">{keys.length}</span>
                  </p>
                  {keys.length ? (
                    <ul className="divide-y rounded-lg border" aria-label={`${p.label} keys`}>
                      {keys.map((k) => (
                        <li key={k.id} className="flex items-center gap-2 px-3 py-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{k.label}</p>
                            <p className="font-mono text-xs text-muted-foreground">{k.key_hint || '••••'}</p>
                          </div>
                          <Switch
                            aria-label={`${k.label} enabled`}
                            checked={k.is_enabled}
                            disabled={toggleKey.isPending && toggleKey.variables?.key.id === k.id}
                            onCheckedChange={(enabled) => toggleKey.mutate({ key: k, enabled })}
                          />
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${k.label}`}
                            disabled={removeKey.isPending && removeKey.variables?.id === k.id}
                            onClick={() => setToDelete(k)}
                          >
                            <Trash2 />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">No keys registered yet.</p>
                  )}
                </div>
                <AddKeyForm provider={p.id} label={p.label} placeholder={p.placeholder} onSaved={refreshLlm} />
              </div>
            </SectionCard>
          );
        })}
      </div>

      {otherSecrets.length ? (
        <SectionCard title="Server secrets" description="Presence of other secrets configured in the server .env.">
          <ul className="flex flex-wrap gap-2" aria-label="Server secrets">
            {otherSecrets.map(([k, present]) => (
              <li key={k} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm">
                <span className="font-medium">{formatLabel(k)}</span>
                <span className={present ? 'text-status-ready' : 'text-muted-foreground'}>{present ? 'set' : 'missing'}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : null}

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete ${toDelete?.label ?? 'key'}?`}
        description={
          toDelete
            ? `The key is removed from the ${toDelete.provider} pool and can't be recovered.${
                boundJobs(toDelete).length ? ` Jobs bound to it (${boundJobs(toDelete).join(', ')}) fall back to the default key.` : ''
              }`
            : ''
        }
        confirmLabel="Delete key"
        destructive
        onConfirm={() => toDelete && removeKey.mutate(toDelete)}
      />
    </div>
  );
}

function AddKeyForm({
  provider,
  label,
  placeholder,
  onSaved,
}: {
  provider: LlmProvider;
  label: string;
  placeholder: string;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);

  const validate = useMutation({
    mutationFn: () => validateLlmKey({ provider, api_key: apiKey.trim() }),
    onSuccess: (res) => setTest({ ok: res.ok, message: res.message }),
    onError: (err) => setTest({ ok: false, message: errDetail(err, 'Validation failed') }),
  });
  const create = useMutation({
    mutationFn: () => createLlmKey({ provider, label: name.trim(), api_key: apiKey.trim() }),
    onSuccess: async () => {
      setName('');
      setApiKey('');
      setTest(null);
      await onSaved();
      toast.success(`${label} key saved`);
    },
    onError: (err) => toast.error(errDetail(err, 'Failed to save key')),
  });
  const busy = validate.isPending || create.isPending;

  return (
    <form
      className="space-y-3 rounded-lg border border-dashed p-3"
      aria-label={`Add ${label} key`}
      onSubmit={(e) => {
        e.preventDefault();
        if (test?.ok && name.trim() && apiKey.trim()) create.mutate();
      }}
    >
      <Field>
        <FieldLabel htmlFor={`new-key-label-${provider}`}>Label</FieldLabel>
        <Input
          id={`new-key-label-${provider}`}
          value={name}
          placeholder="e.g. analysis-prod"
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor={`new-key-secret-${provider}`}>{label} API key</FieldLabel>
        <Input
          id={`new-key-secret-${provider}`}
          type="password"
          autoComplete="off"
          className="font-mono"
          value={apiKey}
          placeholder={placeholder}
          onChange={(e) => {
            setApiKey(e.target.value);
            setTest(null);
          }}
        />
      </Field>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="flex-1"
          disabled={busy || !apiKey.trim()}
          onClick={() => validate.mutate()}
        >
          {validate.isPending ? <Loader2 className="animate-spin" /> : <Zap />}
          Validate
        </Button>
        <Button type="submit" size="sm" className="flex-1" disabled={busy || test?.ok !== true || !name.trim() || !apiKey.trim()}>
          {create.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Save key
        </Button>
      </div>
      <p
        className={cn('flex items-start gap-1.5 text-xs', test ? (test.ok ? 'text-status-ready' : 'text-destructive') : 'text-muted-foreground')}
        aria-live="polite"
      >
        {test ? test.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" /> : <AlertCircle className="mt-px size-3.5 shrink-0" /> : null}
        {test ? test.message : 'Validate the key before saving.'}
      </p>
    </form>
  );
}
