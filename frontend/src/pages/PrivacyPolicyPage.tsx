import { Link } from 'react-router-dom';
import { LegalList, LegalPageShell, LegalSection } from '@/components/landing/LegalPageShell';

const UPDATED = 'October 13, 2026';
const CONTACT_EMAIL = 'privacy@nao.it.com';

/**
 * Public Privacy Policy for OAuth / Google API verification and user transparency.
 * Must stay reachable without login at /privacy-policy.
 */
export function PrivacyPolicyPage() {
  return (
    <LegalPageShell
      title="Privacy Policy"
      description="How NAO collects, uses, stores, and shares information when you use the NAO job application workspace at nao.it.com, including optional Google account connections."
      updated={UPDATED}
    >
      <LegalSection title="1. Who we are">
        <p>
          <strong className="text-white">NAO</strong> (the &quot;Service&quot;) is an AI-assisted job
          application workspace operated at{' '}
          <a href="https://nao.it.com" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            https://nao.it.com
          </a>
          . NAO helps individuals source job openings, evaluate fit against their profile, tailor résumés
          and cover letters, and autofill application forms they choose to submit.
        </p>
        <p>
          This Privacy Policy explains what data we process, why we process it, and the choices you have.
          By creating an account or using NAO, you agree to this policy and our{' '}
          <Link to="/terms" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            Terms of Service
          </Link>
          .
        </p>
      </LegalSection>

      <LegalSection title="2. Information we collect">
        <p>Depending on how you use NAO, we may process:</p>
        <LegalList
          items={[
            <>
              <strong className="text-white">Account data:</strong> email address, display name, password
              hash, approval status, and session tokens.
            </>,
            <>
              <strong className="text-white">Profile and application data:</strong> work history, education,
              skills, contact details, preferences, résumés, cover letters, and related documents you upload
              or generate in the Service.
            </>,
            <>
              <strong className="text-white">Job pipeline data:</strong> job URLs, extracted descriptions,
              match scores, application status, and notes associated with your account.
            </>,
            <>
              <strong className="text-white">Integration credentials you connect:</strong> for example API
              keys for chat destinations, spreadsheet configuration, job-board credentials you choose to
              store, and OAuth tokens for optional Google services (see Section 4).
            </>,
            <>
              <strong className="text-white">Usage and diagnostics:</strong> approximate product analytics,
              error logs, and security events needed to operate and improve the Service.
            </>,
            <>
              <strong className="text-white">Billing data:</strong> if subscriptions are enabled, payment
              processor identifiers and subscription status. Card details are handled by our payment
              provider, not stored as full card numbers on NAO servers.
            </>,
          ]}
        />
      </LegalSection>

      <LegalSection id="google-user-data" title="3. Google user data (Gmail and Google APIs)">
        <p>
          NAO offers an <strong className="text-white">optional</strong> Google connection so you can search
          messages in your own Gmail inbox for recruiting and application follow-up (for example recruiter
          replies or interview scheduling). This is not required to use core job sourcing, scoring, or
          autofill features.
        </p>
        <p>
          When you choose <strong className="text-white">Continue with Google</strong> for Gmail, NAO
          requests only the OAuth scope{' '}
          <code className="rounded bg-white/10 px-1.5 py-0.5 text-[13px] text-[#BFD6FF]">
            https://www.googleapis.com/auth/gmail.readonly
          </code>{' '}
          (plus basic account email identity scopes needed to show which Google account you connected). NAO
          does <strong className="text-white">not</strong> request scopes that send, delete, modify, or
          permanently alter Gmail messages.
        </p>
        <p>
          <strong className="text-white">Google user data we may access:</strong> message metadata and
          content returned by the Gmail API for searches you run (for example subject, sender, date,
          snippet, and message body when you open a result), and the Google account email address of the
          connected mailbox.
        </p>
        <p>
          <strong className="text-white">How we use Google user data:</strong> solely to provide inbox
          search and message review features inside your NAO account so you can find job-related email.
          We do not use Gmail content to train generalized AI models, build advertising profiles, sell
          personal data, or determine creditworthiness.
        </p>
        <p>
          <strong className="text-white">Storage:</strong> OAuth refresh and access tokens are encrypted at
          rest. We do not continuously sync or permanently archive your entire mailbox. Search results and
          message bodies are processed to fulfill your request; we avoid retaining full message content
          longer than needed to operate the feature and troubleshoot abuse or security issues.
        </p>
        <p>
          <strong className="text-white">Sharing:</strong> we do not sell Google user data. We do not share
          Gmail content with third parties for advertising. Processors that host our infrastructure may
          process encrypted data under contract. LLM providers are not given your Gmail mailbox as a
          training corpus; any AI assistance that might reference an email would only happen in a
          user-initiated product action and is scoped to that request.
        </p>
        <p>
          <strong className="text-white">Your controls:</strong> you may disconnect Gmail at any time in
          Integrations → Inbox &amp; chat → Gmail. You may also revoke NAO&apos;s access in your Google
          Account permissions at{' '}
          <a
            href="https://myaccount.google.com/permissions"
            className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline"
            rel="noreferrer"
            target="_blank"
          >
            myaccount.google.com/permissions
          </a>
          . Disconnecting deletes stored Google tokens for your NAO account.
        </p>
        <p>
          NAO&apos;s use and transfer of information received from Google APIs adheres to the{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline"
            rel="noreferrer"
            target="_blank"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
      </LegalSection>

      <LegalSection title="4. Other Google integrations">
        <p>
          Separately from Gmail OAuth, some deployments let you post matching job URLs to a Google Sheet
          you configure. That flow uses a server service account you explicitly share a spreadsheet with,
          and does not read your personal Gmail inbox.
        </p>
      </LegalSection>

      <LegalSection title="5. How we use information (non-Google)">
        <LegalList
          items={[
            'Provide, secure, and improve the Service (account auth, job pipelines, document generation, autofill support).',
            'Personalize match scoring and tailored documents using the profile and preferences you supply.',
            'Communicate about account status, security, and product changes.',
            'Comply with law and enforce our Terms of Service.',
          ]}
        />
      </LegalSection>

      <LegalSection title="6. AI processing">
        <p>
          NAO uses large language model providers (for example OpenAI, Anthropic, and Google Gemini,
          depending on configuration) to score jobs and draft résumé or cover-letter content from the
          profile and job text you supply. Prompts are sent to those providers to fulfill your request.
          You should not put secrets into free-text fields that you do not want a processor to see.
        </p>
        <p>
          NAO is not designed or offered for generating non-consensual intimate imagery or other prohibited
          AI NCII uses. Job-application assistance is the sole intended purpose of the Service.
        </p>
      </LegalSection>

      <LegalSection title="7. Cookies and sessions">
        <p>
          We use essential cookies (or equivalent browser storage) for authentication and security, such as
          an HTTP-only session cookie. We do not use third-party advertising cookies on the marketing site.
        </p>
      </LegalSection>

      <LegalSection title="8. Data retention and deletion">
        <p>
          We retain account and pipeline data while your account is active and as needed for backups,
          security, and legal obligations. You may request deletion of your account data by contacting{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            {CONTACT_EMAIL}
          </a>
          . Disconnecting an integration removes that integration&apos;s stored credentials.
        </p>
      </LegalSection>

      <LegalSection title="9. Security">
        <p>
          We use industry-standard safeguards appropriate to a production web application, including
          transport encryption (HTTPS), hashed passwords, encrypted storage of user-provided secrets, and
          access controls. No method of transmission or storage is perfectly secure.
        </p>
      </LegalSection>

      <LegalSection title="10. Children">
        <p>
          NAO is intended for adults seeking employment. The Service is not directed to children under 16,
          and we do not knowingly collect personal information from children.
        </p>
      </LegalSection>

      <LegalSection title="11. International transfers">
        <p>
          NAO may be hosted in data centers outside your country. Where required, we rely on appropriate
          safeguards for cross-border transfers.
        </p>
      </LegalSection>

      <LegalSection title="12. Changes">
        <p>
          We may update this Privacy Policy from time to time. The &quot;Last updated&quot; date at the top
          will change when we do. Material changes may also be communicated in the product or by email.
        </p>
      </LegalSection>

      <LegalSection title="13. Contact">
        <p>
          Privacy questions or deletion requests:{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            {CONTACT_EMAIL}
          </a>
          . Product home:{' '}
          <Link to="/" className="font-semibold text-[#9DB9FF] underline-offset-2 hover:underline">
            https://nao.it.com
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPageShell>
  );
}
