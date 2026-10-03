import { useState } from 'react';
import { CheckCircle2, Eye, EyeOff, Loader2, XCircle, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { SectionCard } from '@/components/app/PageLayout';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '@/components/ui/input-group';
import { cn } from '@/lib/utils';
import {
  saveOpenAiSettings,
  saveProviderKeySettings,
  testOpenAiKey,
  testProviderKey,
} from '@/api/settingsApi';
import type { SettingsMode, UserSettings } from '@/types/settings';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import { ModeToggle } from './controls';
import { useSetSettings } from './queries';

type ProviderId = 'openai' | 'anthropic' | 'gemini';

const PROVIDERS: { id: ProviderId; label: string; placeholder: string; docs: string; blurb: string }[] = [
  { id: 'openai', label: 'OpenAI', placeholder: 'sk-…', docs: 'platform.openai.com', blurb: 'GPT models.' },
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    docs: 'console.anthropic.com',
    blurb: 'Claude models, used as the selected provider or a fallback.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    placeholder: 'AIza…',
    docs: 'aistudio.google.com',
    blurb: 'Google Gemini models, used as the selected provider or a fallback.',
  },
];

function testKey(provider: ProviderId, apiKey?: string) {
  return provider === 'openai' ? testOpenAiKey(apiKey) : testProviderKey(provider, apiKey);
}

function saveKey(provider: ProviderId, mode: SettingsMode, apiKey: string | undefined) {
  if (provider === 'openai') {
    return mode === 'default'
      ? saveOpenAiSettings({ openai_key_mode: 'default', clear_openai_api_key: true })
      : saveOpenAiSettings({ openai_key_mode: 'custom', ...(apiKey ? { openai_api_key: apiKey } : {}) });
  }
  return saveProviderKeySettings(
    provider,
    mode === 'default' ? { mode: 'default', clear: true } : { mode: 'custom', apiKey },
  );
}

const maskHint = (hint: string) => `••••${hint.slice(-4)}`;

export function AiKeysTab({ settings }: { settings: UserSettings }) {
  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Bring your own provider keys to override the NAO defaults for AI features. Keys are stored encrypted and
        saved per provider.
      </p>
      {PROVIDERS.map((p) => {
        const mode = settings[`${p.id}_key_mode`];
        const configured = settings[`${p.id}_key_configured`];
        const hint = settings[`${p.id}_key_hint`];
        return <ProviderCard key={`${p.id}-${mode}-${configured}-${hint}`} provider={p} settings={settings} />;
      })}
    </div>
  );
}

function ProviderCard({ provider, settings }: { provider: (typeof PROVIDERS)[number]; settings: UserSettings }) {
  const setSettings = useSetSettings();
  const id = provider.id;
  const savedMode = settings[`${id}_key_mode`];
  const configured = settings[`${id}_key_configured`];
  const hint = settings[`${id}_key_hint`];
  const systemAvailable = settings[`system_${id}_available`];

  const [mode, setMode] = useState<SettingsMode>(savedMode);
  const [keyInput, setKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const newKey = keyInput.trim();
  const usingCustom = savedMode === 'custom' && configured;
  const saveEnabled =
    mode === 'default' ? savedMode !== 'default' : test?.ok === true && (newKey.length > 0 || savedMode !== 'custom');

  const status = usingCustom ? (
    <Badge variant="secondary">Your key {hint ? maskHint(hint) : ''}</Badge>
  ) : savedMode === 'custom' ? (
    <Badge variant="outline">No key saved</Badge>
  ) : systemAvailable ? (
    <Badge variant="outline">Using NAO default</Badge>
  ) : (
    <Badge variant="destructive">Default unavailable</Badge>
  );

  const handleTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await testKey(id, newKey || undefined));
    } catch (err) {
      setTest({ ok: false, message: extractApiErrorMessage(err, 'Key test failed.') });
    } finally {
      setTesting(false);
    }
  };

  const doSave = async () => {
    setSaving(true);
    try {
      const data = await saveKey(id, mode, newKey || undefined);
      toast.success(
        mode === 'default' ? `Using the NAO default ${provider.label} key.` : `Your ${provider.label} key was saved.`,
      );
      setSettings(data);
    } catch (err) {
      toast.error(extractApiErrorMessage(err, `Failed to save ${provider.label} key.`));
    } finally {
      setSaving(false);
    }
  };

  const handleSave = () => {
    if (mode === 'default' && configured) setConfirmOpen(true);
    else void doSave();
  };

  return (
    <SectionCard
      title={provider.label}
      description={`${provider.blurb} Get a key at ${provider.docs}.`}
      actions={status}
    >
      <div className="space-y-4">
        <ModeToggle
          label={`${provider.label} key mode`}
          value={mode}
          disabled={saving || testing}
          onChange={(next) => {
            setMode(next);
            setTest(null);
          }}
        />

        {mode === 'default' ? (
          <p className="text-sm text-muted-foreground">
            {systemAvailable
              ? `Uses the NAO default ${provider.label} key.`
              : `No NAO default ${provider.label} key is configured. Switch to Custom to add your own.`}
          </p>
        ) : (
          <Field>
            <FieldLabel htmlFor={`${id}-api-key`}>
              {configured ? `New ${provider.label} API key` : `${provider.label} API key`}
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={`${id}-api-key`}
                type={showKey ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                placeholder={provider.placeholder}
                value={keyInput}
                disabled={saving}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  setTest(null);
                }}
                className="font-mono"
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  size="icon-xs"
                  aria-label={showKey ? 'Hide key' : 'Show key'}
                  onClick={() => setShowKey((v) => !v)}
                >
                  {showKey ? <EyeOff /> : <Eye />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            {configured && hint && !newKey ? (
              <FieldDescription>
                Saved key <code className="font-mono tabular-nums">{maskHint(hint)}</code>. Enter a new key to replace
                it, or test the saved key.
              </FieldDescription>
            ) : null}
          </Field>
        )}

        {mode === 'custom' && test ? (
          <p
            role="status"
            className={cn('flex items-center gap-1.5 text-sm', test.ok ? 'text-match-strong' : 'text-destructive')}
          >
            {test.ok ? <CheckCircle2 className="size-4" /> : <XCircle className="size-4" />}
            {test.message || (test.ok ? 'Key works.' : 'Key test failed.')}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {mode === 'custom' ? (
            <Button
              variant="outline"
              size="sm"
              disabled={testing || saving || (!newKey && !configured)}
              onClick={() => void handleTest()}
            >
              {testing ? <Loader2 className="animate-spin" /> : <Zap />}
              Test key
            </Button>
          ) : null}
          <Button size="sm" disabled={!saveEnabled || saving} onClick={handleSave}>
            {saving ? <Loader2 className="animate-spin" /> : null}
            {mode === 'default' ? 'Use NAO default' : 'Save key'}
          </Button>
          {mode === 'custom' && test?.ok !== true ? (
            <span className="text-xs text-muted-foreground">
              Test your key to enable saving{newKey || !configured ? '' : ' (or test the saved key)'}.
            </span>
          ) : null}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove your {provider.label} key?</AlertDialogTitle>
            <AlertDialogDescription>
              Switching to the NAO default deletes your saved {provider.label} key. You can add it again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                void doSave();
              }}
            >
              Remove key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}
