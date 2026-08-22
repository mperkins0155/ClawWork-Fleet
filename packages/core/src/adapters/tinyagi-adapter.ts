/**
 * TinyAGI runtime adapter — RuntimeAdapterPort implementation for a TinyAGI
 * instance (Hono API server, default port 3777).
 *
 * Endpoints used (see packages/server/src/routes/*.ts in tinyagi):
 *   GET  /api/agents                  -> agent roster
 *   GET  /api/agent-messages          -> all agent messages (broadcast feed)
 *   GET  /api/agents/:id/messages     -> per-agent messages
 *   GET  /api/teams                   -> team roster (used to resolve 'channel:<teamId>')
 *   GET  /api/chatroom/:teamId        -> team chatroom messages
 *   POST /api/chatroom/:teamId        -> post to a team chatroom
 *
 * Addressing model: TinyAGI's chatrooms are per-team, not a flat bus, so:
 *   - recipient = 'all'        -> posts are NOT directly supported (no single
 *     all-agents room); we fan out a direct message to every known agent's
 *     default team chatroom instead (best-effort).
 *   - recipient = <agentId>    -> resolve the agent's team, post there.
 *   - recipient = channel:<x>  -> treat <x> as a teamId directly.
 */

import type {
  RuntimeAdapterPort,
  RuntimeAgentRef,
  RuntimeMessage,
  RuntimeEvent,
  SendMessageParams,
} from '../ports/runtime-adapter.js';

export interface TinyAgiAdapterConfig {
  runtimeId: string;
  label: string;
  /** Base URL, e.g. "http://vps-ovh:3777". */
  baseUrl: string;
  pollIntervalMs?: number;
}

interface TinyAgiAgent {
  name?: string;
  provider?: string;
  model?: string;
  working_directory?: string;
}

interface TinyAgiTeam {
  name: string;
  agents: string[];
  leader_agent: string;
}

/** Verified against live GET /api/chatroom/:teamId response (2026-08-22). */
interface TinyAgiChatMessage {
  id: number;
  team_id: string;
  from_agent: string;
  message: string;
  created_at: number;
}

const DEFAULT_POLL_MS = 5000;

