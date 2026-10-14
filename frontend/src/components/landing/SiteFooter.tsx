import { Link } from 'react-router-dom';
import { NaoWordmark } from '@/components/brand/NaoLogo';
import { NAV_LINKS } from './landingData';
import { LANDING_CONTAINER } from './landingUi';

const LEGAL_LINKS = [
  { to: '/privacy-policy', label: 'Privacy Policy' },
  { to: '/terms', label: 'Terms of Service' },
] as const;

/** Shared footer for the public marketing site and legal pages. */
export function SiteFooter({ showSectionLinks = true }: { showSectionLinks?: boolean }) {
  return (
    <footer className="border-t border-white/10 bg-[#04060F]">
      <div className={`${LANDING_CONTAINER} flex flex-col gap-10 py-14 sm:flex-row sm:items-start sm:justify-between`}>
        <div>
          <Link to="/" className="inline-flex text-white" aria-label="NAO home">
            <NaoWordmark className="h-5 text-white" />
          </Link>
          <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-white/55">
            NAO is an AI job application workspace. It helps people source roles, score fit, tailor
            résumés and cover letters, and autofill applications they choose to submit.
          </p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-6 gap-y-3" aria-label="Footer">
          {showSectionLinks
            ? NAV_LINKS.map((link) => (
                <Link
                  key={link.id}
                  to={`/#${link.id}`}
                  className="text-[13px] font-semibold text-white/60 transition hover:text-white"
                >
                  {link.label}
                </Link>
              ))
            : null}
          {LEGAL_LINKS.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              className="text-[13px] font-semibold text-white/60 transition hover:text-white"
            >
              {link.label}
            </Link>
          ))}
          <Link to="/login" className="text-[13px] font-semibold text-white/60 transition hover:text-white">
            Sign in
          </Link>
          <Link to="/signup" className="text-[13px] font-bold text-[#6F9BFF] transition hover:text-[#BFD6FF]">
            Sign up
          </Link>
        </nav>
      </div>

      <div className={`${LANDING_CONTAINER} border-t border-white/5 py-6`}>
        <p className="text-[12px] font-semibold text-white/50">
          © {new Date().getFullYear()} NAO. All rights reserved. Operated at{' '}
          <a href="https://nao.it.com" className="text-white/70 underline-offset-2 hover:underline">
            nao.it.com
          </a>
          .
        </p>
      </div>
    </footer>
  );
}
