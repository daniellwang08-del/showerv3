import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PrivacyPolicyPage } from './PrivacyPolicyPage';
import { TermsOfServicePage } from './TermsOfServicePage';
import { PurposeSection } from '../components/landing/PurposeSection';

vi.mock('../hooks/usePublicViewport', () => ({ usePublicViewport: () => undefined }));

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.scrollTo = () => undefined;
});

describe('public legal and home pages', () => {
  it('renders a substantial Privacy Policy with Google Limited Use language', () => {
    render(
      <MemoryRouter>
        <PrivacyPolicyPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
    expect(screen.getByText(/Google API Services User Data Policy/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Limited Use/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/gmail\.readonly/i)).toBeInTheDocument();
    expect(screen.getAllByText(/nao\.it\.com/i).length).toBeGreaterThan(0);
  });

  it('renders Terms with AI NCII prohibition and product purpose', () => {
    render(
      <MemoryRouter>
        <TermsOfServicePage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Terms of Service' })).toBeInTheDocument();
    expect(screen.getAllByText(/AI NCII/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/job application workspace/i).length).toBeGreaterThan(0);
  });

  it('explains NAO purpose and links to legal pages without login', () => {
    render(
      <MemoryRouter>
        <PurposeSection />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /What NAO is for/i })).toBeInTheDocument();
    expect(screen.getByText(/read-only/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy-policy');
    expect(screen.getByRole('link', { name: 'Terms' })).toHaveAttribute('href', '/terms');
  });

  it('exposes privacy and terms routes in a public router', () => {
    render(
      <MemoryRouter initialEntries={['/privacy-policy']}>
        <Routes>
          <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
          <Route path="/terms" element={<TermsOfServicePage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Privacy Policy' })).toBeInTheDocument();
  });
});
