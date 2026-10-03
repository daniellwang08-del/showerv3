import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { JobSiteConnection, JobSitePlugin } from '@/api/jobSitesApi';
import { IntegrationsPage } from './IntegrationsPage';

export function stubLayout() {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  Element.prototype.scrollTo = function scrollTo() {};
}

export function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <MemoryRouter initialEntries={['/app/integrations']}>
          <IntegrationsPage />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { qc, ...utils };
}

export function makePlugin(overrides: Partial<JobSitePlugin> = {}): JobSitePlugin {
  const slug = overrides.slug ?? 'remotive';
  return {
    slug,
    name: slug.charAt(0).toUpperCase() + slug.slice(1),
    blurb: `${slug} jobs`,
    homepage: `https://${slug}.example`,
    signup_url: null,
    login_url: null,
    auth_type: 'none',
    connectable: true,
    unavailable_reason: null,
    logo_src: `/integrations/job-sites/${slug}.svg`,
    sort_order: 0,
    credential_fields: [],
    session_capture: null,
    ...overrides,
  };
}

export function makeConnection(overrides: Partial<JobSiteConnection> = {}): JobSiteConnection {
  return {
    id: `conn-${overrides.plugin_slug ?? 'x'}`,
    plugin_slug: 'x',
    enabled: true,
    last_synced_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    last_error: null,
    last_listing_count: 120,
    last_new_jobs: 4,
    credential_hints: {},
    created_at: null,
    ...overrides,
  };
}
