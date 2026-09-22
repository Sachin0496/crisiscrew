import { initialState, reduce, type CrisisEvent, type CrisisState } from "@crisiscrew/contracts";
import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * Live engine state: a snapshot from /api/state, then every event from the
 * SSE stream applied with the same reducer the server uses. Reconnects with a
 * fresh snapshot if the stream drops.
 */
export function useCrisis(): { state: CrisisState; connected: boolean } {
  const [state, setState] = useState<CrisisState>(initialState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let source: EventSource | null = null;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let current = initialState();

    const connect = async () => {
      try {
        current = await api.state();
        setState(current);
        source = new EventSource(`/api/stream?since=${current.seq}`);
        source.onopen = () => setConnected(true);
        source.onmessage = (message) => {
          const event = JSON.parse(message.data) as CrisisEvent;
          if (event.seq <= current.seq) return;
          current = reduce(current, event);
          setState(current);
        };
        source.onerror = () => {
          setConnected(false);
          source?.close();
          if (!stopped) retry = setTimeout(connect, 1500);
        };
      } catch {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      }
    };

    void connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      source?.close();
    };
  }, []);

  return { state, connected };
}
