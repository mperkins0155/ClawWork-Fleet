/**
 * Fleet store (renderer-side) — thin zustand wrapper over the
 * window.clawwork fleet:* IPC bridge (see preload/index.ts,
 * main/ipc/fleet-handlers.ts).
 *
 * See docs/SUPER_DASHBOARD_PLAN.md (cobalt-fleet repo) for design rationale.
 */

import { create } from 'zustand';

export interface FleetAgent {
  id: string;
  name: string;
  emoji?: string;
  role?: string;
  online: boolean;
  lastSeenAt?: string;
  runtimeId: string;
  runtimeKind: string;
  runtimeLabel: string;
}

export interface FleetMessage {
  id: string;
  runtimeId: string;
  sender: string;
  recipient: string;
  channel?: string;
  body: string;
  createdAt: string;
  fromUser: boolean;
}

export interface FleetRuntimeConfig {
  runtimeId: string;
  kind: string;
  label: string;
  baseUrl: string;
}

interface FleetStoreState {
  agents: FleetAgent[];
  messages: FleetMessage[];
  runtimes: FleetRuntimeConfig[];
  loading: boolean;
  error: string | null;

  hydrate: () => Promise<void>;
  refreshAgents: () => Promise<void>;
  sendMessage: (recipient: string, body: string, channel?: string) => Promise<void>;
  addRuntime: (params: {
    runtimeId: string;
    kind: string;
    label: string;
    baseUrl: string;
    apiKey?: string;
  }) => Promise<void>;
  removeRuntime: (runtimeId: string) => Promise<void>;
}

let unsubscribeEvents: (() => void) | null = null;

export const useFleetStore = create<FleetStoreState>((set, get) => ({
  agents: [],
  messages: [],
  runtimes: [],
  loading: false,
  error: null,

  hydrate: async () => {
    set({ loading: true, error: null });
    try {
      const [runtimesRes, agentsRes, historyRes] = await Promise.all([
        window.clawwork.fleetListRuntimes(),
        window.clawwork.fleetListAgents(),
        window.clawwork.fleetMessagesHistory(500),
      ]);
      set({
        runtimes: runtimesRes.ok ? ((runtimesRes.result as unknown as FleetRuntimeConfig[]) ?? []) : [],
        agents: agentsRes.ok ? ((agentsRes.result as unknown as FleetAgent[]) ?? []) : [],
        messages: historyRes.ok ? ((historyRes.result as unknown as FleetMessage[]) ?? []) : [],
        loading: false,
      });

      if (!unsubscribeEvents) {
        unsubscribeEvents = window.clawwork.onFleetEvent((event) => {
          if (event.type === 'message') {
            const msg = event.payload as unknown as FleetMessage;
            set((s) => ({ messages: [...s.messages, { ...msg, fromUser: false }].slice(-2000) }));
          } else {
            // agent-joined / agent-left / agent-status -> cheap full refresh
            get()
              .refreshAgents()
              .catch(() => undefined);
          }
        });
      }
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : String(err) });
    }
  },

  refreshAgents: async () => {
    const res = await window.clawwork.fleetListAgents();
    if (res.ok) set({ agents: (res.result as unknown as FleetAgent[]) ?? [] });
  },

  sendMessage: async (recipient, body, channel) => {
    const optimistic: FleetMessage = {
      id: `local-${Date.now()}`,
      runtimeId: 'user',
      sender: 'user',
      recipient,
      channel,
      body,
      createdAt: new Date().toISOString(),
      fromUser: true,
    };
    set((s) => ({ messages: [...s.messages, optimistic] }));
    const res = await window.clawwork.fleetSendMessage({ recipient, body, channel });
    if (!res.ok) {
      set({ error: res.error ?? 'send failed' });
    }
  },

  addRuntime: async (params) => {
    const res = await window.clawwork.fleetAddRuntime(params);
    if (res.ok) {
      set((s) => ({
        runtimes: [
          ...s.runtimes,
          { runtimeId: params.runtimeId, kind: params.kind, label: params.label, baseUrl: params.baseUrl },
        ],
      }));
      await get().refreshAgents();
    } else {
      set({ error: res.error ?? 'add runtime failed' });
    }
  },

  removeRuntime: async (runtimeId) => {
    const res = await window.clawwork.fleetRemoveRuntime(runtimeId);
    if (res.ok) {
      set((s) => ({
        runtimes: s.runtimes.filter((r) => r.runtimeId !== runtimeId),
        agents: s.agents.filter((a) => a.runtimeId !== runtimeId),
      }));
    } else {
      set({ error: res.error ?? 'remove runtime failed' });
    }
  },
}));
