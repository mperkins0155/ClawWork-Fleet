/**
 * SwarmClaw runtime adapter — RuntimeAdapterPort implementation for a
 * SwarmClaw instance (Next.js app).
 *
 * Verified against a live instance (vps-ovh:3457) on 2026-08-22. Real API
 * contract (differs substantially from an earlier draft of this file):
 *   Auth: X-Access-Key header (NOT Authorization: Bearer) — see src/proxy.ts
 *   GET  /api/agents                 -> { [agentId]: AgentRecord }
 *     (agentId is a random hex string, NOT a slug; agent has .name, .disabled,
 *     .updatedAt, .heartbeatEnabled, no simple "online" boolean)
 *   GET  /api/chatrooms?filter=all   -> { [chatroomId]: Chatroom }
 *   GET  /api/chatrooms/{id}         -> full Chatroom INCLUDING messages[]
 *     embedded (there is no separate /messages sub-route — that 404s to the
 *     Next.js app shell HTML, not JSON)
 *   POST /api/chatrooms/{id}/chat  {text, senderId} -> streams the agent
 *     reply; the chatroom's messages[] then contains the exchange
 *   POST /api/chatrooms  {name, agentIds, chatMode, hidden} -> create room
 *
 * Addressing model: SwarmClaw's chatrooms are membership-based, not a flat
 * bus, so:
 *   - recipient = specific agentId -> find/create a 1:1 chatroom with that agent
 *   - recipient = 'all' -> a lazily-created "fleet broadcast" chatroom
 *     containing every known (non-disabled) agent
 *   - recipient = channel:<name> -> a chatroom named `channel:<name>`,
 *     created lazily if it doesn't exist
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
  /** Base URL, e.g. "http://100.108.164.113:3457". */
  baseUrl: string;
  /** X-Access-Key for this SwarmClaw instance (matches process.env.ACCESS_KEY). */
  accessKey: string;
  pollIntervalMs?: number;
}

interface SwarmClawAgentRecord {
  name: string;
  disabled?: boolean;
  updatedAt?: number;
  heartbeatEnabled?: boolean;
}

interface SwarmClawChatroomMessage {
  id: string;
  senderId: string;
  senderName?: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  time: number;
}

interface SwarmClawChatroom {
  id: string;
  name: string;
  agentIds: string[];
  messages: SwarmClawChatroomMessage[];
  hidden?: boolean;
  createdAt: number;
  updatedAt: number;
}

const DEFAULT_POLL_MS = 5000;
const BROADCAST_CHATROOM_NAME = '__clawwork_fleet_broadcast__';

