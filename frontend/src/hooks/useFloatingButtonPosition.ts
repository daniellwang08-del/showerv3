import { useEffect, useMemo, useRef, useState } from 'react';

export type FloatingButtonPosition = { x: number; y: number };

type DragState = {
  isDragging: boolean;
  startPointerX: number;
  startPointerY: number;
  startX: number;
  startY: number;
  dragged: boolean;
  pointerId: number | null;
};

export function useFloatingButtonPosition(storageKey: string, opts?: { marginPx?: number; dragThresholdPx?: number }) {
  const marginPx = opts?.marginPx ?? 16;
  const dragThresholdPx = opts?.dragThresholdPx ?? 5;

  const ref = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<FloatingButtonPosition | null>(null);
  const dragRef = useRef<DragState>({
    isDragging: false,
    startPointerX: 0,
    startPointerY: 0,
    startX: 0,
    startY: 0,
    dragged: false,
    pointerId: null,
  });

  const clamp = (next: FloatingButtonPosition): FloatingButtonPosition => {
    const btn = ref.current;
    const btnW = btn?.offsetWidth ?? 180;
    const btnH = btn?.offsetHeight ?? 44;
    const maxX = Math.max(0, window.innerWidth - btnW);
    const maxY = Math.max(0, window.innerHeight - btnH);
    return {
      x: Math.min(Math.max(0, next.x), maxX),
      y: Math.min(Math.max(0, next.y), maxY),
    };
  };

  const getDefault = (): FloatingButtonPosition => {
    const btn = ref.current;
    const btnW = btn?.offsetWidth ?? 180;
    const btnH = btn?.offsetHeight ?? 44;
    const x = Math.max(0, window.innerWidth - btnW - marginPx);
    const y = Math.max(0, Math.round(window.innerHeight / 2 - btnH / 2));
    return { x, y };
  };

  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<FloatingButtonPosition> | null;
        if (parsed && typeof parsed.x === 'number' && typeof parsed.y === 'number') {
          setPos(clamp({ x: parsed.x, y: parsed.y }));
          return;
        }
      }
    } catch {
      // ignore
    }

    requestAnimationFrame(() => setPos(clamp(getDefault())));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pos) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(pos));
    } catch {
      // ignore
    }
  }, [pos, storageKey]);

  useEffect(() => {
    if (!pos) return;
    const onResize = () => setPos((prev) => (prev ? clamp(prev) : prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos]);

  const handlers = useMemo(() => {
    return {
      onPointerDown: (e: React.PointerEvent) => {
        dragRef.current.isDragging = true;
        dragRef.current.dragged = false;
        dragRef.current.pointerId = e.pointerId;
        dragRef.current.startPointerX = e.clientX;
        dragRef.current.startPointerY = e.clientY;
        const current = pos ?? getDefault();
        dragRef.current.startX = current.x;
        dragRef.current.startY = current.y;
        try {
          (e.currentTarget as HTMLButtonElement).setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (!dragRef.current.isDragging) return;
        if (dragRef.current.pointerId !== e.pointerId) return;
        const dx = e.clientX - dragRef.current.startPointerX;
        const dy = e.clientY - dragRef.current.startPointerY;
        if (!dragRef.current.dragged && Math.hypot(dx, dy) >= dragThresholdPx) {
          dragRef.current.dragged = true;
        }
        if (!dragRef.current.dragged) return;
        setPos(
          clamp({
            x: dragRef.current.startX + dx,
            y: dragRef.current.startY + dy,
          }),
        );
      },
      onPointerUp: (e: React.PointerEvent): { wasDrag: boolean } => {
        if (dragRef.current.pointerId !== e.pointerId) return { wasDrag: false };
        dragRef.current.isDragging = false;
        dragRef.current.pointerId = null;
        const wasDrag = dragRef.current.dragged;
        dragRef.current.dragged = false;
        try {
          (e.currentTarget as HTMLButtonElement).releasePointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        return { wasDrag };
      },
      onPointerCancel: () => {
        dragRef.current.isDragging = false;
        dragRef.current.pointerId = null;
        dragRef.current.dragged = false;
      },
    };
  }, [dragThresholdPx, pos]);

  return { ref, pos, setPos, clamp, getDefault, handlers };
}

