/**
 * Hermes runtime adapter — RuntimeAdapterPort implementation for a Hermes
 * Agent instance (Nous Research), via its OpenAI-compatible API server
 * (gateway/platforms/api_server.py, default port 8642).
 *
 * Hermes is fundamentally a single-agent-per-gateway runtime (one Hermes
 * process = one agent identity), not a multi-agent bus like AgentNet/
 * SwarmClaw/TinyAGI. So the "agent roster" this adapter exposes has exactly
 * one entry per configured Hermes instance, and "sendMessage" always talks
 * to that one agent via a persisted session:
 *
 *   POST /api/sessions/{session_id}/chat  — chat with a persisted session
 *   GET  /api/sessions/{session_id}/messages — session history
 *   GET  /health                           — liveness
 *
 * `recipient`/`channel` are accepted for interface compatibility but only
 * meaningfully affect routing when multiple Hermes instances are registered
 * as separate adapters (one per instance) — e.g. runtimeId "hermes-vps" vs
 * "hermes-laptop" — which is the intended multi-instance setup.
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
  timestamp?: string;
  id?: string;
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
      throw new Error(`Hermes ${path} -> HTTP ${res.status}`);
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

  async function ensureFleetSession(): Promise<void> {
    try {
      await apiFetch(`/api/sessions/${FLEET_SESSION_ID}`);
    } catch {
      // Session doesn't exist yet — create it.
      await apiFetch('/api/sessions', {
        method: 'POST',
        body: JSON.stringify({ session_id: FLEET_SESSION_ID }),
      }).catch((err) => console.warn(`[hermes-adapter:${runtimeId}] ensureFleetSession create failed`, err));
    }
  }

  async function pollOnce() {
    try {
      const messages = await apiFetch<HermesSessionMessage[]>(`/api/sessions/${FLEET_SESSION_ID}/messages`);
      if (messages.length > lastMessageCount) {
        for (const m of messages.slice(lastMessageCount)) {
          if (m.role !== 'assistant') continue; // only surface the agent's own replies as incoming
          emit({
            type: 'message',
            runtimeId,
            payload: {
              id: m.id ?? `${runtimeId}-${messages.indexOf(m)}`,
              runtimeId,
              sender: agentName,
              recipient: 'all',
              body: m.content,
              createdAt: m.timestamp ?? new Date().toISOString(),
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
        await apiFetch('/health');
        await ensureFleetSession();
        try {
          const history = await apiFetch<HermesSessionMessage[]>(`/api/sessions/${FLEET_SESSION_ID}/messages`);
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
      const messages = await apiFetch<HermesSessionMessage[]>(
        `/api/sessions/${FLEET_SESSION_ID}/messages${opts?.limit ? `?limit=${opts.limit}` : ''}`,
      );
      return messages.map(
        (m, i): RuntimeMessage => ({
          id: m.id ?? `${runtimeId}-${i}`,
          runtimeId,
          sender: m.role === 'user' ? 'user' : agentName,
          recipient: 'all',
          body: m.content,
          createdAt: m.timestamp ?? new Date().toISOString(),
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
        await apiFetch('/health');
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
