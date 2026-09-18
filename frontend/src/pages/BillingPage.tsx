import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertCircle, CheckCircle2, CreditCard, Loader2, Sparkles, X } from 'lucide-react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  EmbeddedCheckout,
  EmbeddedCheckoutProvider,
} from '@stripe/react-stripe-js';
import { PageHeader } from '../components/layout/PageHeader';
import { PageScrollArea } from '../components/layout/PageScrollArea';
import {
  createCheckoutSession,
  fetchBillingPlans,
  openBillingPortal,
  type BillingPlan,
  type BillingPlansResponse,
  type PlanSlug,
  type SubscriptionState,
} from '../api/billingApi';

// Cache the Stripe.js loader per publishable key so we call loadStripe once,
// not on every render. The key only becomes known after /billing/plans returns.
let stripeCache: { key: string; promise: Promise<Stripe | null> } | null = null;
function getStripe(publishableKey: string): Promise<Stripe | null> {
  if (!stripeCache || stripeCache.key !== publishableKey) {
    stripeCache = { key: publishableKey, promise: loadStripe(publishableKey) };
  }
  return stripeCache.promise;
}
import {
  brandChipGradient,
  btnPrimary,
  btnSecondary,
  card,
  headingText,
  mutedText,
  pagePad,
} from '../ui/tokens';

function errorDetail(err: unknown, fallback: string): string {
  const detail =
    err && typeof err === 'object' && 'response' in err
      ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
      : null;
  return typeof detail === 'string' ? detail : fallback;
}

