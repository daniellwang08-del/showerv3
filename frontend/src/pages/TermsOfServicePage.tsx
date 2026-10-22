import { Link } from 'react-router-dom';
import { LegalList, LegalPageShell, LegalSection } from '@/components/landing/LegalPageShell';

const UPDATED = 'October 13, 2026';
const CONTACT_EMAIL = 'support@nao.it.com';

/** Public Terms of Service at /terms (always reachable without login). */
export function TermsOfServicePage() {
  return (
    <LegalPageShell
      title="Terms of Service"
      description="The rules for using NAO, the AI job application workspace at nao.it.com."
      updated={UPDATED}
    >
      <LegalSection title="1. Agreement">
        <p>
          These Terms of Service (&quot;Terms&quot;) govern access to and use of{' '}
          <strong className="text-white">NAO</strong> at{' '}
          <a href="https://nao.it.com" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            https://nao.it.com
          </a>{' '}
          and related browser extensions (the &quot;Service&quot;). By creating an account or using NAO,
          you agree to these Terms and our{' '}
          <Link to="/privacy-policy" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="2. What NAO is">
        <p>
          NAO is a software workspace that helps individuals manage job search workflows: discovering
          roles, scoring fit against a user-supplied profile, generating tailored résumé and cover-letter
          content, and assisting with form autofill in the user&apos;s browser. Optional integrations may
          include posting job links to destinations you configure and read-only search of a Gmail inbox you
          authorize.
        </p>
        <p>
          NAO does not guarantee interviews, offers, or employment outcomes. You remain responsible for the
          accuracy of materials you submit to employers and for the final decision to apply.
        </p>
      </LegalSection>

      <LegalSection title="3. Eligibility and accounts">
        <LegalList
          items={[
            'You must be legally able to enter a binding agreement and of working age in your jurisdiction.',
            'You must provide accurate account information and keep credentials confidential.',
            'Anyone can create an account. New accounts receive free starter credits once; creating extra accounts to collect more credits is not allowed.',
            "You may not share your account or use another person's account without permission.",
          ]}
        />
      </LegalSection>

      <LegalSection title="4. Acceptable use">
        <p>You agree not to:</p>
        <LegalList
          items={[
            'Use NAO for any unlawful purpose, fraud, or misrepresentation to employers.',
            'Attempt to access systems, data, or accounts you are not authorized to use.',
            'Reverse engineer, abuse rate limits, disrupt the Service, or bypass security controls.',
            'Upload malware or content you do not have rights to use.',
            'Use the Service to generate or distribute AI-generated non-consensual intimate imagery (AI NCII) or other sexual exploitation content.',
            'Use Google APIs or other connected services in ways that violate their terms or Google’s API Services User Data Policy.',
            'Resell or provide the Service to third parties as a competing hosted product without written permission.',
          ]}
        />
      </LegalSection>

      <LegalSection title="5. Your content and license">
        <p>
          You retain ownership of the profile content, documents, and materials you provide. You grant NAO a
          limited license to host, process, and display that content solely to operate the Service for you
          (including sending necessary prompts to AI providers you or the platform configure).
        </p>
      </LegalSection>

      <LegalSection title="6. Third-party services">
        <p>
          NAO may integrate with third parties such as job boards, ATS sites, Google (Sheets service account
          posting and optional Gmail read-only OAuth), chat tools, AI model providers, and payment
          processors. Their terms and privacy policies apply to your use of those services. NAO is not
          responsible for third-party sites or outages.
        </p>
      </LegalSection>

      <LegalSection title="7. Autofill and applications">
        <p>
          Autofill assistance runs in your browser under your control. You are responsible for reviewing
          every application before submission. NAO does not silently submit applications without your
          action.
        </p>
      </LegalSection>

      <LegalSection title="8. Credits and fees">
        <p>
          Some features use prepaid credits. Credit prices and package sizes are presented before purchase.
          Purchases are one-time, there is no recurring charge. Unless required by law, purchased credits are
          non-refundable once used. Features that need credits are unavailable while your balance is empty.
        </p>
      </LegalSection>

      <LegalSection title="9. Intellectual property">
        <p>
          The NAO name, logos, product design, and software are owned by the Service operator and protected
          by applicable law. These Terms do not grant you rights to our trademarks or source code except the
          limited right to use the hosted Service.
        </p>
      </LegalSection>

      <LegalSection title="10. Disclaimers">
        <p>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE.&quot; TO THE MAXIMUM EXTENT
          PERMITTED BY LAW, WE DISCLAIM WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
          NON-INFRINGEMENT. AI-GENERATED TEXT MAY CONTAIN ERRORS; YOU MUST REVIEW IT BEFORE USE.
        </p>
      </LegalSection>

      <LegalSection title="11. Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NAO AND ITS OPERATORS WILL NOT BE LIABLE FOR INDIRECT,
          INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, DATA, OR
          OPPORTUNITIES. OUR AGGREGATE LIABILITY FOR CLAIMS RELATING TO THE SERVICE WILL NOT EXCEED THE
          AMOUNTS YOU PAID TO NAO FOR THE SERVICE IN THE TWELVE MONTHS BEFORE THE CLAIM.
        </p>
      </LegalSection>

      <LegalSection title="12. Termination">
        <p>
          You may stop using NAO at any time. We may suspend or terminate access for violations of these
          Terms, legal risk, non-payment, or discontinuation of the Service. Provisions that by nature
          should survive (including IP, disclaimers, and liability limits) will survive termination.
        </p>
      </LegalSection>

      <LegalSection title="13. Changes">
        <p>
          We may update these Terms by posting a revised version on this page and updating the date above.
          Continued use after changes become effective constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection title="14. Contact">
        <p>
          Questions:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            {CONTACT_EMAIL}
          </a>
          .
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
