import type { ReactNode } from 'react';

/**
 * Shared chrome for the auth screens: still background, right-aligned glass
 * card with the flowing star border, and the brand header. Only the form
 * passed as `children` changes between sign in and sign up.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="app-surface relative flex min-h-dvh items-center justify-center overflow-hidden bg-gradient-to-br from-blue-100 via-blue-50 to-indigo-100 p-3 sm:p-4 lg:justify-end lg:pr-[26vw]">
      <img
        src="/login-still.jpg"
        alt=""
        aria-hidden="true"
        className="absolute inset-0 z-0 h-full w-full object-cover"
      />

      {/* Right-side scrim so the glass card stays legible.
          Hardcoded dark hex (not slate-*) so the app's dark-mode palette remap
          can't invert this cinematic scrim into a light wash. */}
      <div
        className="absolute inset-0 z-[1] bg-gradient-to-l from-[#05080f]/85 via-[#0b1220]/35 to-transparent"
        aria-hidden="true"
      />

      <div className="relative z-10 w-full max-w-md">
        {/* Ambient glow behind the glass for a brilliant edge */}
        <div
          className="pointer-events-none absolute -inset-px -z-10 rounded-[28px] bg-gradient-to-br from-sky-400/40 via-indigo-500/30 to-fuchsia-500/30 opacity-70 blur-2xl"
          aria-hidden="true"
        />

        <div className="relative overflow-hidden rounded-3xl border border-white/25 bg-white/10 p-5 shadow-[0_20px_60px_-15px_rgba(2,6,23,0.7)] ring-1 ring-inset ring-white/15 backdrop-blur-2xl sm:p-8">
          {/* Glossy top sheen */}
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/25 to-transparent"
            aria-hidden="true"
          />

          <div className="relative">
            <div className="mb-6 text-center sm:mb-8">
              <div className="relative mx-auto mb-3 w-fit">
                <div className="absolute inset-0 -z-10 rounded-full bg-sky-400/30 blur-2xl" aria-hidden="true" />
                <img
                  src="/atomspace-logo.png"
                  alt="Atomspace"
                  className="h-14 w-auto object-contain drop-shadow-[0_4px_18px_rgba(56,189,248,0.45)] sm:h-16"
                />
              </div>
              <h1 className="bg-gradient-to-r from-white via-blue-50 to-sky-200 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent drop-shadow-[0_2px_10px_rgba(56,189,248,0.45)] sm:text-4xl">
                Atomspace
              </h1>
              <p className="mt-2 text-sm font-semibold text-blue-50">Your AI job application workspace</p>
            </div>

            {children}
          </div>
        </div>

        {/* Bright stars flowing along the modal border */}
        <div className="modal-star-border pointer-events-none absolute inset-0 rounded-3xl" aria-hidden="true" />
      </div>
    </div>
  );
}
