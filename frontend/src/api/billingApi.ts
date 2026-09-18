import { apiClient } from './client';

export type PlanSlug = 'monthly' | 'quarterly' | 'yearly';

export interface BillingPlan {
  slug: PlanSlug;
  name: string;
  tagline: string;
  amount_cents: number;
  amount_display: string;
  currency: string;
  interval: 'month' | 'year';
  interval_count: number;
  period_label: string;
  /** True only when an admin has wired a Stripe Price id for this plan. */
  available: boolean;
}

export interface SubscriptionState {
  plan: string | null;
  plan_name: string | null;
  status: string | null;
  is_active: boolean;
  cancel_at_period_end: boolean;
  current_period_end: string | null;
}

export interface BillingPlansResponse {
  configured: boolean;
  publishable_key: string | null;
  plans: BillingPlan[];
  subscription: SubscriptionState | null;
}

export async function fetchBillingPlans(): Promise<BillingPlansResponse> {
  const { data } = await apiClient.get<BillingPlansResponse>('/billing/plans');
  return data;
}

export async function fetchSubscription(): Promise<{
  subscription: SubscriptionState | null;
  is_active: boolean;
}> {
  const { data } = await apiClient.get('/billing/subscription');
  return data;
}

export interface CheckoutSession {
  /** Client secret used to mount Stripe's embedded checkout form in-page. */
  client_secret: string;
  session_id: string | null;
}

/** Create an embedded Checkout Session for a plan; returns its client secret. */
export async function createCheckoutSession(plan: PlanSlug): Promise<CheckoutSession> {
  const { data } = await apiClient.post<CheckoutSession>('/billing/checkout', { plan });
  return data;
}

/** Open the Stripe Customer Portal (manage/cancel/update payment). */
export async function openBillingPortal(): Promise<string> {
  const { data } = await apiClient.post<{ url: string }>('/billing/portal', {});
  return data.url;
}
