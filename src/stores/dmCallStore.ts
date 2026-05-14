import { create } from 'zustand'
import { hasDMCallParticipants, type DMCallSummary } from '@/services/dmCallApi'

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
    set((state) => ({
      calls: Object.fromEntries(
        calls
          .filter((call) => call.callId && call.channelId && hasDMCallParticipants(call))
          .map((call) => [call.channelId, call]),
      ),
      incomingChannelId: calls.some((call) => call.channelId === state.incomingChannelId && hasDMCallParticipants(call))
        ? state.incomingChannelId
        : null,
    })),

  upsertCall: (call) =>
    set((state) => {
      if (!call.callId || !call.channelId || !hasDMCallParticipants(call)) {
        const next = { ...state.calls }
        delete next[call.channelId]
        return {
          calls: next,
          incomingChannelId: state.incomingChannelId === call.channelId ? null : state.incomingChannelId,
        }
      }
      return {
        calls: {
          ...state.calls,
          [call.channelId]: call,
        },
        incomingChannelId: state.incomingChannelId,
      }
    }),

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
