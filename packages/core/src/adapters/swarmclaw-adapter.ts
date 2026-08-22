/**
 * SwarmClaw runtime adapter — RuntimeAdapterPort implementation for a
 * SwarmClaw instance (Next.js app, agents at /api/agents, chatrooms at
 * /api/chatrooms/[id] for multi-agent addressing, feed at /api/swarmfeed).
 *
 * Addressing model: SwarmClaw doesn't have AgentNet's flat agent/all/channel
 * model natively — it uses per-chatroom membership. We map:
 *   - recipient = specific agentId -> find/create a 1:1 chatroom with that agent
 *   - recipient = 'all' -> the adapter's configured "fleet broadcast" chatroom
 *     (a chatroom containing every known agent, created lazily on connect)
 *   - recipient = channel:<name> -> a chatroom whose name matches <name>
 *     (created lazily if it doesn't exist)
 */

import type {
  RuntimeAdapterPort,
  RuntimeAgentRef,
  RuntimeMessage,
  RuntimeEvent,
  SendMessageParams,
} from '../ports/runtime-adapter.js';

export interface SwarmClawAdapterConfig {
  runtimeId: string;
  label: string;
  /** Base URL, e.g. "http://vps-ovh:3457". */
  baseUrl: string;
  /** Optional bearer/session token if this SwarmClaw instance requires auth. */
  authToken?: string;
  pollIntervalMs?: number;
}

interface SwarmClawAgent {
  id: string;
  name: string;
  avatar?: string;
  updatedAt: number;
  status?: string;
}

interface SwarmClawChatroom {
  id: string;
  name: string;
  agentIds: string[];
  hidden?: boolean;
}

interface SwarmClawChatroomMessage {
  id: string;
  chatroomId: string;
  senderId: string;
  senderType: 'user' | 'agent';
  content: string;
  createdAt: number;
}

const DEFAULT_POLL_MS = 5000;
const BROADCAST_CHATROOM_NAME = '__clawwork_fleet_broadcast__';

