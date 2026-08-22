/**
 * Fleet Room store — the persistent, always-on multi-agent chat room.
 *
 * Extends the existing per-task `room-store.ts` conductor/performer model
 * (which is scoped to one task's subagents) into a standing room whose
 * performers are every live agent across every connected runtime adapter
 * (OpenClaw gateways + AgentNet/SwarmClaw/TinyAGI/Hermes via
 * RuntimeAdapterPort). This is the "talk to all agents at once" surface.
 *
 * Design: unlike TaskRoom (one per task, torn down when the task ends),
 * there is exactly one FleetRoom per ClawWork install, hydrated on app start
 * and kept alive for the process lifetime. Messages flow in from every
 * connected adapter's onEvent() stream and out via each adapter's
 * sendMessage(), using the addressing model already proven by AgentNet:
 * a specific agent id, 'all' for broadcast, or `channel:<name>`.
 */

import { createStore } from 'zustand/vanilla';
import type { RuntimeAdapterPort, RuntimeAgentRef, RuntimeMessage } from '../ports/runtime-adapter.js';

export interface FleetPerformer extends RuntimeAgentRef {
  runtimeId: string;
  runtimeKind: string;
  runtimeLabel: string;
}

export interface FleetMessage extends RuntimeMessage {
  /** True if this message originated from Mike (the human operator), not an agent. */
  fromUser: boolean;
}

export interface FleetRoomStoreDeps {
  /** Persist a fleet message for history/search (reuses ClawWork's existing PersistencePort shape). */
  persistFleetMessage?: (msg: FleetMessage) => Promise<unknown>;
  loadFleetHistory?: (limit?: number) => Promise<FleetMessage[]>;
}

export interface FleetRoomState {
  adapters: Record<string, RuntimeAdapterPort>;
  performers: FleetPerformer[];
  messages: FleetMessage[];
  connecting: Record<string, boolean>;
  errors: Record<string, string | undefined>;

  registerAdapter: (adapter: RuntimeAdapterPort) => Promise<void>;
  unregisterAdapter: (runtimeId: string) => Promise<void>;
  refreshAgents: (runtimeId?: string) => Promise<void>;

  /**
   * Send a message from Mike. `recipient` is either a specific agent id
   * (routed to whichever adapter owns that agent), 'all' (broadcast to
   * every connected adapter), or `channel:<name>` (broadcast to every
   * adapter, tagged with that channel — adapters that don't support
   * channels treat it as 'all').
   */
  sendUserMessage: (recipient: string, body: string) => Promise<void>;

  hydrate: () => Promise<void>;
}

const MAX_MESSAGES_IN_MEMORY = 2000;

export function createFleetRoomStore(deps: FleetRoomStoreDeps = {}) {
  const unsubscribers = new Map<string, () => void>();

  function findAdapterForAgent(state: FleetRoomState, agentId: string): RuntimeAdapterPort | undefined {
    const performer = state.performers.find((p) => p.id === agentId);
    if (performer) return state.adapters[performer.runtimeId];
    return undefined;
  }

  const store = createStore<FleetRoomState>((set, get) => ({
    adapters: {},
    performers: [],
    messages: [],
    connecting: {},
    errors: {},

    registerAdapter: async (adapter) => {
      set((s) => ({
        adapters: { ...s.adapters, [adapter.runtimeId]: adapter },
        connecting: { ...s.connecting, [adapter.runtimeId]: true },
      }));

      const result = await adapter.connect();
      set((s) => ({
        connecting: { ...s.connecting, [adapter.runtimeId]: false },
        errors: { ...s.errors, [adapter.runtimeId]: result.ok ? undefined : result.error },
      }));
      if (!result.ok) return;

      const unsub = adapter.onEvent((event) => {
        if (event.type === 'message') {
          const msg = event.payload as unknown as RuntimeMessage;
          set((s) => {
            const next: FleetMessage = { ...msg, fromUser: false };
            const messages = [...s.messages, next].slice(-MAX_MESSAGES_IN_MEMORY);
            return { messages };
          });
          deps.persistFleetMessage?.({ ...(event.payload as RuntimeMessage), fromUser: false }).catch((err) => {
            console.warn('[fleet-room-store] persistFleetMessage failed:', err);
          });
        } else if (event.type === 'agent-joined' || event.type === 'agent-status' || event.type === 'agent-left') {
          get()
            .refreshAgents(adapter.runtimeId)
            .catch((err) => console.warn('[fleet-room-store] refreshAgents on event failed:', err));
        }
      });
      unsubscribers.set(adapter.runtimeId, unsub);

      await get().refreshAgents(adapter.runtimeId);
    },

    unregisterAdapter: async (runtimeId) => {
      const adapter = get().adapters[runtimeId];
      unsubscribers.get(runtimeId)?.();
      unsubscribers.delete(runtimeId);
      if (adapter) await adapter.disconnect();
      set((s) => {
        const adapters = { ...s.adapters };
        delete adapters[runtimeId];
        return {
          adapters,
          performers: s.performers.filter((p) => p.runtimeId !== runtimeId),
        };
      });
    },

    refreshAgents: async (runtimeId) => {
      const state = get();
      const targets = runtimeId ? [state.adapters[runtimeId]].filter(Boolean) : Object.values(state.adapters);
      for (const adapter of targets) {
        try {
          const agents = await adapter.listAgents();
          const fleetPerformers: FleetPerformer[] = agents.map((a) => ({
            ...a,
            runtimeId: adapter.runtimeId,
            runtimeKind: adapter.kind,
            runtimeLabel: adapter.label,
          }));
          set((s) => ({
            performers: [...s.performers.filter((p) => p.runtimeId !== adapter.runtimeId), ...fleetPerformers],
          }));
        } catch (err) {
          console.warn(`[fleet-room-store] refreshAgents(${adapter.runtimeId}) failed:`, err);
        }
      }
    },

    sendUserMessage: async (recipient, body) => {
      const state = get();
      const timestamp = new Date().toISOString();
      const isChannel = recipient.startsWith('channel:');
      const channel = isChannel ? recipient.slice('channel:'.length) : undefined;

      let targets: RuntimeAdapterPort[];
      if (recipient === 'all' || isChannel) {
        targets = Object.values(state.adapters);
      } else {
        const adapter = findAdapterForAgent(state, recipient);
        targets = adapter ? [adapter] : [];
      }

      if (targets.length === 0) {
        console.warn(`[fleet-room-store] sendUserMessage: no adapter resolved for recipient "${recipient}"`);
        return;
      }

      const localMsg: FleetMessage = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        runtimeId: 'user',
        sender: 'user',
        recipient,
        channel,
        body,
        createdAt: timestamp,
        fromUser: true,
      };
      set((s) => ({ messages: [...s.messages, localMsg].slice(-MAX_MESSAGES_IN_MEMORY) }));
      deps.persistFleetMessage?.(localMsg).catch((err) => {
        console.warn('[fleet-room-store] persistFleetMessage (user) failed:', err);
      });

      await Promise.all(
        targets.map((adapter) =>
          adapter.sendMessage({ sender: 'user', recipient, channel, body }).catch((err) => {
            console.warn(`[fleet-room-store] sendMessage via ${adapter.runtimeId} failed:`, err);
          }),
        ),
      );
    },

    hydrate: async () => {
      if (!deps.loadFleetHistory) return;
      try {
        const history = await deps.loadFleetHistory(500);
        set({ messages: history });
      } catch (err) {
        console.warn('[fleet-room-store] hydrate failed:', err);
      }
    },
  }));

  return store;
}
