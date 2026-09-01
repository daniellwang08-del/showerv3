import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useCountUp } from '../../hooks/useCountUp';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { CAST, TOASTS } from './landingMedia';

export function CinematicBackdrop({
  video,
  poster,
  gif,
  gifOpacity = 0.12,
}: {
  video: string;
  poster: string;
  gif?: string;
  gifOpacity?: number;
}) {
  const reduced = usePrefersReducedMotion();

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      {reduced ? (
        <img src={poster} alt="" className="h-full w-full object-cover" />
      ) : (
        <video
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          poster={poster}
        >
          <source src={video} type="video/mp4" />
        </video>
      )}
      {gif && !reduced ? (
        <img
          src={gif}
          alt=""
          className="absolute inset-0 h-full w-full object-cover mix-blend-screen"
          style={{ opacity: gifOpacity }}
        />
      ) : null}
      <div className="landing-grain pointer-events-none absolute inset-0 opacity-[0.18]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-[#05070f]/55 via-[#05070f]/78 to-[#05070f]" />
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#05070f]/70 via-transparent to-[#05070f]/40" />
    </div>
  );
}

export function NetworkField() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || reduced) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const nodes = Array.from({ length: 42 }, () => ({
      x: Math.random(),
      y: Math.random(),
      vx: (Math.random() - 0.5) * 0.00028,
      vy: (Math.random() - 0.5) * 0.00028,
    }));

    let frame = 0;
    let running = true;

    const resize = () => {
      const { width, height } = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      if (!running) return;
      const { width, height } = canvas.getBoundingClientRect();
      ctx.clearRect(0, 0, width, height);

      for (const node of nodes) {
        node.x += node.vx;
        node.y += node.vy;
        if (node.x < 0 || node.x > 1) node.vx *= -1;
        if (node.y < 0 || node.y > 1) node.vy *= -1;
      }

      for (let i = 0; i < nodes.length; i += 1) {
        for (let j = i + 1; j < nodes.length; j += 1) {
          const dx = nodes[i].x - nodes[j].x;
          const dy = nodes[i].y - nodes[j].y;
          const dist = Math.hypot(dx * width, dy * height);
          if (dist > 140) continue;
          ctx.strokeStyle = `rgba(125, 211, 252, ${0.16 * (1 - dist / 140)})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(nodes[i].x * width, nodes[i].y * height);
          ctx.lineTo(nodes[j].x * width, nodes[j].y * height);
          ctx.stroke();
        }
      }

      for (const node of nodes) {
        ctx.fillStyle = 'rgba(186, 230, 253, 0.7)';
        ctx.beginPath();
        ctx.arc(node.x * width, node.y * height, 1.6, 0, Math.PI * 2);
        ctx.fill();
      }

      frame = requestAnimationFrame(draw);
    };

    resize();
    window.addEventListener('resize', resize);
    frame = requestAnimationFrame(draw);

    return () => {
      running = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
    };
  }, [reduced]);

  if (reduced) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-70"
    />
  );
}

export function PointerGlow({ children }: { children: ReactNode }) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;

    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect();
      node.style.setProperty('--glow-x', `${event.clientX - rect.left}px`);
      node.style.setProperty('--glow-y', `${event.clientY - rect.top}px`);
    };

    node.addEventListener('pointermove', onMove);
    return () => node.removeEventListener('pointermove', onMove);
  }, [reduced]);

  return (
    <div ref={ref} className="landing-pointer-glow relative flex min-h-0 flex-1 flex-col">
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

export function HeadlineCycle({ words }: { words: string[] }) {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced || words.length < 2) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % words.length);
    }, 2800);
    return () => window.clearInterval(id);
  }, [reduced, words.length]);

  const active = words[reduced ? 0 : index];

  // Every phrase occupies the same grid cell so swapping "matching" for
  // "filling" cannot change the heading height or shove the page down.
  return (
    <span className="landing-headline-cycle mt-1">
      {words.map((word) => (
        <span
          key={word}
          className="invisible block whitespace-pre-wrap bg-gradient-to-r from-sky-300 via-blue-100 to-indigo-300 bg-clip-text text-transparent"
          aria-hidden="true"
        >
          {word}
        </span>
      ))}
      <span
        key={active}
        className="landing-word-swap block bg-gradient-to-r from-sky-300 via-blue-100 to-indigo-300 bg-clip-text text-transparent"
      >
        {active}
      </span>
    </span>
  );
}

export function CountStat({
  value,
  label,
  hint,
}: {
  value: string;
  label: string;
  hint: string;
}) {
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const numeric = Number.parseInt(value, 10);
  const counted = useCountUp(Number.isFinite(numeric) ? numeric : 0, active);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActive(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className="border-l border-white/10 pl-3 sm:pl-3.5">
      <dt className="text-2xl font-black tabular-nums text-white sm:text-3xl">
        <span className="inline-block min-w-[2ch]">
          {Number.isFinite(numeric) ? counted : value}
        </span>
      </dt>
      <dd className="mt-1 text-[13px] font-bold text-sky-200">{label}</dd>
      <dd className="text-[11px] font-semibold leading-snug text-white/40">{hint}</dd>
    </div>
  );
}

export function FloatingCast() {
  return (
    <div className="pointer-events-none absolute inset-0 hidden lg:block" aria-hidden="true">
      {CAST.map((person, index) => (
        <figure
          key={person.src}
          className={`landing-orbit landing-orbit-${index + 1} absolute`}
        >
          <img
            src={person.src}
            alt=""
            className="h-14 w-14 rounded-full object-cover ring-2 ring-white/30 shadow-[0_12px_40px_-12px_rgba(15,23,42,0.9)]"
          />
          <figcaption className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-white/15 bg-[#05070f]/90 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.14em] text-sky-200">
            {person.role}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export function LiveToasts() {
  const reduced = usePrefersReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduced) return;
    const id = window.setInterval(() => {
      setIndex((current) => (current + 1) % TOASTS.length);
    }, 3200);
    return () => window.clearInterval(id);
  }, [reduced]);

  const toast = TOASTS[index];

  return (
    <div
      className="landing-toast pointer-events-none absolute -right-2 top-8 z-20 hidden w-64 overflow-hidden rounded-2xl border border-white/15 bg-[#0a1224]/92 p-3 shadow-[0_24px_60px_-24px_rgba(2,6,23,0.95)] backdrop-blur-xl lg:block"
      aria-hidden="true"
    >
      <p key={toast.title} className="landing-toast-copy">
        <span className="mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.16em] text-emerald-300">
          <span className="landing-pulse-dot h-1.5 w-1.5 rounded-full bg-emerald-300" />
          Live pipeline
        </span>
        <span className="block text-[13px] font-black text-white">{toast.title}</span>
        <span className="mt-0.5 block text-[11px] font-semibold text-white/55">{toast.detail}</span>
      </p>
    </div>
  );
}

export function PromoRibbon({ children }: { children: ReactNode }) {
  return (
    <div className="landing-ribbon relative overflow-hidden border-b border-sky-300/20 bg-gradient-to-r from-sky-500/20 via-indigo-500/15 to-fuchsia-500/20">
      <div className="landing-ribbon-shine pointer-events-none absolute inset-0" />
      <p className="relative px-4 py-2 text-center text-[11px] font-bold uppercase tracking-[0.18em] text-sky-100 sm:text-[12px]">
        {children}
      </p>
    </div>
  );
}
