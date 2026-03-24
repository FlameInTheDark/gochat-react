import { create } from 'zustand'
import {
  revokePendingUploadAttachmentUrls,
  type PendingUploadAttachment,
} from '@/lib/pendingAttachments'
import type { DtoAttachment, DtoChannel, DtoMessage, DtoMessageReaction } from '@/types'

export type PendingMessageStatus = 'sending' | 'failed' | 'confirmed'

export type PendingMessageAttachmentDraft = PendingUploadAttachment

export interface PendingMessage {
  localId: string
  channelId: string
  uploadChannelId: string
  nonce: string
  status: PendingMessageStatus
  createdAt: number
  content: string
  reference?: number
  referenceChannelId?: number
  attachmentIds: number[]
  attachments: DtoAttachment[]
  attachmentDrafts: PendingMessageAttachmentDraft[]
  suppressEmbeds: boolean
  message: DtoMessage
}

interface MessageState {
  messages: Record<string, DtoMessage[]>
  pendingMessages: Record<string, PendingMessage[]>
  messageRowKeys: Record<string, Record<string, string>>
  addMessage: (channelId: string, msg: DtoMessage) => void
  receiveMessage: (channelId: string, msg: DtoMessage) => void
  setMessages: (channelId: string, msgs: DtoMessage[]) => void
  /** Prepend a batch of older messages, deduplicating against what is already loaded. */
  prependMessages: (channelId: string, msgs: DtoMessage[]) => void
  /** Append a batch of newer messages, deduplicating against what is already loaded. */
  appendMessages: (channelId: string, msgs: DtoMessage[]) => void
  addPendingMessage: (pending: PendingMessage) => void
  updatePendingMessage: (
    localId: string,
    updater: (pending: PendingMessage) => PendingMessage,
  ) => void
  removePendingMessage: (localId: string) => void
  removePendingMessageByNonce: (channelId: string, nonce: string) => void
  findPendingMessage: (localId: string) => PendingMessage | null
  removeMessage: (channelId: string, msgId: string) => void
  updateMessage: (channelId: string, msg: DtoMessage) => void
  updateMessageReaction: (channelId: string, messageId: string, reaction: DtoMessageReaction) => void
  syncThreadMetadata: (thread: DtoChannel) => void
  removeThreadMetadata: (threadId: string) => void
  removeChannelMessages: (channelId: string) => void
}

/** Sort messages oldest-first by Snowflake ID (same logic as the legacy app). */
function sortAsc(msgs: DtoMessage[]): DtoMessage[] {
  return [...msgs].sort((a, b) => {
    const aId = BigInt(String(a.id ?? 0))
    const bId = BigInt(String(b.id ?? 0))
    return aId < bId ? -1 : aId > bId ? 1 : 0
  })
}

function upsertMessage(existing: DtoMessage[], msg: DtoMessage): DtoMessage[] {
  const next = [...existing]
  const msgId = msg.id != null ? String(msg.id) : null
  if (msgId != null) {
    const existingIndex = next.findIndex((candidate) => String(candidate.id) === msgId)
    if (existingIndex >= 0) {
      next[existingIndex] = msg
      return sortAsc(next)
    }
  }

  next.push(msg)
  return sortAsc(next)
}

function updatePendingCollections(
  pendingMessages: Record<string, PendingMessage[]>,
  matcher: (pending: PendingMessage) => boolean,
  updater: (pending: PendingMessage) => PendingMessage | null,
): Record<string, PendingMessage[]> {
  let changed = false
  const nextPendingMessages: Record<string, PendingMessage[]> = { ...pendingMessages }

  for (const [channelId, messages] of Object.entries(pendingMessages)) {
    let channelChanged = false
    const updatedMessages = messages
      .map((pending) => {
        if (!matcher(pending)) return pending
        channelChanged = true
        return updater(pending)
      })
      .filter((pending): pending is PendingMessage => pending != null)

    if (channelChanged) {
      changed = true
      if (updatedMessages.length > 0) {
        nextPendingMessages[channelId] = updatedMessages
      } else {
        delete nextPendingMessages[channelId]
      }
    }
  }

  return changed ? nextPendingMessages : pendingMessages
}

