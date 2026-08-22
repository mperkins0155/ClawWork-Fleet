/**
 * AgentNet runtime adapter — first concrete RuntimeAdapterPort implementation.
 *
 * Talks to Mike's AgentNet Hub (Flask app, source at
 * docs/dashboard-references/agentnet-hub-source/app.py in cobalt-fleet repo),
 * a fleet message bus with name-addressed ('to: agent'), broadcast
 * ('to: all'), and channel ('channel: x') messaging plus an agent registry.
 *
 * Chosen as the first adapter because: (1) it's Mike's own Flask app, so the
 * API surface is fully known and stable, (2) its addressing model
 * (agent / all / channel) is exactly the UX Mike asked for and maps cleanly
 * onto RuntimeAdapterPort without translation loss.
 */

import type {
  RuntimeAdapterPort,
  RuntimeAgentRef,
  RuntimeMessage,
  RuntimeEvent,
  SendMessageParams,
} from '../ports/runtime-adapter.js';

export interface AgentNetAdapterConfig {
  runtimeId: string;
  label: string;
  /** Base URL, e.g. "https://vps-ovh.tail4f4e50.ts.net:8788". */
  baseUrl: string;
  /** X-API-Key for this adapter's own agent identity on the AgentNet bus. */
  apiKey: string;
  /** Polling interval for message/agent-status fallback when no push channel is available. */
  pollIntervalMs?: number;
}

interface AgentNetAgentRow {
  name: string;
  last_seen: number | null;
}

interface AgentNetMessageRow {
  id: number;
  sender: string;
  recipient: string;
  channel: string | null;
  body: string;
  created_at: number;
}

const DEFAULT_POLL_MS = 4000;
/** Agent considered offline if no heartbeat within this window. */
const ONLINE_WINDOW_MS = 90_000;

export function createAgentNetAdapter(config: AgentNetAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl, apiKey } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageId = 0;
  const listeners = new Set<(event: RuntimeEvent) => void>();

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'X-API-Key': apiKey,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`AgentNet ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  function emit(event: RuntimeEvent) {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        console.warn(`[agentnet-adapter:${runtimeId}] listener error`, err);
      }
    }
  }

  async function pollOnce() {
    try {
      const msgs = await apiFetch<AgentNetMessageRow[]>(`/messages?since_id=${lastMessageId}`);
      for (const m of msgs) {
        if (m.id <= lastMessageId) continue;
        lastMessageId = m.id;
        emit({
          type: 'message',
          runtimeId,
          payload: {
            id: String(m.id),
            runtimeId,
            sender: m.sender,
            recipient: m.channel ? `channel:${m.channel}` : m.recipient,
            body: m.body,
            createdAt: new Date(m.created_at * 1000).toISOString(),
          } satisfies RuntimeMessage as unknown as Record<string, unknown>,
        });
      }
    } catch (err) {
      console.warn(`[agentnet-adapter:${runtimeId}] poll failed`, err);
    }
  }

  return {
    runtimeId,
    kind: 'agentnet',
    label,

    async connect() {
      try {
        await apiFetch('/health').catch(() => undefined); // best-effort; AgentNet may not expose /health
        // Seed lastMessageId so we don't replay entire history on connect.
        try {
          const recent = await apiFetch<AgentNetMessageRow[]>('/messages?limit=1');
          lastMessageId = recent.length > 0 ? Math.max(...recent.map((m) => m.id)) : 0;
        } catch {
          lastMessageId = 0;
        }
        pollTimer = setInterval(pollOnce, pollIntervalMs);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async disconnect() {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      listeners.clear();
    },

    async listAgents(): Promise<RuntimeAgentRef[]> {
      const rows = await apiFetch<AgentNetAgentRow[]>('/agents');
      const now = Date.now() / 1000;
      return rows.map((a) => ({
        id: a.name,
        name: a.name,
        online: a.last_seen != null && now - a.last_seen < ONLINE_WINDOW_MS / 1000,
        lastSeenAt: a.last_seen != null ? new Date(a.last_seen * 1000).toISOString() : undefined,
      }));
    },

    async sendMessage(params: SendMessageParams) {
      try {
        await apiFetch('/messages', {
          method: 'POST',
          body: JSON.stringify({
            recipient: params.channel ? undefined : params.recipient,
            channel: params.channel,
            body: params.body,
          }),
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchMessages(opts) {
      const params = new URLSearchParams();
      if (opts?.recipient) params.set('recipient', opts.recipient);
      if (opts?.channel) params.set('channel', opts.channel);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const rows = await apiFetch<AgentNetMessageRow[]>(`/messages?${params.toString()}`);
      return rows.map(
        (m): RuntimeMessage => ({
          id: String(m.id),
          runtimeId,
          sender: m.sender,
          recipient: m.channel ? `channel:${m.channel}` : m.recipient,
          channel: m.channel ?? undefined,
          body: m.body,
          createdAt: new Date(m.created_at * 1000).toISOString(),
        }),
      );
    },

    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async healthCheck() {
      const start = Date.now();
      try {
        await apiFetch('/agents');
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
