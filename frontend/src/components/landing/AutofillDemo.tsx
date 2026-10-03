import { useEffect, useState } from 'react';
import { Check, FileUp } from 'lucide-react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';

const FIELDS = [
  { label: 'Full name', value: 'Alex Rivera' },
  { label: 'Email', value: 'alex.rivera@email.com' },
  { label: 'Years of experience', value: '8' },
  { label: 'Work authorization', value: 'Authorized to work' },
  { label: 'Notice period', value: '2 weeks' },
] as const;

function useTyped(text: string, active: boolean, speed = 28) {
  const [shown, setShown] = useState('');

  useEffect(() => {
    if (!active) {
      setShown('');
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setShown(text);
      return;
    }
    setShown('');
    let i = 0;
    const id = window.setInterval(() => {
      i += 1;
      setShown(text.slice(0, i));
      if (i >= text.length) window.clearInterval(id);
    }, speed);
    return () => window.clearInterval(id);
  }, [active, speed, text]);

  return shown;
}

function FieldRow({
  label,
  value,
  active,
  done,
}: {
  label: string;
  value: string;
  active: boolean;
  done: boolean;
}) {
  const typed = useTyped(value, active);

  return (
    <div
      className={`rounded-xl border px-3.5 py-2.5 transition duration-500 ${
        active
          ? 'border-[#6F9BFF]/40 bg-[#3D74FF]/10'
          : done
            ? 'border-[#6F9BFF]/20 bg-[#3D74FF]/[0.05]'
            : 'border-white/10 bg-white/[0.03]'
      }`}
    >
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-white/55">{label}</p>
      <p className="mt-1 min-h-[1.25rem] font-mono text-[13px] font-semibold text-white">
        {done && !active ? value : typed}
        {active ? <span className="landing-caret ml-0.5 inline-block h-3.5 w-px bg-[#BFD6FF]" /> : null}
      </p>
    </div>
  );
}

export function AutofillDemo() {
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (reduced) {
      setStep(FIELDS.length + 1);
      return;
    }
    const id = window.setInterval(() => {
      setStep((current) => (current + 1) % (FIELDS.length + 2));
    }, 1600);
    return () => window.clearInterval(id);
  }, [reduced]);

  return (
    <div className="space-y-2.5">
      {FIELDS.map((field, index) => (
        <FieldRow
          key={field.label}
          label={field.label}
          value={field.value}
          active={step === index}
          done={step > index}
        />
      ))}
      <div
        className={`flex items-center gap-3 rounded-xl border px-3.5 py-3 transition duration-500 ${
          step > FIELDS.length
            ? 'border-[#6F9BFF]/35 bg-[#3D74FF]/10'
            : 'border-white/10 bg-white/[0.03]'
        }`}
      >
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2C5BF5] text-white">
          {step > FIELDS.length ? <Check size={15} strokeWidth={3} /> : <FileUp size={15} strokeWidth={2.5} />}
        </span>
        <div>
          <p className="text-[12px] font-black text-white">Alex_Rivera_Platform_Engineer.pdf</p>
          <p className="text-[10px] font-semibold text-white/55">
            {step > FIELDS.length ? 'Résumé attached' : 'Waiting to attach tailored résumé'}
          </p>
        </div>
      </div>
    </div>
  );
}
