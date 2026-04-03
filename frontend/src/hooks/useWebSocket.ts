import { useEffect, useRef, useCallback } from 'react';

export interface WsEvent {
  type: string;
  user_id?: string;
  job_id?: string;
  valid_job_id?: string;
  invalid_job_id?: string;
  url?: string;
  method?: string;
  confidence?: number;
  overall_score?: number;
  recommendation?: string;
  error?: string;
  reason?: string;
  company?: string;
}

type WsEventHandler = (event: WsEvent) => void;

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS = 30000;

export function useWebSocket(
  isAuthenticated: boolean,
  onEvent: WsEventHandler,
) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const cleanup = useCallback(() => {
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    if (pingTimer.current) {
      clearInterval(pingTimer.current);
      pingTimer.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      wsRef.current.close();
      wsRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    cleanup();

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/api/v1/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      pingTimer.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send('ping');
        }
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as WsEvent;
        if (data.type === 'pong') return;
        onEventRef.current(data);
      } catch {
        // ignore unparseable messages
      }
    };

    ws.onclose = () => {
      if (pingTimer.current) {
        clearInterval(pingTimer.current);
        pingTimer.current = null;
      }
      reconnectTimer.current = setTimeout(connect, RECONNECT_DELAY_MS);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [cleanup]);

  useEffect(() => {
    if (isAuthenticated) {
      connect();
    } else {
      cleanup();
    }
    return cleanup;
  }, [isAuthenticated, connect, cleanup]);
}
