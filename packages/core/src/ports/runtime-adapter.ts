/**
 * RuntimeAdapterPort — plugs a non-OpenClaw agent runtime (AgentNet, SwarmClaw,
 * TinyAGI, Hermes, ...) into ClawWork's existing session/message/task model.
 *
 * This is the seam described in ClawWork's own roadmap ("Multi-runtime
 * adapters — bring agents from other runtimes into the same task / session /
 * artifact model", see website/src/docs/en/2026-04-24-next-multi-runtime-control-plane.md).
 *
 * Design intent: every runtime adapter normalizes its backend's agent list,
 * chat/messaging API, and presence/event stream into this shape. The Fleet
 * Room store (fleet-room-store.ts) and Fleet Registry consume adapters
 * generically — they never talk to AgentNet/SwarmClaw/etc. directly.
 */

export type RuntimeKind = 'openclaw' | 'agentnet' | 'swarmclaw' | 'tinyagi' | 'hermes';

export interface RuntimeAgentRef {
  /** Stable id, unique within this runtime (not globally unique — combine with runtimeId). */
  id: string;
  name: string;
  emoji?: string;
  /** Free-form role/team label, e.g. "coordinator", "backend-dev", "planner". */
  role?: string;
  online: boolean;
  lastSeenAt?: string;
}

export interface RuntimeMessage {
  id: string;
  runtimeId: string;
  /** Sender agent id, or 'user' for Mike's own messages. */
  sender: string;
  /** Target: a specific agent id, 'all' for broadcast, or `channel:<name>` for a channel post. */
  recipient: string;
  channel?: string;
  body: string;
  createdAt: string;
}

export interface SendMessageParams {
  sender: string;
  recipient: string;
  channel?: string;
  body: string;
}

export interface RuntimeEvent {
  type: 'message' | 'agent-status' | 'agent-joined' | 'agent-left';
  runtimeId: string;
  payload: Record<string, unknown>;
}

export interface RuntimeAdapterPort {
  /** Unique id for this runtime connection, e.g. "agentnet-vps-ovh". */
  readonly runtimeId: string;
  readonly kind: RuntimeKind;
  readonly label: string;

  connect: () => Promise<{ ok: boolean; error?: string }>;
  disconnect: () => Promise<void>;

  listAgents: () => Promise<RuntimeAgentRef[]>;

  /** Send a message using this runtime's own addressing model (agent id / 'all' / channel). */
  sendMessage: (params: SendMessageParams) => Promise<{ ok: boolean; error?: string }>;

  /** Fetch recent messages, optionally scoped to a recipient/channel. */
  fetchMessages: (opts?: { recipient?: string; channel?: string; limit?: number }) => Promise<RuntimeMessage[]>;

  /** Subscribe to live events (new messages, agent status changes). Returns an unsubscribe fn. */
  onEvent: (callback: (event: RuntimeEvent) => void) => () => void;

  /** Lightweight health check — used by the Infra Monitor panel. */
  healthCheck: () => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
}
