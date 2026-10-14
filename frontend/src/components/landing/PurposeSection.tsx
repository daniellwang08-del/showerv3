import { Link } from 'react-router-dom';
import { ShieldCheck, Sparkles, Mail } from 'lucide-react';
import { LANDING_CONTAINER, SectionHeading, SectionShell, SurfaceCard } from './landingUi';

/**
 * Explicit product-purpose block for humans and OAuth / branding reviewers.
 * Kept high on the page so the home page explains what NAO is without login.
 */
export function PurposeSection() {
  return (
    <SectionShell id="about" className="bg-[#04060F]">
      <div className={LANDING_CONTAINER}>
        <div className="landing-reveal">
          <SectionHeading
            align="left"
            eyebrow="About NAO"
            title={
              <>
                What <span className="text-[#9DB9FF]">NAO</span> is for
              </>
            }
            subtitle="NAO is an AI job application workspace. It helps job seekers source openings, score fit, tailor documents, and autofill applications they choose to send. It is not a social network, not an image generator, and not a bulk email sender."
          />
        </div>

        <div className="landing-reveal mt-10 grid gap-4 lg:grid-cols-3">
          <SurfaceCard>
            <div className="flex size-10 items-center justify-center rounded-xl border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]">
              <Sparkles size={18} strokeWidth={2.5} />
            </div>
            <h3 className="mt-4 text-base font-bold text-white">Core purpose</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/65">
              Find roles across job networks, read the real posting, score it against your profile, write a
              tailored résumé and cover letter, then help you fill ATS forms in your browser. You keep the
              final submit click.
            </p>
          </SurfaceCard>

          <SurfaceCard>
            <div className="flex size-10 items-center justify-center rounded-xl border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]">
              <Mail size={18} strokeWidth={2.5} />
            </div>
            <h3 className="mt-4 text-base font-bold text-white">Optional Gmail access</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/65">
              If you connect Gmail, NAO requests <span className="text-white">read-only</span> permission so
              you can search your own inbox for recruiter and interview mail. NAO does not send, delete, or
              modify messages. You can disconnect anytime.
            </p>
          </SurfaceCard>

          <SurfaceCard>
            <div className="flex size-10 items-center justify-center rounded-xl border border-[#6F9BFF]/25 bg-[#3D74FF]/10 text-[#9DB9FF]">
              <ShieldCheck size={18} strokeWidth={2.5} />
            </div>
            <h3 className="mt-4 text-base font-bold text-white">Responsible use</h3>
            <p className="mt-2 text-sm leading-relaxed text-white/65">
              NAO complies with the Google API Services User Data Policy, including Limited Use. The product
              is not used for AI-generated non-consensual intimate imagery (AI NCII) or similar prohibited
              purposes. See our{' '}
              <Link to="/privacy-policy" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
                Privacy Policy
              </Link>{' '}
              and{' '}
              <Link to="/terms" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
                Terms
              </Link>
              .
            </p>
          </SurfaceCard>
        </div>
      </div>
    </SectionShell>
  );
}