export function createSwarmClawAdapter(config: SwarmClawAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl, authToken } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let broadcastChatroomId: string | null = null;
  const channelChatroomIds = new Map<string, string>();
  const directChatroomIds = new Map<string, string>();
  const lastSeenTimestamps = new Map<string, number>();
  const listeners = new Set<(event: RuntimeEvent) => void>();

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`SwarmClaw ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }

  function emit(event: RuntimeEvent) {
    for (const cb of listeners) {
      try {
        cb(event);
      } catch (err) {
        console.warn(`[swarmclaw-adapter:${runtimeId}] listener error`, err);
      }
    }
  }

  async function ensureBroadcastChatroom(): Promise<string> {
    if (broadcastChatroomId) return broadcastChatroomId;
    const rooms = await apiFetch<Record<string, SwarmClawChatroom>>('/api/chatrooms?filter=all');
    const existing = Object.values(rooms).find((r) => r.name === BROADCAST_CHATROOM_NAME);
    if (existing) {
      broadcastChatroomId = existing.id;
      return existing.id;
    }
    const agents = await apiFetch<Record<string, SwarmClawAgent>>('/api/agents');
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({
        name: BROADCAST_CHATROOM_NAME,
        agentIds: Object.keys(agents),
        chatMode: 'parallel',
        hidden: true,
      }),
    });
    broadcastChatroomId = created.id;
    return created.id;
  }

  async function ensureChannelChatroom(channel: string): Promise<string> {
    const cached = channelChatroomIds.get(channel);
    if (cached) return cached;
    const rooms = await apiFetch<Record<string, SwarmClawChatroom>>('/api/chatrooms?filter=all');
    const existing = Object.values(rooms).find((r) => r.name === `channel:${channel}`);
    if (existing) {
      channelChatroomIds.set(channel, existing.id);
      return existing.id;
    }
    const agents = await apiFetch<Record<string, SwarmClawAgent>>('/api/agents');
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({ name: `channel:${channel}`, agentIds: Object.keys(agents), chatMode: 'parallel' }),
    });
    channelChatroomIds.set(channel, created.id);
    return created.id;
  }

  async function ensureDirectChatroom(agentId: string): Promise<string> {
    const cached = directChatroomIds.get(agentId);
    if (cached) return cached;
    const rooms = await apiFetch<Record<string, SwarmClawChatroom>>('/api/chatrooms?filter=all');
    const existing = Object.values(rooms).find((r) => r.agentIds.length === 1 && r.agentIds[0] === agentId && r.hidden);
    if (existing) {
      directChatroomIds.set(agentId, existing.id);
      return existing.id;
    }
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({ name: `dm:${agentId}`, agentIds: [agentId], chatMode: 'sequential', hidden: true }),
    });
    directChatroomIds.set(agentId, created.id);
    return created.id;
  }

  async function pollChatroom(chatroomId: string) {
    try {
      const messages = await apiFetch<SwarmClawChatroomMessage[]>(`/api/chatrooms/${chatroomId}/messages`).catch(
        () => [],
      );
      const lastSeen = lastSeenTimestamps.get(chatroomId) ?? 0;
      let maxTs = lastSeen;
      for (const m of messages) {
        if (m.createdAt <= lastSeen) continue;
        maxTs = Math.max(maxTs, m.createdAt);
        emit({
          type: 'message',
          runtimeId,
          payload: {
            id: m.id,
            runtimeId,
            sender: m.senderType === 'user' ? 'user' : m.senderId,
            recipient: chatroomId === broadcastChatroomId ? 'all' : chatroomId,
            body: m.content,
            createdAt: new Date(m.createdAt).toISOString(),
          } satisfies RuntimeMessage as unknown as Record<string, unknown>,
        });
      }
      lastSeenTimestamps.set(chatroomId, maxTs);
    } catch (err) {
      console.warn(`[swarmclaw-adapter:${runtimeId}] pollChatroom(${chatroomId}) failed`, err);
    }
  }

  async function pollAll() {
    const rooms = [broadcastChatroomId, ...channelChatroomIds.values(), ...directChatroomIds.values()].filter(
      (r): r is string => !!r,
    );
    await Promise.all(rooms.map(pollChatroom));
  }

  return {
    runtimeId,
    kind: 'swarmclaw',
    label,

    async connect() {
      try {
        await apiFetch('/api/version').catch(() => undefined);
        await ensureBroadcastChatroom();
        pollTimer = setInterval(pollAll, pollIntervalMs);
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
      const agents = await apiFetch<Record<string, SwarmClawAgent>>('/api/agents');
      const now = Date.now();
      return Object.values(agents).map((a) => ({
        id: a.id,
        name: a.name,
        online: now - a.updatedAt < 5 * 60_000,
        lastSeenAt: new Date(a.updatedAt).toISOString(),
      }));
    },

    async sendMessage(params: SendMessageParams) {
      try {
        let chatroomId: string;
        if (params.channel) {
          chatroomId = await ensureChannelChatroom(params.channel);
        } else if (params.recipient === 'all') {
          chatroomId = await ensureBroadcastChatroom();
        } else {
          chatroomId = await ensureDirectChatroom(params.recipient);
        }
        await apiFetch(`/api/chats/${chatroomId}/messages`, {
          method: 'POST',
          body: JSON.stringify({ content: params.body, senderType: 'user' }),
        }).catch(async () => {
          // Some SwarmClaw versions route chatroom sends through /api/chatrooms/[id] directly.
          await apiFetch(`/api/chatrooms/${chatroomId}`, {
            method: 'POST',
            body: JSON.stringify({ content: params.body }),
          });
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchMessages(opts) {
      const chatroomId = opts?.channel
        ? await ensureChannelChatroom(opts.channel)
        : opts?.recipient && opts.recipient !== 'all'
          ? await ensureDirectChatroom(opts.recipient)
          : await ensureBroadcastChatroom();
      const messages = await apiFetch<SwarmClawChatroomMessage[]>(`/api/chatrooms/${chatroomId}/messages`).catch(
        () => [],
      );
      const limited = opts?.limit ? messages.slice(-opts.limit) : messages;
      return limited.map(
        (m): RuntimeMessage => ({
          id: m.id,
          runtimeId,
          sender: m.senderType === 'user' ? 'user' : m.senderId,
          recipient: opts?.recipient ?? 'all',
          channel: opts?.channel,
          body: m.content,
          createdAt: new Date(m.createdAt).toISOString(),
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
        await apiFetch('/api/agents');
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
