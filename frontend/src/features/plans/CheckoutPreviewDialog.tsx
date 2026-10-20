import { Lock } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  BASE_RATE_CENTS,
  type CreditPackage,
  formatCount,
  formatRate,
  formatUsd,
  savingsCents,
  totalCents,
} from './plansModel';

export function CheckoutPreviewDialog({ pkg, onClose }: { pkg: CreditPackage | null; onClose: () => void }) {
  return (
    <Dialog open={pkg !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        {pkg ? (
          <>
            <DialogHeader>
              <DialogTitle>Buy {pkg.name} credits</DialogTitle>
              <DialogDescription>One-time purchase. Credits are added to your balance and never expire.</DialogDescription>
            </DialogHeader>

            <dl className="divide-y divide-border/60 rounded-xl border border-border/60 bg-muted/30 text-sm">
              <Row label="Credits" value={formatCount(pkg.credits)} />
              <Row label="Price per job" value={formatRate(pkg.rateCents)} />
              {savingsCents(pkg) > 0 ? (
                <Row
                  label={`Saved vs ${formatRate(BASE_RATE_CENTS)} per job`}
                  value={`-${formatUsd(savingsCents(pkg))}`}
                  tone="text-status-ready"
                />
              ) : null}
              <Row label="Total" value={formatUsd(totalCents(pkg))} strong />
            </dl>

            <Alert>
              <Lock />
              <AlertTitle>Checkout opens soon</AlertTitle>
              <AlertDescription>
                Card payments through Stripe are being set up. Nothing has been charged.
              </AlertDescription>
            </Alert>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button disabled>Continue to payment</Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <dt className={strong ? 'font-semibold' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`tabular-nums ${strong ? 'text-base font-semibold' : 'font-medium'} ${tone ?? ''}`}>{value}</dd>
    </div>
  );
}
