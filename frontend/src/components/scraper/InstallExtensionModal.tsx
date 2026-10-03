import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Rocket, Loader2, X, Copy, Check } from 'lucide-react';
import { Z_INDEX } from '../../constants/zIndex';
import { detectExtension } from '../../lib/extensionBridge';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called when a re-check confirms the extension is now installed. */
  onInstalled: () => void;
};

// Unpacked extension folder name inside the repo (load via chrome://extensions).
const EXTENSION_PATH = 'extension';

const STEPS: Array<{ title: string; body?: React.ReactNode }> = [
  { title: 'Open your browser\u2019s extensions page', body: <code className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-foreground">chrome://extensions</code> },
  { title: 'Turn on \u201CDeveloper mode\u201D', body: 'Use the toggle in the top-right corner of that page.' },
  { title: 'Click \u201CLoad unpacked\u201D' },
  { title: 'Select the project\u2019s extension folder', body: 'Use the extension directory from this NAO checkout.' },
  { title: 'Pin \u201CNAO\u201D and sign in with your account' },
];

export function InstallExtensionModal({ open, onClose, onInstalled }: Props) {
  const [checking, setChecking] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      setChecking(false);
      setNotFound(false);
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  const recheck = async () => {
    setChecking(true);
    setNotFound(false);
    const info = await detectExtension(1200, true);
    setChecking(false);
    if (info.installed) onInstalled();
    else setNotFound(true);
  };

  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(EXTENSION_PATH);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center bg-black/50 p-3 sm:p-4 backdrop-blur-sm"
      style={{ zIndex: Z_INDEX.confirmDialog }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="install-ext-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-popover text-popover-foreground shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-lg p-1.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="border-b border-border px-4 pb-3 pt-4 pr-12 sm:px-5 sm:pb-4 sm:pt-5">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand ring-1 ring-brand/30">
              <Rocket className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="install-ext-title" className="text-lg font-semibold text-foreground">
                Install the Job Application Assistant
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The assistant auto-fills applications with your tailored resume. It isn&rsquo;t on a store yet,
                so load it once as an unpacked extension.
              </p>
            </div>
          </div>
        </div>

        <div className="px-4 py-3 sm:px-5 sm:py-4">
          <ol className="space-y-3">
            {STEPS.map((step, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0 text-sm text-foreground">
                  <span className="font-medium text-foreground">{step.title}</span>
                  {step.body ? <div className="mt-1 break-words text-muted-foreground">{step.body}</div> : null}
                  {i === 3 ? (
                    <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-2">
                      <code className="min-w-0 max-w-full truncate rounded bg-muted px-2 py-1 text-[12px] text-foreground">{EXTENSION_PATH}</code>
                      <button
                        type="button"
                        onClick={copyPath}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:bg-muted/50"
                      >
                        {copied ? <Check className="h-3 w-3 text-status-ready" /> : <Copy className="h-3 w-3" />}
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>

          {notFound ? (
            <p className="mt-4 rounded-lg bg-status-preparing/10 px-3 py-2 text-sm font-medium text-foreground ring-1 ring-status-preparing/30">
              Still not detected. Open <code className="mx-1 rounded bg-status-preparing/10 px-1 py-0.5 text-[12px]">chrome://extensions</code>,
              click the reload (&#8635;) icon on &ldquo;Job Application Assistant&rdquo; to make sure it&rsquo;s enabled and
              loaded, then try again.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-border px-4 py-3 sm:flex-row sm:justify-end sm:px-5 sm:py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/50"
          >
            Close
          </button>
          <button
            type="button"
            disabled={checking}
            onClick={() => void recheck()}
            className="inline-flex items-center justify-center gap-2 rounded-xl border border-transparent bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90 disabled:opacity-60"
          >
            {checking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            I&rsquo;ve installed it
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
