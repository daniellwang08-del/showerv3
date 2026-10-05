import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, PlugZap, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { connectExtensionSession, detectExtension } from '@/lib/extensionBridge';

type Phase = 'connecting' | 'connected' | 'no_extension' | 'failed';

/**
 * Opened from the extension's sign-in screen. The user signs in here, where
 * the browser's password manager works, and the extension receives its own
 * session through the content-script bridge.
 */
export function ExtensionConnectPage({ email }: { email?: string }) {
  const [phase, setPhase] = useState<Phase>('connecting');
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const connect = useCallback(async () => {
    setPhase('connecting');
    setError(null);
    const info = await detectExtension(1500, true);
    if (!info.installed) {
      setPhase('no_extension');
      return;
    }
    const res = await connectExtensionSession();
    if (res.ok) {
      setPhase('connected');
    } else {
      setError(res.error || 'The extension did not accept the sign-in.');
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void connect();
  }, [connect]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4">
      <section className="w-full max-w-sm space-y-4 rounded-2xl border bg-card p-6 text-center shadow-sm" aria-live="polite">
        {phase === 'connecting' && (
          <>
            <Loader2 className="mx-auto size-8 animate-spin text-brand" aria-hidden />
            <h1 className="text-lg font-semibold">Connecting the NAO extension</h1>
            <p className="text-sm text-muted-foreground">Signing the extension in as {email || 'you'}.</p>
          </>
        )}
        {phase === 'connected' && (
          <>
            <CheckCircle2 className="mx-auto size-8 text-status-ready" aria-hidden />
            <h1 className="text-lg font-semibold">Extension signed in</h1>
            <p className="text-sm text-muted-foreground">
              The NAO side panel is now signed in as {email || 'you'}. You can close this tab.
            </p>
            <Button variant="outline" onClick={() => window.close()}>
              Close tab
            </Button>
          </>
        )}
        {phase === 'no_extension' && (
          <>
            <PlugZap className="mx-auto size-8 text-muted-foreground" aria-hidden />
            <h1 className="text-lg font-semibold">Extension not found</h1>
            <p className="text-sm text-muted-foreground">
              Make sure the NAO extension is installed and enabled in this browser, then try again.
            </p>
            <Button onClick={() => void connect()}>Try again</Button>
          </>
        )}
        {phase === 'failed' && (
          <>
            <XCircle className="mx-auto size-8 text-destructive" aria-hidden />
            <h1 className="text-lg font-semibold">Could not sign the extension in</h1>
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button onClick={() => void connect()}>Try again</Button>
          </>
        )}
      </section>
    </main>
  );
}
