import { create } from 'zustand'
import type { DMCallSummary } from '@/services/dmCallApi'

interface DMCallState {
  calls: Record<string, DMCallSummary>
  incomingChannelId: string | null
  setCalls: (calls: DMCallSummary[]) => void
  upsertCall: (call: DMCallSummary) => void
  removeCall: (channelId: string) => void
  markDismissed: (channelId: string) => void
  setIncoming: (channelId: string | null) => void
}

export const useDMCallStore = create<DMCallState>((set) => ({
  calls: {},
  incomingChannelId: null,

  setCalls: (calls) =>
    set(() => ({
      calls: Object.fromEntries(calls.map((call) => [call.channelId, call])),
    })),

  upsertCall: (call) =>
    set((state) => ({
      calls: {
        ...state.calls,
        [call.channelId]: call,
      },
      incomingChannelId: state.incomingChannelId,
    })),

  removeCall: (channelId) =>
    set((state) => {
      const next = { ...state.calls }
      delete next[channelId]
      return {
        calls: next,
        incomingChannelId: state.incomingChannelId === channelId ? null : state.incomingChannelId,
      }
    }),

  markDismissed: (channelId) =>
    set((state) => ({
      calls: state.calls[channelId]
        ? {
            ...state.calls,
            [channelId]: { ...state.calls[channelId], dismissed: true },
          }
        : state.calls,
      incomingChannelId: state.incomingChannelId === channelId ? null : state.incomingChannelId,
    })),

  setIncoming: (incomingChannelId) => set({ incomingChannelId }),
}))