function formatPeriodEnd(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

const STATUS_COPY: Record<string, string> = {
  active: 'Active',
  trialing: 'Trial',
  past_due: 'Past due',
  canceled: 'Canceled',
  incomplete: 'Incomplete',
  incomplete_expired: 'Expired',
  unpaid: 'Unpaid',
  paused: 'Paused',
};

function CurrentPlanBanner({
  subscription,
  onManage,
  managing,
}: {
  subscription: SubscriptionState;
  onManage: () => void;
  managing: boolean;
}) {
  const periodEnd = formatPeriodEnd(subscription.current_period_end);
  const statusLabel = subscription.status ? STATUS_COPY[subscription.status] ?? subscription.status : null;
  return (
    <section className={`p-4 sm:p-5 ${card}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${brandChipGradient} text-white shadow-sm`}
          >
            <CheckCircle2 size={20} />
          </div>
          <div className="min-w-0">
            <h2 className={`text-sm font-bold ${headingText}`}>
              {subscription.plan_name ? `${subscription.plan_name} plan` : 'Your subscription'}
              {statusLabel ? (
                <span
                  className={`ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                    subscription.is_active
                      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                      : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                  }`}
                >
                  {statusLabel}
                </span>
              ) : null}
            </h2>
            <p className={`mt-1 text-xs ${mutedText}`}>
              {subscription.cancel_at_period_end && periodEnd
                ? `Cancels on ${periodEnd}. You keep access until then.`
                : periodEnd
                  ? `Renews on ${periodEnd}.`
                  : 'Manage your plan, payment method, or invoices in the billing portal.'}
            </p>
          </div>
        </div>
        <button type="button" className={btnSecondary} onClick={onManage} disabled={managing}>
          {managing ? <Loader2 size={16} className="animate-spin" /> : <CreditCard size={16} />}
          Manage billing
        </button>
      </div>
    </section>
  );
}

function PlanCard({
  plan,
  highlighted,
  currentActive,
  busy,
  disabled,
  onSubscribe,
}: {
  plan: BillingPlan;
  highlighted: boolean;
  currentActive: boolean;
  busy: boolean;
  disabled: boolean;
  onSubscribe: (slug: PlanSlug) => void;
}) {
  return (
    <section
      className={`relative flex flex-col p-5 ${card} ${
        highlighted ? 'ring-2 ring-sky-400 dark:ring-sky-500/60' : ''
      }`}
    >
      {highlighted ? (
        <span
          className={`absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-gradient-to-r ${brandChipGradient} px-2.5 py-0.5 text-[11px] font-semibold text-white shadow-sm`}
        >
          <Sparkles size={11} /> Best value
        </span>
      ) : null}
      <h3 className={`text-base font-bold ${headingText}`}>{plan.name}</h3>
      <div className="mt-2 flex items-baseline gap-1">
        <span className={`text-3xl font-extrabold tracking-tight ${headingText}`}>
          {plan.amount_display}
        </span>
        <span className={`text-xs font-medium ${mutedText}`}>{plan.period_label}</span>
      </div>
      <p className={`mt-2 text-xs leading-snug ${mutedText}`}>{plan.tagline}</p>

      <div className="mt-4 flex-1" />

      <button
        type="button"
        className={btnPrimary}
        disabled={busy || disabled || !plan.available || currentActive}
        onClick={() => onSubscribe(plan.slug)}
      >
        {busy ? <Loader2 size={16} className="animate-spin" /> : null}
        {currentActive ? 'Current plan' : !plan.available ? 'Unavailable' : 'Subscribe'}
      </button>
      {!plan.available ? (
        <p className={`mt-2 text-[11px] ${mutedText}`}>Not yet configured by the administrator.</p>
      ) : null}
    </section>
  );
}

function EmbeddedCheckoutPanel({
  publishableKey,
  plan,
  planName,
  onClose,
}: {
  publishableKey: string;
  plan: PlanSlug;
  planName: string;
  onClose: () => void;
}) {
  const stripePromise = useMemo(() => getStripe(publishableKey), [publishableKey]);
  // A fresh secret per plan; remounting the provider (via key={plan}) reruns this.
  const fetchClientSecret = useCallback(
    () => createCheckoutSession(plan).then((res) => res.client_secret),
    [plan],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`Subscribe to the ${planName} plan`}
    >
      <div className={`relative my-6 w-full max-w-xl ${card} p-4 sm:p-5`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className={`text-sm font-bold ${headingText}`}>
            Subscribe — {planName} plan
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close checkout"
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg ${mutedText} hover:bg-slate-100 dark:hover:bg-slate-800`}
          >
            <X size={16} />
          </button>
        </div>
        <EmbeddedCheckoutProvider
          key={plan}
          stripe={stripePromise}
          options={{ fetchClientSecret }}
        >
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </div>
  );
}

export function BillingPage() {
  const [data, setData] = useState<BillingPlansResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [checkoutPlan, setCheckoutPlan] = useState<PlanSlug | null>(null);
  const [managing, setManaging] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchBillingPlans();
      setData(res);
      setError('');
    } catch (err) {
      setError(errorDetail(err, 'Could not load subscription plans.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Surface the Stripe redirect result, then strip the query so a refresh is clean.
  const checkoutStatus = searchParams.get('status');
  useEffect(() => {
    if (checkoutStatus === 'success' || checkoutStatus === 'cancelled') {
      const next = new URLSearchParams(searchParams);
      next.delete('status');
      next.delete('session_id');
      setSearchParams(next, { replace: true });
      // Stripe redirects back before the webhook may have landed; refetch shortly.
      if (checkoutStatus === 'success') {
        const t = setTimeout(() => void load(), 1500);
        return () => clearTimeout(t);
      }
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkoutStatus]);

  const subscription = data?.subscription ?? null;
  const activePlanSlug = subscription?.is_active ? subscription.plan : null;

  const handleSubscribe = useCallback(
    (slug: PlanSlug) => {
      setError('');
      if (!data?.publishable_key) {
        setError('Billing is not fully configured yet. Please try again later.');
        return;
      }
      setCheckoutPlan(slug);
    },
    [data?.publishable_key],
  );

  const handleManage = useCallback(async () => {
    setError('');
    setManaging(true);
    try {
      const url = await openBillingPortal();
      window.location.assign(url);
    } catch (err) {
      setError(errorDetail(err, 'Could not open the billing portal.'));
      setManaging(false);
    }
  }, []);

  const highlightSlug = useMemo<PlanSlug>(() => 'yearly', []);

  return (
    <PageScrollArea>
      <div className={pagePad}>
        <PageHeader
          icon={CreditCard}
          title="Subscription"
          description="Choose a plan to unlock Atomspace. Payments are handled securely by Stripe — cancel or change anytime."
        />

        {checkoutStatus === 'success' ? (
          <div className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-400/30 dark:bg-emerald-500/10 dark:text-emerald-200">
            <CheckCircle2 size={16} className="shrink-0" />
            Payment received. Your subscription is being activated…
          </div>
        ) : null}
        {checkoutStatus === 'cancelled' ? (
          <div className="flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-400/30 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertCircle size={16} className="shrink-0" />
            Checkout cancelled. You have not been charged.
          </div>
        ) : null}
        {error ? (
          <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-400/30 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertCircle size={16} className="shrink-0" />
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className={`flex items-center justify-center gap-2 p-10 ${mutedText}`}>
            <Loader2 size={18} className="animate-spin" /> Loading plans…
          </div>
        ) : data && !data.configured ? (
          <section className={`p-5 ${card}`}>
            <h2 className={`text-sm font-bold ${headingText}`}>Billing is not available yet</h2>
            <p className={`mt-1 text-xs ${mutedText}`}>
              Subscriptions have not been configured on this server. Please check back soon.
            </p>
          </section>
        ) : (
          <>
            {subscription ? (
              <CurrentPlanBanner
                subscription={subscription}
                onManage={handleManage}
                managing={managing}
              />
            ) : null}

            <div className="grid items-stretch gap-3 sm:gap-4 lg:grid-cols-3">
              {(data?.plans ?? []).map((plan) => (
                <PlanCard
                  key={plan.slug}
                  plan={plan}
                  highlighted={plan.slug === highlightSlug}
                  currentActive={activePlanSlug === plan.slug}
                  busy={false}
                  disabled={checkoutPlan !== null}
                  onSubscribe={handleSubscribe}
                />
              ))}
            </div>

            <p className={`text-[11px] ${mutedText}`}>
              Prices are in USD. By subscribing you agree to recurring billing until you cancel.
              Manage or cancel anytime from the billing portal.
            </p>
          </>
        )}
      </div>

      {checkoutPlan && data?.publishable_key ? (
        <EmbeddedCheckoutPanel
          publishableKey={data.publishable_key}
          plan={checkoutPlan}
          planName={data.plans.find((p) => p.slug === checkoutPlan)?.name ?? 'Selected'}
          onClose={() => setCheckoutPlan(null)}
        />
      ) : null}
    </PageScrollArea>
  );
}