const PENDING_CONFIRMATION_CLEANUP_MS = 400
const pendingConfirmationCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearPendingConfirmationCleanup(localId: string) {
  const pendingCleanup = pendingConfirmationCleanupTimers.get(localId)
  if (pendingCleanup !== undefined) {
    clearTimeout(pendingCleanup)
    pendingConfirmationCleanupTimers.delete(localId)
  }
}

function releasePendingAttachmentDrafts(pendingMessage: PendingMessage | null | undefined) {
  if (!pendingMessage) return
  revokePendingUploadAttachmentUrls(pendingMessage.attachmentDrafts)
}

function schedulePendingConfirmationCleanup(localId: string) {
  clearPendingConfirmationCleanup(localId)
  pendingConfirmationCleanupTimers.set(
    localId,
    setTimeout(() => {
      pendingConfirmationCleanupTimers.delete(localId)
      useMessageStore.getState().removePendingMessage(localId)
    }, PENDING_CONFIRMATION_CLEANUP_MS),
  )
}

export const useMessageStore = create<MessageState>((set, get) => ({
  messages: {},
  pendingMessages: {},
  messageRowKeys: {},

  // Real-time WS message — always newest, append to end
  addMessage: (channelId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: upsertMessage(state.messages[channelId] ?? [], msg),
      },
    })),

  receiveMessage: (channelId, msg) => {
    let confirmedLocalId: string | null = null

    set((state) => {
      const nonce = msg.nonce?.trim()
      let matchedPending: PendingMessage | null = null
      const nextPendingMessages = nonce
        ? updatePendingCollections(
            state.pendingMessages,
            (pending) => pending.channelId === channelId && pending.nonce === nonce,
            (pending) => {
              confirmedLocalId = pending.localId
              matchedPending = {
                ...pending,
                status: 'confirmed',
                content: msg.content ?? pending.content,
                reference: msg.reference ?? pending.reference,
                referenceChannelId: msg.reference_channel_id ?? pending.referenceChannelId,
                attachments: msg.attachments ?? pending.attachments,
                message: msg,
              }
              return matchedPending
            },
          )
        : state.pendingMessages
      const messageId = msg.id != null ? String(msg.id) : null
      const nextMessageRowKeys = confirmedLocalId != null && messageId
        ? {
            ...state.messageRowKeys,
            [channelId]: {
              ...(state.messageRowKeys[channelId] ?? {}),
              [messageId]: `pending:${confirmedLocalId}`,
            },
          }
        : state.messageRowKeys

      return {
        messages: {
          ...state.messages,
          [channelId]: upsertMessage(state.messages[channelId] ?? [], msg),
        },
        pendingMessages: nextPendingMessages,
        messageRowKeys: nextMessageRowKeys,
      }
    })

    if (confirmedLocalId != null) {
      schedulePendingConfirmationCleanup(confirmedLocalId)
    }
  },

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

  addPendingMessage: (pending) =>
    set((state) => ({
      pendingMessages: {
        ...state.pendingMessages,
        [pending.channelId]: [
          ...(state.pendingMessages[pending.channelId] ?? []),
          pending,
        ].sort((left, right) => left.createdAt - right.createdAt),
      },
    })),

  updatePendingMessage: (localId, updater) =>
    set((state) => {
      const nextPendingMessages = updatePendingCollections(
        state.pendingMessages,
        (pending) => pending.localId === localId,
        updater,
      )
      return nextPendingMessages === state.pendingMessages
        ? state
        : { pendingMessages: nextPendingMessages }
    }),

  removePendingMessage: (localId) => {
    clearPendingConfirmationCleanup(localId)
    releasePendingAttachmentDrafts(get().findPendingMessage(localId))
    set((state) => {
      const nextPendingMessages = updatePendingCollections(
        state.pendingMessages,
        (pending) => pending.localId === localId,
        () => null,
      )
      return nextPendingMessages === state.pendingMessages
        ? state
        : { pendingMessages: nextPendingMessages }
    })
  },

  removePendingMessageByNonce: (channelId, nonce) => {
    const removedPendingMessages: PendingMessage[] = []
    set((state) => {
      const trimmedNonce = nonce.trim()
      if (!trimmedNonce) return state
      const nextPendingMessages = updatePendingCollections(
        state.pendingMessages,
        (pending) => pending.channelId === channelId && pending.nonce === trimmedNonce,
        (pending) => {
          removedPendingMessages.push(pending)
          return null
        },
      )
      return nextPendingMessages === state.pendingMessages
        ? state
        : { pendingMessages: nextPendingMessages }
    })
    removedPendingMessages.forEach((pendingMessage) => {
      clearPendingConfirmationCleanup(pendingMessage.localId)
      releasePendingAttachmentDrafts(pendingMessage)
    })
  },

  findPendingMessage: (localId) => {
    const pendingByChannel = get().pendingMessages
    for (const messages of Object.values(pendingByChannel)) {
      const pendingMessage = messages.find((candidate) => candidate.localId === localId)
      if (pendingMessage) return pendingMessage
    }
    return null
  },

  removeMessage: (channelId, msgId) =>
    set((state) => {
      const nextMessages = {
        ...state.messages,
        [channelId]: (state.messages[channelId] ?? []).filter(
          (m) => String(m.id) !== msgId,
        ),
      }
      const existingRowKeys = state.messageRowKeys[channelId]
      if (!existingRowKeys || !(msgId in existingRowKeys)) {
        return { messages: nextMessages }
      }

      const nextChannelRowKeys = { ...existingRowKeys }
      delete nextChannelRowKeys[msgId]
      const nextMessageRowKeys = { ...state.messageRowKeys }
      if (Object.keys(nextChannelRowKeys).length > 0) {
        nextMessageRowKeys[channelId] = nextChannelRowKeys
      } else {
        delete nextMessageRowKeys[channelId]
      }

      return {
        messages: nextMessages,
        messageRowKeys: nextMessageRowKeys,
      }
    }),

  updateMessage: (channelId, msg) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [channelId]: (state.messages[channelId] ?? []).map((m) =>
          String(m.id) === String(msg.id) ? msg : m,
        ),
      },
    })),

  updateMessageReaction: (channelId, messageId, reaction) =>
    set((state) => {
      const messages = state.messages[channelId]
      if (!messages) return state
      const emojiName = reaction.emoji?.name
      const updated = messages.map((m) => {
        if (String(m.id) !== messageId) return m
        const existing = m.reactions ?? []
        let matched = false
        let next: DtoMessageReaction[]
        if ((reaction.count ?? 0) === 0) {
          next = existing.filter((r) => r.emoji?.name !== emojiName)
        } else {
          next = existing.map((r) => {
            if (r.emoji?.name !== emojiName) return r
            matched = true
            return reaction
          })
          if (!matched) next = [...next, reaction]
        }
        return { ...m, reactions: next }
      })
      return { messages: { ...state.messages, [channelId]: updated } }
    }),

  syncThreadMetadata: (thread) =>
    set((state) => {
      const threadId = thread.id != null ? String(thread.id) : null
      if (!threadId) return state

      let changed = false
      const nextMessages: Record<string, DtoMessage[]> = { ...state.messages }
      const nextPendingMessages: Record<string, PendingMessage[]> = { ...state.pendingMessages }

      for (const [channelId, messages] of Object.entries(state.messages)) {
        let channelChanged = false
        const updatedMessages = messages.map((message) => {
          const messageThreadId = message.thread_id != null
            ? String(message.thread_id)
            : message.thread?.id != null
              ? String(message.thread.id)
              : null
          if (messageThreadId !== threadId) return message

          channelChanged = true
          return { ...message, thread }
        })

        if (channelChanged) {
          changed = true
          nextMessages[channelId] = updatedMessages
        }
      }

      for (const [channelId, pendingMessages] of Object.entries(state.pendingMessages)) {
        let channelChanged = false
        const updatedPendingMessages = pendingMessages.map((pendingMessage) => {
          const messageThreadId = pendingMessage.message.thread_id != null
            ? String(pendingMessage.message.thread_id)
            : pendingMessage.message.thread?.id != null
              ? String(pendingMessage.message.thread.id)
              : null
          if (messageThreadId !== threadId) return pendingMessage

          channelChanged = true
          return {
            ...pendingMessage,
            message: {
              ...pendingMessage.message,
              thread,
            },
          }
        })

        if (channelChanged) {
          changed = true
          nextPendingMessages[channelId] = updatedPendingMessages
        }
      }

      return changed ? { messages: nextMessages, pendingMessages: nextPendingMessages } : state
    }),

  removeThreadMetadata: (threadId) =>
    set((state) => {
      let changed = false
      const nextMessages: Record<string, DtoMessage[]> = { ...state.messages }
      const nextPendingMessages: Record<string, PendingMessage[]> = { ...state.pendingMessages }

      for (const [channelId, messages] of Object.entries(state.messages)) {
        let channelChanged = false
        const updatedMessages = messages.map((message) => {
          const messageThreadId = message.thread_id != null
            ? String(message.thread_id)
            : message.thread?.id != null
              ? String(message.thread.id)
              : null
          if (messageThreadId !== threadId || message.thread == null) return message

          channelChanged = true
          return { ...message, thread: undefined }
        })

        if (channelChanged) {
          changed = true
          nextMessages[channelId] = updatedMessages
        }
      }

      for (const [channelId, pendingMessages] of Object.entries(state.pendingMessages)) {
        let channelChanged = false
        const updatedPendingMessages = pendingMessages.map((pendingMessage) => {
          const messageThreadId = pendingMessage.message.thread_id != null
            ? String(pendingMessage.message.thread_id)
            : pendingMessage.message.thread?.id != null
              ? String(pendingMessage.message.thread.id)
              : null
          if (messageThreadId !== threadId || pendingMessage.message.thread == null) {
            return pendingMessage
          }

          channelChanged = true
          return {
            ...pendingMessage,
            message: {
              ...pendingMessage.message,
              thread: undefined,
            },
          }
        })

        if (channelChanged) {
          changed = true
          nextPendingMessages[channelId] = updatedPendingMessages
        }
      }

      return changed ? { messages: nextMessages, pendingMessages: nextPendingMessages } : state
    }),

  removeChannelMessages: (channelId) => {
    const removedPendingMessages = get().pendingMessages[channelId] ?? []
    removedPendingMessages.forEach((pendingMessage) => {
      clearPendingConfirmationCleanup(pendingMessage.localId)
      releasePendingAttachmentDrafts(pendingMessage)
    })

    set((state) => {
      if (
        !(channelId in state.messages) &&
        !(channelId in state.pendingMessages) &&
        !(channelId in state.messageRowKeys)
      ) {
        return state
      }
      const nextMessages = { ...state.messages }
      const nextPendingMessages = { ...state.pendingMessages }
      const nextMessageRowKeys = { ...state.messageRowKeys }
      delete nextMessages[channelId]
      delete nextPendingMessages[channelId]
      delete nextMessageRowKeys[channelId]
      return {
        messages: nextMessages,
        pendingMessages: nextPendingMessages,
        messageRowKeys: nextMessageRowKeys,
      }
    })
  },
}))