export function createSwarmClawAdapter(config: SwarmClawAdapterConfig): RuntimeAdapterPort {
  const { runtimeId, label, baseUrl, accessKey } = config;
  const pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_MS;

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let broadcastChatroomId: string | null = null;
  const channelChatroomIds = new Map<string, string>();
  const directChatroomIds = new Map<string, string>();
  const lastSeenMessageCount = new Map<string, number>();
  const listeners = new Set<(event: RuntimeEvent) => void>();

  async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Key': accessKey,
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '');
      throw new Error(`SwarmClaw ${path} -> HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ''}`);
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

  function mapMessage(m: SwarmClawChatroomMessage, chatroomId: string, isBroadcast: boolean): RuntimeMessage {
    return {
      id: m.id,
      runtimeId,
      sender: m.role === 'user' ? 'user' : (m.senderName ?? m.senderId),
      recipient: isBroadcast ? 'all' : chatroomId,
      body: m.text,
      createdAt: new Date(m.time).toISOString(),
    };
  }

  async function findRoomByName(name: string): Promise<SwarmClawChatroom | undefined> {
    const rooms = await apiFetch<Record<string, SwarmClawChatroom>>('/api/chatrooms?filter=all');
    return Object.values(rooms).find((r) => r.name === name);
  }

  async function activeAgentIds(): Promise<string[]> {
    const agents = await apiFetch<Record<string, SwarmClawAgentRecord>>('/api/agents');
    return Object.entries(agents)
      .filter(([, a]) => !a.disabled)
      .map(([id]) => id);
  }

  async function ensureBroadcastChatroom(): Promise<string> {
    if (broadcastChatroomId) return broadcastChatroomId;
    const existing = await findRoomByName(BROADCAST_CHATROOM_NAME);
    if (existing) {
      broadcastChatroomId = existing.id;
      return existing.id;
    }
    const agentIds = await activeAgentIds();
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({ name: BROADCAST_CHATROOM_NAME, agentIds, chatMode: 'parallel', hidden: true }),
    });
    broadcastChatroomId = created.id;
    return created.id;
  }

  async function ensureChannelChatroom(channel: string): Promise<string> {
    const cached = channelChatroomIds.get(channel);
    if (cached) return cached;
    const roomName = `channel:${channel}`;
    const existing = await findRoomByName(roomName);
    if (existing) {
      channelChatroomIds.set(channel, existing.id);
      return existing.id;
    }
    const agentIds = await activeAgentIds();
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({ name: roomName, agentIds, chatMode: 'parallel' }),
    });
    channelChatroomIds.set(channel, created.id);
    return created.id;
  }

  async function ensureDirectChatroom(agentId: string): Promise<string> {
    const cached = directChatroomIds.get(agentId);
    if (cached) return cached;
    const roomName = `dm:${agentId}`;
    const existing = await findRoomByName(roomName);
    if (existing) {
      directChatroomIds.set(agentId, existing.id);
      return existing.id;
    }
    const created = await apiFetch<SwarmClawChatroom>('/api/chatrooms', {
      method: 'POST',
      body: JSON.stringify({ name: roomName, agentIds: [agentId], chatMode: 'sequential', hidden: true }),
    });
    directChatroomIds.set(agentId, created.id);
    return created.id;
  }

  async function pollChatroom(chatroomId: string, isBroadcast: boolean) {
    try {
      const room = await apiFetch<SwarmClawChatroom>(`/api/chatrooms/${chatroomId}`);
      const seen = lastSeenMessageCount.get(chatroomId) ?? 0;
      const newMessages = room.messages.slice(seen);
      for (const m of newMessages) {
        if (m.senderId === 'system' || m.senderId === 'user') continue; // only surface agent replies as incoming
        emit({
          type: 'message',
          runtimeId,
          payload: mapMessage(m, chatroomId, isBroadcast) as unknown as Record<string, unknown>,
        });
      }
      lastSeenMessageCount.set(chatroomId, room.messages.length);
    } catch (err) {
      console.warn(`[swarmclaw-adapter:${runtimeId}] pollChatroom(${chatroomId}) failed`, err);
    }
  }

  async function pollAll() {
    const jobs: Array<[string, boolean]> = [];
    if (broadcastChatroomId) jobs.push([broadcastChatroomId, true]);
    for (const id of channelChatroomIds.values()) jobs.push([id, false]);
    for (const id of directChatroomIds.values()) jobs.push([id, false]);
    await Promise.all(jobs.map(([id, isBroadcast]) => pollChatroom(id, isBroadcast)));
  }

  return {
    runtimeId,
    kind: 'swarmclaw',
    label,

    async connect() {
      try {
        await fetch(`${baseUrl}/api/healthz`).then((r) => {
          if (!r.ok) throw new Error(`healthz check failed: HTTP ${r.status}`);
        });
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
      const agents = await apiFetch<Record<string, SwarmClawAgentRecord>>('/api/agents');
      const now = Date.now();
      return Object.entries(agents).map(([id, a]) => ({
        id,
        name: a.name,
        online:
          !a.disabled && (a.heartbeatEnabled === true || (a.updatedAt != null && now - a.updatedAt < 10 * 60_000)),
        lastSeenAt: a.updatedAt != null ? new Date(a.updatedAt).toISOString() : undefined,
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
        await apiFetch(`/api/chatrooms/${chatroomId}/chat`, {
          method: 'POST',
          body: JSON.stringify({ text: params.body, senderId: 'user' }),
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async fetchMessages(opts) {
      const isBroadcast = !opts?.channel && (!opts?.recipient || opts.recipient === 'all');
      const chatroomId = opts?.channel
        ? await ensureChannelChatroom(opts.channel)
        : opts?.recipient && opts.recipient !== 'all'
          ? await ensureDirectChatroom(opts.recipient)
          : await ensureBroadcastChatroom();
      const room = await apiFetch<SwarmClawChatroom>(`/api/chatrooms/${chatroomId}`);
      const messages = room.messages.filter((m) => m.senderId !== 'system');
      const limited = opts?.limit ? messages.slice(-opts.limit) : messages;
      return limited.map((m) => mapMessage(m, chatroomId, isBroadcast));
    },

    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    async healthCheck() {
      const start = Date.now();
      try {
        const res = await fetch(`${baseUrl}/api/healthz`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return { ok: true, latencyMs: Date.now() - start };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
