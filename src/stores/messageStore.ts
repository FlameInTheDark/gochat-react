import { create } from 'zustand'
import type { DtoMessage } from '@/types'

interface MessageState {
  messages: Record<string, DtoMessage[]>
  addMessage: (channelId: string, msg: DtoMessage) => void
  setMessages: (channelId: string, msgs: DtoMessage[]) => void
  /** Prepend a batch of older messages, deduplicating against what is already loaded. */
  prependMessages: (channelId: string, msgs: DtoMessage[]) => void
  /** Append a batch of newer messages, deduplicating against what is already loaded. */
  appendMessages: (channelId: string, msgs: DtoMessage[]) => void
  removeMessage: (channelId: string, msgId: string) => void
  updateMessage: (channelId: string, msg: DtoMessage) => void
}

/** Sort messages oldest-first by Snowflake ID (same logic as the legacy app). */
function sortAsc(msgs: DtoMessage[]): DtoMessage[] {
  return [...msgs].sort((a, b) => {
    const aId = BigInt(String(a.id ?? 0))
    const bId = BigInt(String(b.id ?? 0))
    return aId < bId ? -1 : aId > bId ? 1 : 0
  })
}

export const useMessageStore = create<MessageState>((set) => ({
  messages: {},

  // Real-time WS message — always newest, append to end
  addMessage: (channelId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: [...(state.messages[channelId] ?? []), msg],
      },
    })),

  // Initial load from REST API — sort ascending so render order is always correct
  setMessages: (channelId, msgs) =>
    set((state) => ({
      messages: { ...state.messages, [channelId]: sortAsc(msgs) },
    })),

  // Paginated older-messages load — merge without duplicates, keep sorted ascending
  prependMessages: (channelId, msgs) =>
    set((state) => {
      const existing = state.messages[channelId] ?? []
      const existingIds = new Set(existing.map((m) => String(m.id)))
      const unique = msgs.filter((m) => !existingIds.has(String(m.id)))
      if (unique.length === 0) return state
      return {
        messages: { ...state.messages, [channelId]: sortAsc([...unique, ...existing]) },
      }
    }),

  // Paginated newer-messages load — merge without duplicates, keep sorted ascending
  appendMessages: (channelId, msgs) =>
    set((state) => {
      const existing = state.messages[channelId] ?? []
      const existingIds = new Set(existing.map((m) => String(m.id)))
      const unique = msgs.filter((m) => !existingIds.has(String(m.id)))
      if (unique.length === 0) return state
      return {
        messages: { ...state.messages, [channelId]: sortAsc([...existing, ...unique]) },
      }
    }),

  removeMessage: (channelId, msgId) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] ?? []).filter(
          (m) => String(m.id) !== msgId,
        ),
      },
    })),

  updateMessage: (channelId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] ?? []).map((m) =>
          String(m.id) === String(msg.id) ? msg : m,
        ),
      },
    })),
}))
