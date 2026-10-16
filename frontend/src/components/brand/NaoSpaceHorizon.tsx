import { useEffect, useRef } from 'react';
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion';
import { cn } from '@/lib/utils';
import { mountNaoSpaceScene, type NaoSpaceScene } from './naoSpaceScene';

/**
 * Home-page space backdrop: the moon limb catching first sunlight, a parallax
 * starfield with aurora, shooting stars, and satellites that rise and set
 * behind the moon. Decorative only.
 */
export function NaoSpaceHorizon({ className }: { className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<NaoSpaceScene | null>(null);
  const reduceMotion = usePrefersReducedMotion();
  const reduceRef = useRef(reduceMotion);
  reduceRef.current = reduceMotion;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = mountNaoSpaceScene(canvas, { reduceMotion: reduceRef.current });
    sceneRef.current = scene;
    return () => {
      scene?.destroy();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.setReduceMotion(reduceMotion);
  }, [reduceMotion]);

  return (
    <div aria-hidden className={cn('nao-space-hero', className)}>
      <canvas ref={canvasRef} className="nao-space-hero__canvas" />
    </div>
  );
}
