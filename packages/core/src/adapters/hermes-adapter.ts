/**
 * Hermes runtime adapter — RuntimeAdapterPort implementation for a Hermes
 * Agent instance (Nous Research), via its OpenAI-compatible API server
 * (gateway/platforms/api_server.py, default port 8642).
 *
 * Verified against a live instance (vps-ovh:8642) on 2026-08-22. Real API
 * contract (differs from an earlier draft of this file — Hermes wraps every
 * list/object response OpenAI-SDK-style, never returns a bare array):
 *   Auth: Authorization: Bearer <API_SERVER_KEY>  (config: ~/.hermes/config.yaml
 *     api_server.extra.key — confirmed correct in the original draft)
 *   GET  /health              -> {status, platform, version}  (no auth)
 *   GET  /health/detailed     -> rich status, auth required
 *   GET  /api/sessions        -> {object:'list', data:[SessionSummary...]}
 *   POST /api/sessions {session_id} -> {object:'hermes.session', session:{...}}
 *   GET  /api/sessions/{id}   -> 404 {error:{code:'session_not_found'}} if absent
 *   GET  /api/sessions/{id}/messages -> {object:'list', session_id, data:[...]}
 *   POST /api/sessions/{id}/chat {message} -> chat with a persisted session
 *     (SSE-streaming variant at .../chat/stream also exists; not used here —
 *     we poll for new messages instead of holding a stream connection open,
 *     to keep this adapter's transport model consistent with the others)
 *
 * Hermes is fundamentally single-agent-per-gateway (one Hermes process = one
 * agent identity), not a multi-agent bus like AgentNet/SwarmClaw/TinyAGI. So
 * the "agent roster" this adapter exposes has exactly one entry per
 * configured Hermes instance. Register one adapter per Hermes instance
 * (e.g. runtimeId "hermes-vps", "hermes-laptop") for a true multi-instance
 * fleet.
 */

import type {
  RuntimeAdapterPort,
  RuntimeAgentRef,
  RuntimeMessage,
  RuntimeEvent,
  SendMessageParams,
} from '../ports/runtime-adapter.js';

export interface HermesAdapterConfig {
  runtimeId: string;
  label: string;
  /** Base URL, e.g. "http://localhost:8642". */
  baseUrl: string;
  /** API_SERVER_KEY for this Hermes instance's OpenAI-compatible API. */
  apiKey: string;
  /** Display name for this Hermes instance's single agent identity. */
  agentName?: string;
  pollIntervalMs?: number;
}

interface HermesSessionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number | string;
  id?: string;
}

interface HermesListResponse<T> {
  object: 'list';
  data: T[];
}

const DEFAULT_POLL_MS = 5000;
const FLEET_SESSION_ID = 'clawwork-fleet-room';

export function createHermesAdapter(config: HermesAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl, apiKey } = config;
  const agentName = config.agentName ?? label;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastMessageCount = 0;
  let online = false;
  const listeners = new Set<(event: RuntimeEvent) => void>();

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`Hermes ${path} -> HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
    }
    return (await res.json()) as T;
  }

  function emit(event: RuntimeEvent) {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        console.warn(`[hermes-adapter:${runtimeId}] listener error`, err);
      }
    }
  }

  function toIso(ts: number | string | undefined): string {
    if (ts == null) return new Date().toISOString();
    if (typeof ts === 'number') return new Date(ts * (ts < 1e12 ? 1000 : 1)).toISOString();
    return ts;
  }

  async function ensureFleetSession(): Promise<void> {
    try {
      await apiFetch(`/api/sessions/${FLEET_SESSION_ID}`);
    } catch {
      // 404 -> create it.
      await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ session_id: FLEET_SESSION_ID }),
      }).catch((err) => console.warn(`[hermes-adapter:${runtimeId}] ensureFleetSession create failed`, err));
    }
  }

  async function fetchFleetMessages(): Promise<HermesSessionMessage[]> {
    const res = await apiFetch<HermesListResponse<HermesSessionMessage>>(`/api/sessions/${FLEET_SESSION_ID}/messages`);
    return res.data;
  }

  async function pollOnce() {
    try {
      const messages = await fetchFleetMessages();
      if (messages.length > lastMessageCount) {
        for (let i = lastMessageCount; i < messages.length; i++) {
          const m = messages[i];
          if (m.role !== 'assistant') continue; // only surface the agent's own replies as incoming
          emit({
            type: 'message',
            runtimeId,
            payload: {
              id: m.id ?? `${runtimeId}-${i}`,
              runtimeId,
              sender: agentName,
              recipient: 'all',
              body: m.content,
              createdAt: toIso(m.timestamp),
            } satisfies RuntimeMessage as unknown as Record<string, unknown>,
          });
        }
        lastMessageCount = messages.length;
      }

      const wasOnline = online;
      online = true;
      if (!wasOnline) emit({ type: 'agent-status', runtimeId, payload: { online: true } });
    } catch (err) {
      const wasOnline = online;
      online = false;
      if (wasOnline) emit({ type: 'agent-status', runtimeId, payload: { online: false } });
      console.warn(`[hermes-adapter:${runtimeId}] poll failed`, err);
    }
  }

  return {
    runtimeId,
    kind: 'hermes',
    label,

    async connect() {
      try {
        // /health is unauthenticated; confirms the service is reachable
        // before we spend an authenticated call on session setup.
        const health = await fetch(`${baseUrl}/health`).then((r) => r.json() as Promise<{ status?: string }>);
        if (health.status !== 'ok') throw new Error(`unexpected health status: ${health.status}`);

        await ensureFleetSession();
        try {
          const history = await fetchFleetMessages();
          lastMessageCount = history.length;
        } catch {
          lastMessageCount = 0;
        }
        online = true;
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
      // Single-agent-per-gateway runtime: exactly one synthetic entry.
      return [
        {
          id: runtimeId,
          name: agentName,
          online,
          lastSeenAt: online ? new Date().toISOString() : undefined,
        },
      ];
    },

    async sendMessage(params: SendMessageParams) {
      try {
        await apiFetch(`/api/sessions/${FLEET_SESSION_ID}/chat`, {
          method: 'POST',
          body: JSON.stringify({ message: params.body }),
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchMessages(opts) {
      const messages = await fetchFleetMessages();
      const limited = opts?.limit ? messages.slice(-opts.limit) : messages;
      return limited.map(
        (m, i): RuntimeMessage => ({
          id: m.id ?? `${runtimeId}-${i}`,
          runtimeId,
          sender: m.role === 'user' ? 'user' : agentName,
          recipient: 'all',
          body: m.content,
          createdAt: toIso(m.timestamp),
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
        const res = await fetch(`${baseUrl}/health`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
