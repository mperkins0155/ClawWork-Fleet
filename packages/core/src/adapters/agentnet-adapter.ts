/**
 * AgentNet runtime adapter — first concrete RuntimeAdapterPort implementation.
 *
 * Talks to Mike's AgentNet Hub (Flask/FastAPI app, source at
 * docs/dashboard-references/agentnet-hub-source/app.py in cobalt-fleet repo),
 * a fleet message bus with name-addressed ('to: agent'), broadcast
 * ('to: all'), and channel ('channel: x') messaging plus an agent registry.
 *
 * Verified against the live instance (vps-ovh:8788) on 2026-08-22. Real API
 * contract (differs from an earlier draft of this file):
 *   GET  /agents               -> [{name, last_seen, online}]  (X-API-Key)
 *   GET  /messages?since=N&channel=&wait=&limit= -> {messages:[...], cursor:N}
 *     each message: {id, sender, to, channel, subject, body, created_at}
 *   POST /messages {to, channel, subject, body} -> {id, status}
 *   POST /messages/{id}/ack
 *   GET  /feed?since=&limit= -> {messages:[...]}  (all messages, admin-ish view)
 *   GET  /  -> {service, agents, messages, uptime_sec}  (no auth; health/root)
 *
 * `wait` on GET /messages is a server-side long-poll (seconds); NOT used for
 * the interval-poll fallback below since a fixed polling interval already
 * satisfies the "no client hot-loop" goal, and long-poll would tie up a
 * connection per adapter for no real benefit at this fleet scale.
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
  /** Polling interval for message/agent-status fallback. */
  pollIntervalMs?: number;
}

interface AgentNetAgentRow {
  name: string;
  last_seen: number | null;
  online: boolean;
}

interface AgentNetMessageRow {
  id: number;
  sender: string;
  to: string;
  channel: string | null;
  subject: string | null;
  body: string;
  created_at: number;
}

interface AgentNetInboxResponse {
  messages: AgentNetMessageRow[];
  cursor: number;
}

const DEFAULT_POLL_MS = 4000;

function toRuntimeMessage(m: AgentNetMessageRow, runtimeId: string): RuntimeMessage {
  return {
    id: String(m.id),
    runtimeId,
    sender: m.sender,
    recipient: m.channel ? `channel:${m.channel}` : m.to,
    channel: m.channel ?? undefined,
    body: m.body,
    createdAt: new Date(m.created_at * 1000).toISOString(),
  };
}

export function createAgentNetAdapter(config: AgentNetAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl, apiKey } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let cursor = 0;
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
      const bodyText = await res.text().catch(() => '');
      throw new Error(`AgentNet ${path} -> HTTP ${res.status}${bodyText ? `: ${bodyText}` : ''}`);
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
      const res = await apiFetch<AgentNetInboxResponse>(`/messages?since=${cursor}&limit=100`);
      for (const m of res.messages) {
        emit({
          type: 'message',
          runtimeId,
          payload: toRuntimeMessage(m, runtimeId) as unknown as Record<string, unknown>,
        });
      }
      cursor = res.cursor;
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
        // Root endpoint is unauthenticated and confirms the service is up.
        await fetch(`${baseUrl}/`).then((r) => {
          if (!r.ok) throw new Error(`root check failed: HTTP ${r.status}`);
        });
        // Seed cursor at "now" so we don't replay entire history on connect.
        // Server caps limit at 500 (FastAPI Query le=500).
        const seed = await apiFetch<AgentNetInboxResponse>('/messages?since=0&limit=500');
        cursor = seed.cursor;
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
      return rows.map((a) => ({
        id: a.name,
        name: a.name,
        online: a.online,
        lastSeenAt: a.last_seen != null ? new Date(a.last_seen * 1000).toISOString() : undefined,
      }));
    },

    async sendMessage(params: SendMessageParams) {
      try {
        await apiFetch('/messages', {
          method: 'POST',
          body: JSON.stringify({
            to: params.channel ? 'all' : params.recipient,
            channel: params.channel ?? null,
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
      params.set('since', '0');
      if (opts?.channel) params.set('channel', opts.channel);
      if (opts?.limit) params.set('limit', String(opts.limit));
      const res = await apiFetch<AgentNetInboxResponse>(`/messages?${params.toString()}`);
      let messages = res.messages;
      if (opts?.recipient && opts.recipient !== 'all' && !opts.channel) {
        messages = messages.filter((m) => m.to === opts.recipient || m.to === 'all');
      }
      return messages.map((m) => toRuntimeMessage(m, runtimeId));
    },

    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async healthCheck() {
      const start = Date.now();
      try {
        await fetch(`${baseUrl}/`).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        });
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
