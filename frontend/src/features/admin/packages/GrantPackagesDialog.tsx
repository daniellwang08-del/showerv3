import { useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, CircleSlash, Gift, Hourglass, Minus, Plus, UserRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { adminBulkGrant } from '@/api/storeApi';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import type { AdminUser } from '@/types/admin';
import type { BulkGrantResult, CatalogEntry, PackageCode } from '@/types/store';
import { extractApiErrorMessage } from '@/utils/profileErrors';
import {
  bundleTotals,
  CODE_TONE,
  fmt,
  MAX_QUANTITY,
  MAX_RECIPIENTS,
  packageSummary,
  parseRecipients,
  RECIPIENT_NOTE,
  recipientState,
  usd,
  type Bundle,
  type RecipientState,
} from './packagesModel';

const NOTE_MAX = 300;

export function GrantPackagesDialog({
  open,
  onOpenChange,
  catalog,
  users,
  initialRecipients,
  onGranted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  catalog: CatalogEntry[];
  users: AdminUser[];
  initialRecipients?: string[];
  onGranted: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        {open ? (
          <GrantForm
            key={(initialRecipients ?? []).join(',')}
            catalog={catalog}
            users={users}
            initialRecipients={initialRecipients ?? []}
            onClose={() => onOpenChange(false)}
            onGranted={onGranted}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function GrantForm({
  catalog,
  users,
  initialRecipients,
  onClose,
  onGranted,
}: {
  catalog: CatalogEntry[];
  users: AdminUser[];
  initialRecipients: string[];
  onClose: () => void;
  onGranted: () => void;
}) {
  const [recipients, setRecipients] = useState<string[]>(initialRecipients);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<string[]>([]);
  const [bundle, setBundle] = useState<Bundle>({});
  const [note, setNote] = useState('');
  const [result, setResult] = useState<BulkGrantResult | null>(null);

  const byEmail = useMemo(() => new Map(users.map((u) => [u.email.toLowerCase(), u])), [users]);
  const eligible = recipients.filter((e) => {
    const s = recipientState(e, byEmail);
    return s === 'account' || s === 'new';
  });
  const totals = bundleTotals(bundle, catalog, eligible.length);
  const tooMany = recipients.length > MAX_RECIPIENTS;
  const canSubmit = eligible.length > 0 && totals.perPerson.packages > 0 && !tooMany;

  const grant = useMutation({
    mutationFn: () =>
      adminBulkGrant({
        recipients: eligible,
        items: catalog
          .filter((c) => (bundle[c.code] ?? 0) > 0)
          .map((c) => ({ code: c.code, quantity: bundle[c.code] ?? 0 })),
        note: note.trim() || undefined,
      }),
    onSuccess: (res) => {
      setResult(res);
      onGranted();
      toast.success(
        `Granted ${fmt(res.total_packages)} package${res.total_packages === 1 ? '' : 's'} to ${fmt(res.granted.length)} ${res.granted.length === 1 ? 'person' : 'people'}`,
      );
    },
    onError: (err) => toast.error(extractApiErrorMessage(err, 'Could not grant the packages.')),
  });

  const addFromText = (text: string) => {
    const parsed = parseRecipients(text, recipients);
    if (parsed.emails.length) setRecipients((r) => [...r, ...parsed.emails]);
    setInvalid(parsed.invalid);
  };

  if (result) {
    return (
      <GrantResult
        result={result}
        onAgain={() => {
          setResult(null);
          setRecipients([]);
          setBundle({});
          setNote('');
        }}
        onClose={onClose}
      />
    );
  }

  return (
    <form
      className="flex max-h-[calc(100dvh-2rem)] flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !grant.isPending) grant.mutate();
      }}
    >
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle className="flex items-center gap-2">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <Gift className="size-4" />
          </span>
          Grant packages
        </DialogTitle>
        <DialogDescription>
          Packages land in each person's store right away. Emails without an account claim theirs at signup.
        </DialogDescription>
      </DialogHeader>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5">
        <section aria-labelledby="grant-recipients" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="grant-recipients" className="text-sm font-semibold">
              Recipients
            </h3>
            <span className={cn('text-xs tabular-nums', tooMany ? 'text-destructive' : 'text-muted-foreground')}>
              {fmt(recipients.length)} / {MAX_RECIPIENTS}
            </span>
          </div>
          <RecipientField
            recipients={recipients}
            draft={draft}
            setDraft={setDraft}
            users={users}
            byEmail={byEmail}
            onAdd={addFromText}
            onRemove={(email) => setRecipients((r) => r.filter((x) => x !== email))}
          />
          {invalid.length ? (
            <p role="alert" className="text-xs text-destructive">
              Not an email: {invalid.slice(0, 5).join(', ')}
              {invalid.length > 5 ? ` and ${invalid.length - 5} more` : ''}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Type a name or email, or paste a list separated by commas or new lines.
            </p>
          )}
        </section>

        <section aria-labelledby="grant-packages" className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <h3 id="grant-packages" className="text-sm font-semibold">
              Packages for each person
            </h3>
            {totals.perPerson.packages > 0 ? (
              <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setBundle({})}>
                Clear
              </button>
            ) : null}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {catalog.map((c) => (
              <PackageStepper
                key={c.code}
                entry={c}
                value={bundle[c.code] ?? 0}
                onChange={(q) => setBundle((b) => ({ ...b, [c.code]: q }))}
              />
            ))}
          </div>
        </section>

        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <label htmlFor="grant-note" className="text-sm font-semibold">
              Note to recipients <span className="font-normal text-muted-foreground">(optional)</span>
            </label>
            <span className="text-xs text-muted-foreground tabular-nums">
              {note.length}/{NOTE_MAX}
            </span>
          </div>
          <Textarea
            id="grant-note"
            rows={2}
            maxLength={NOTE_MAX}
            placeholder="Thanks for joining the beta. Here is a head start."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Shown on the package in their store.</p>
        </section>
      </div>

      <DialogFooter className="m-0 flex-col items-stretch gap-3 rounded-none border-t bg-muted/30 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {canSubmit ? (
            <>
              <span className="font-semibold text-foreground tabular-nums">{fmt(totals.all.packages)}</span> packages
              {' for '}
              <span className="font-semibold text-foreground tabular-nums">{fmt(eligible.length)}</span>
              {eligible.length === 1 ? ' person' : ' people'}
              {totals.all.credits ? ` · ${fmt(totals.all.credits)} credits` : ''}
              {totals.all.teams ? ` · ${fmt(totals.all.teams)} team space${totals.all.teams === 1 ? '' : 's'}` : ''}
              {` · ${usd(totals.all.cents)} value`}
            </>
          ) : eligible.length === 0 ? (
            'Add at least one person who can hold packages.'
          ) : (
            'Pick at least one package.'
          )}
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSubmit || grant.isPending}>
            <Gift />
            {grant.isPending
              ? 'Granting…'
              : canSubmit
                ? `Grant ${fmt(totals.all.packages)} package${totals.all.packages === 1 ? '' : 's'}`
                : 'Grant'}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

function RecipientField({
  recipients,
  draft,
  setDraft,
  users,
  byEmail,
  onAdd,
  onRemove,
}: {
  recipients: string[];
  draft: string;
  setDraft: (v: string) => void;
  users: AdminUser[];
  byEmail: Map<string, AdminUser>;
  onAdd: (text: string) => void;
  onRemove: (email: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(0);
  const term = draft.trim().toLowerCase();
  const chosen = new Set(recipients);
  const suggestions = term
    ? users
        .filter((u) => !u.is_admin && u.is_active && !chosen.has(u.email.toLowerCase()))
        .filter((u) => `${u.email} ${u.display_name ?? ''} ${u.name ?? ''}`.toLowerCase().includes(term))
        .slice(0, 6)
    : [];

  const pick = (email: string) => {
    onAdd(email);
    setDraft('');
    setActive(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length);
    } else if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && term.includes('@'))) {
      if (!term) return;
      e.preventDefault();
      pick(suggestions[active]?.email ?? draft);
    } else if (e.key === 'Backspace' && !draft && recipients.length) {
      onRemove(recipients[recipients.length - 1]);
    } else if (e.key === 'Escape' && draft) {
      e.stopPropagation();
      setDraft('');
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    if (/[\s,;]/.test(text.trim())) {
      e.preventDefault();
      onAdd(text);
    }
  };

  return (
    <div className="relative">
      <div
        className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
        onClick={() => inputRef.current?.focus()}
      >
        {recipients.map((email) => (
          <RecipientChip key={email} email={email} user={byEmail.get(email)} state={recipientState(email, byEmail)} onRemove={() => onRemove(email)} />
        ))}
        <input
          ref={inputRef}
          aria-label="Add recipients"
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls="grant-suggestions"
          aria-autocomplete="list"
          className="h-7 min-w-40 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          placeholder={recipients.length ? 'Add more…' : 'name or email@company.com'}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => {
            if (term.includes('@')) pick(draft);
          }}
        />
      </div>
      {suggestions.length > 0 && (
        <ul
          id="grant-suggestions"
          role="listbox"
          className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border bg-popover p-1 shadow-md"
        >
          {suggestions.map((u, i) => (
            <li
              key={u.id}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(u.email);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm', i === active && 'bg-accent')}
            >
              <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
              <span className="truncate font-medium">{u.display_name || u.name || u.email}</span>
              <span className="truncate text-xs text-muted-foreground">{u.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const CHIP_TONE: Record<RecipientState, string> = {
  account: 'border-border bg-muted/60',
  new: 'border-dashed border-status-preparing/50 bg-status-preparing/5',
  admin: 'border-destructive/40 bg-destructive/5 text-destructive line-through decoration-destructive/40',
  disabled: 'border-destructive/40 bg-destructive/5 text-destructive line-through decoration-destructive/40',
};

function RecipientChip({
  email,
  user,
  state,
  onRemove,
}: {
  email: string;
  user: AdminUser | undefined;
  state: RecipientState;
  onRemove: () => void;
}) {
  const Icon = state === 'new' ? Hourglass : state === 'account' ? UserRound : CircleSlash;
  const label = user?.display_name || user?.name || email;
  return (
    <span
      data-recipient={email}
      data-state={state}
      title={`${email}: ${RECIPIENT_NOTE[state]}`}
      className={cn('inline-flex h-7 max-w-full items-center gap-1 rounded-md border pr-0.5 pl-1.5 text-xs', CHIP_TONE[state])}
    >
      <Icon className={cn('size-3 shrink-0', state === 'new' && 'text-status-preparing')} aria-hidden />
      <span className="truncate">{label}</span>
      <span className="sr-only">{RECIPIENT_NOTE[state]}</span>
      <button
        type="button"
        aria-label={`Remove ${email}`}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="inline-flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-background hover:text-foreground"
      >
        <X className="size-3" />
      </button>
    </span>
  );
}

function PackageStepper({
  entry,
  value,
  onChange,
}: {
  entry: CatalogEntry;
  value: number;
  onChange: (q: number) => void;
}) {
  const tone = CODE_TONE[entry.code as PackageCode];
  const name = entry.kind === 'team' ? 'TEAM' : entry.name;
  const set = (q: number) => onChange(Math.max(0, Math.min(MAX_QUANTITY, q)));
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5 transition-colors',
        value > 0 && 'border-brand/50 bg-brand-soft/30 shadow-[inset_0_0_0_1px_var(--brand)]',
      )}
    >
      <button
        type="button"
        onClick={() => value === 0 && set(1)}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none"
        aria-label={value === 0 ? `Add ${name}` : `${name}: ${value} each`}
      >
        <span aria-hidden className={cn('inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold', tone.soft, tone.text)}>
          {entry.kind === 'team' ? 'T' : entry.name.slice(0, 1)}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-semibold">{name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {packageSummary(entry)} · {usd(entry.price_cents)}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`${name} quantity`}>
        <Button type="button" variant="outline" size="icon-xs" aria-label={`Fewer ${name}`} disabled={value === 0} onClick={() => set(value - 1)}>
          <Minus />
        </Button>
        <input
          aria-label={`${name} per person`}
          inputMode="numeric"
          className="h-7 w-8 rounded-md bg-transparent text-center text-sm font-semibold tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          value={value}
          onChange={(e) => {
            const n = Number(e.target.value.replace(/\D/g, '') || 0);
            set(n);
          }}
        />
        <Button type="button" variant="outline" size="icon-xs" aria-label={`More ${name}`} disabled={value >= MAX_QUANTITY} onClick={() => set(value + 1)}>
          <Plus />
        </Button>
      </div>
    </div>
  );
}

function GrantResult({ result, onAgain, onClose }: { result: BulkGrantResult; onAgain: () => void; onClose: () => void }) {
  const pending = result.granted.filter((g) => g.pending).length;
  return (
    <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
      <DialogHeader className="border-b px-5 pt-5 pb-4">
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle2 className="size-5 text-status-ready" />
          {`Granted ${fmt(result.total_packages)} package${result.total_packages === 1 ? '' : 's'}`}
        </DialogTitle>
        <DialogDescription>
          {`${fmt(result.granted.length)} ${result.granted.length === 1 ? 'person' : 'people'}`}
          {pending ? `, ${fmt(pending)} will claim theirs at signup` : ''}
          {result.skipped.length ? `. ${fmt(result.skipped.length)} skipped.` : '.'}
        </DialogDescription>
      </DialogHeader>
      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <ul aria-label="Granted" className="divide-y rounded-xl border">
          {result.granted.map((g) => (
            <li key={g.email} className="flex items-center gap-3 px-3 py-2 text-sm">
              {g.pending ? (
                <Hourglass className="size-4 shrink-0 text-status-preparing" aria-hidden />
              ) : (
                <CheckCircle2 className="size-4 shrink-0 text-status-ready" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{g.user?.name ?? g.email}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {g.user ? g.email : 'Claims at signup'}
                </span>
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {fmt(g.count)} package{g.count === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ul>
        {result.skipped.length ? (
          <div className="space-y-1.5">
            <h3 className="text-sm font-semibold">Skipped</h3>
            <ul aria-label="Skipped" className="divide-y rounded-xl border border-destructive/30 bg-destructive/5">
              {result.skipped.map((s) => (
                <li key={s.email} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="truncate">{s.email}</span>
                  <span className="shrink-0 text-xs text-destructive">{s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <DialogFooter className="m-0 rounded-none border-t bg-muted/30 px-5 py-4">
        <Button variant="outline" onClick={onAgain}>
          Grant more
        </Button>
        <Button onClick={onClose}>Done</Button>
      </DialogFooter>
    </div>
  );
}
