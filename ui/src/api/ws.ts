import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, Aggregate, ServerMessage, SessionState } from '../types';

const configuredServerUrl = (import.meta.env.VITE_SERVER_URL as string | undefined)?.replace(/\/$/, '');
const SERVER_URL = configuredServerUrl || (import.meta.env.DEV ? 'http://localhost:4318' : location.origin);

// Viewer token (for a TLS+auth cloud deploy): pass ?token=… once; it's kept in
// localStorage thereafter. Empty for open localhost dev.
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) localStorage.setItem('aad_token', urlToken);
const viewerToken = urlToken ?? localStorage.getItem('aad_token') ?? '';
const tokenQ = viewerToken ? `?token=${encodeURIComponent(viewerToken)}` : '';

/** Build an authenticated URL to the server for REST fetches. */
export function apiUrl(path: string): string {
  return SERVER_URL + path + tokenQ;
}

const WS_URL = SERVER_URL.replace(/^http/, 'ws') + '/live' + tokenQ;

const MAX_EVENTS = 300;

export interface DashboardState {
  connected: boolean;
  sessions: SessionState[];
  aggregate: Aggregate | null;
  events: AgentEvent[];
}

/** Subscribes to the server WS, auto-reconnecting. Returns live dashboard state. */
export function useDashboard(): DashboardState {
  const [connected, setConnected] = useState(false);
  const [sessions, setSessions] = useState<SessionState[]>([]);
  const [aggregate, setAggregate] = useState<Aggregate | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closed = false;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retryRef.current = setTimeout(connect, 1500);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'snapshot') {
          setSessions(msg.sessions);
          setAggregate(msg.aggregate);
          setEvents(msg.recentEvents.slice(-MAX_EVENTS));
        } else if (msg.type === 'sessions') {
          setSessions(msg.sessions);
          setAggregate(msg.aggregate);
        } else if (msg.type === 'event') {
          setEvents((prev) => [...prev, msg.event].slice(-MAX_EVENTS));
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retryRef.current) clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, []);

  return { connected, sessions, aggregate, events };
}

export { SERVER_URL };