export function createTinyAgiAdapter(config: TinyAgiAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let agentToTeam = new Map<string, string>();
  const lastSeenPerTeam = new Map<string, number>();
  const listeners = new Set<(event: RuntimeEvent) => void>();

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      throw new Error(`TinyAGI ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  function emit(event: RuntimeEvent) {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        console.warn(`[tinyagi-adapter:${runtimeId}] listener error`, err);
      }
    }
  }

  async function refreshAgentTeamMap() {
    try {
      const teams = await apiFetch<Record<string, TinyAgiTeam>>('/api/teams');
      const next = new Map<string, string>();
      for (const [teamId, team] of Object.entries(teams)) {
        for (const agentId of team.agents ?? []) {
          next.set(agentId, teamId);
        }
      }
      agentToTeam = next;
    } catch (err) {
      console.warn(`[tinyagi-adapter:${runtimeId}] refreshAgentTeamMap failed`, err);
    }
  }

  async function pollTeam(teamId: string) {
    try {
      const messages = await apiFetch<TinyAgiChatMessage[]>(`/api/chatroom/${teamId}?limit=50`);
      const lastSeen = lastSeenPerTeam.get(teamId) ?? 0;
      let maxTs = lastSeen;
      for (const m of messages) {
        const ts = m.created_at ?? 0;
        if (ts <= lastSeen) continue;
        maxTs = Math.max(maxTs, ts);
        emit({
          type: 'message',
          runtimeId,
          payload: {
            id: String(m.id),
            runtimeId,
            sender: m.from_agent,
            recipient: `channel:${teamId}`,
            channel: teamId,
            body: m.message,
            createdAt: new Date(ts || Date.now()).toISOString(),
          } satisfies RuntimeMessage as unknown as Record<string, unknown>,
        });
      }
      lastSeenPerTeam.set(teamId, maxTs);
    } catch (err) {
      console.warn(`[tinyagi-adapter:${runtimeId}] pollTeam(${teamId}) failed`, err);
    }
  }

  async function pollAll() {
    const teamIds = new Set(agentToTeam.values());
    await Promise.all(Array.from(teamIds).map(pollTeam));
  }

  return {
    runtimeId,
    kind: 'tinyagi',
    label,

    async connect() {
      try {
        await apiFetch('/api/status').catch(() => undefined);
        await refreshAgentTeamMap();
        pollTimer = setInterval(() => {
          refreshAgentTeamMap().catch(() => undefined);
          pollAll().catch(() => undefined);
        }, pollIntervalMs);
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
      const agents = await apiFetch<Record<string, TinyAgiAgent>>('/api/agents');
      // TinyAGI's /api/agents has no per-agent online/lastActive signal (it's
      // config, not runtime state). /api/status has a heartbeat.lastSent map
      // keyed by agent id -- use that as the liveness source instead.
      const status = await apiFetch<{ heartbeat?: { lastSent?: Record<string, number> } }>('/api/status').catch(
        () => ({}) as { heartbeat?: { lastSent?: Record<string, number> } },
      );
      const lastSent = status.heartbeat?.lastSent ?? {};
      const now = Date.now() / 1000; // lastSent values are unix seconds
      return Object.entries(agents).map(([id, a]) => {
        const sent = lastSent[id];
        return {
          id,
          name: a.name ?? id,
          online: sent != null && now - sent < 2 * 3600, // within 2x default 1h heartbeat interval
          lastSeenAt: sent != null ? new Date(sent * 1000).toISOString() : undefined,
        };
      });
    },

    async sendMessage(params: SendMessageParams) {
      try {
        let teamIds: string[];
        if (params.channel) {
          teamIds = [params.channel];
        } else if (params.recipient === 'all') {
          teamIds = Array.from(new Set(agentToTeam.values()));
        } else {
          const teamId = agentToTeam.get(params.recipient);
          if (!teamId) return { ok: false, error: `unknown TinyAGI agent "${params.recipient}"` };
          teamIds = [teamId];
        }
        if (teamIds.length === 0) {
          return { ok: false, error: 'no TinyAGI team resolved for this recipient' };
        }
        // Server route (packages/server/src/routes/chatroom.ts) hardcodes
        // sender='user' server-side via postToChatRoom(teamId, 'user', ...) --
        // body only accepts { message }, no sender override.
        await Promise.all(
          teamIds.map((teamId) =>
            apiFetch(`/api/chatroom/${teamId}`, {
              method: 'POST',
              body: JSON.stringify({ message: params.body }),
            }),
          ),
        );
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchMessages(opts) {
      const teamId = opts?.channel ?? (opts?.recipient ? agentToTeam.get(opts.recipient) : undefined);
      if (!teamId) {
        // No specific team resolved -> aggregate across all known teams (best-effort).
        const all: RuntimeMessage[] = [];
        for (const t of new Set(agentToTeam.values())) {
          const msgs = await apiFetch<TinyAgiChatMessage[]>(`/api/chatroom/${t}?limit=${opts?.limit ?? 50}`).catch(
            () => [],
          );
          for (const m of msgs) {
            all.push({
              id: String(m.id),
              runtimeId,
              sender: m.from_agent,
              recipient: `channel:${t}`,
              channel: t,
              body: m.message,
              createdAt: new Date(m.created_at ?? Date.now()).toISOString(),
            });
          }
        }
        return all;
      }
      const messages = await apiFetch<TinyAgiChatMessage[]>(`/api/chatroom/${teamId}?limit=${opts?.limit ?? 100}`);
      return messages.map(
        (m): RuntimeMessage => ({
          id: String(m.id),
          runtimeId,
          sender: m.from_agent,
          recipient: `channel:${teamId}`,
          channel: teamId,
          body: m.message,
          createdAt: new Date(m.created_at ?? Date.now()).toISOString(),
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
        await apiFetch('/api/status');
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
