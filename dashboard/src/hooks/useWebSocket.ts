import { useEffect, useRef, useCallback } from "react";
import { getToken } from "../api";
import type { WsEvent } from "../types";

const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 15000, 30000];

export function useWebSocket(onEvent: (event: WsEvent) => void) {
  const wsRef     = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const timerRef  = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const connect = useCallback(() => {
    const token = getToken();
    if (!token) return;

    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url   = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      attemptRef.current = 0;
    };

    ws.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data as string) as WsEvent;
        onEventRef.current(event);
      } catch {
        // ignore malformed
      }
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onclose = () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      const delay =
        RECONNECT_DELAYS[Math.min(attemptRef.current, RECONNECT_DELAYS.length - 1)];
      attemptRef.current++;
      timerRef.current = setTimeout(connect, delay);
    };
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
