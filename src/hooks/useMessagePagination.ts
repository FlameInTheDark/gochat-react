import { useState, useEffect, useRef, useCallback } from 'react'
import { messageApi } from '@/api/client'
import { useMessageStore } from '@/stores/messageStore'
import { useReadStateStore } from '@/stores/readStateStore'
import type { DtoMessage } from '@/types'

const PAGE_SIZE = 50
const EMPTY: DtoMessage[] = []

export interface MessagePaginationState {
  messages: DtoMessage[]
  /** Full-screen skeleton for the very first load. */
  isLoading: boolean
  /** Top-of-list skeleton while loading an older page. */
  isLoadingOlder: boolean
  /** Bottom-of-list skeleton while loading a newer page. */
  isLoadingNewer: boolean
  /** True once we have reached the beginning of the channel history. */
  endReached: boolean
  /** True once the most-recent messages are in view (no more pages below). */
  latestReached: boolean
  /** Render the "NEW MESSAGES" separator after the message with this ID. */
  unreadSeparatorAfter: string | null
  loadOlder: () => void
  loadNewer: () => void
  /** ACK the last visible message as read (called by MessageList when at bottom). */
  ackLatest: () => void
}

export function useMessagePagination(
  channelId: string | undefined,
  jumpToMessageId?: string,
  channelLastMessageId?: string,
): MessagePaginationState {
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [isLoadingNewer, setIsLoadingNewer] = useState(false)
  const [endReached, setEndReached] = useState(false)
  const [latestReached, setLatestReached] = useState(true)
  const [unreadSeparatorAfter, setUnreadSeparatorAfter] = useState<string | null>(null)

  const setMessages = useMessageStore((s) => s.setMessages)
  const prependMessages = useMessageStore((s) => s.prependMessages)
  const appendMessages = useMessageStore((s) => s.appendMessages)
  const messages = useMessageStore((s) =>
    channelId ? (s.messages[channelId] ?? EMPTY) : EMPTY,
  )
  const ackChannel = useReadStateStore((s) => s.ackChannel)

  // Refs — avoids stale closures in callbacks and effects
  const channelIdRef = useRef(channelId)
  channelIdRef.current = channelId

  // Sync jumpToMessageId into a ref so the effect can read the latest value
  // without adding it to the dep array (avoiding re-runs when cleared).
  const jumpToMessageIdRef = useRef(jumpToMessageId)
  jumpToMessageIdRef.current = jumpToMessageId
  // Track the previous channelId to distinguish channel changes from jump changes
  const prevChannelIdRef = useRef<string | undefined>(undefined)
  // Track the last jump ID that was successfully handled so we don't reload for the same jump
  const lastHandledJumpRef = useRef<string | undefined>(undefined)

  const loadingOlderRef = useRef(false)
  const loadingNewerRef = useRef(false)
  const endReachedRef = useRef(false)
  const latestReachedRef = useRef(true)

  const messagesRef = useRef(messages)
  messagesRef.current = messages

  // ── Initial load (+ jump-to-message) ─────────────────────────────────────────
  useEffect(() => {
    if (!channelId) return
    const cid = channelId  // narrowed from string | undefined → string

    // Read the jump target at effect time (ref is always up to date).
    const jumpId = jumpToMessageIdRef.current
    const channelChanged = cid !== prevChannelIdRef.current
    prevChannelIdRef.current = cid

    // Determine whether this is a new jump request.
    const isNewJump = !!jumpId && jumpId !== lastHandledJumpRef.current

    // Skip re-running if only jumpToMessageId was cleared and the channel
    // didn't change — avoids a redundant full reload after the jump is done.
    if (!channelChanged && !isNewJump) return

    if (isNewJump) lastHandledJumpRef.current = jumpId

    // Reset state for the incoming channel / jump
    setIsLoading(true)
    setEndReached(false); endReachedRef.current = false
    setLatestReached(true); latestReachedRef.current = true
    setUnreadSeparatorAfter(null)
    loadingOlderRef.current = false
    loadingNewerRef.current = false

    // Read state snapshot — safe to call at effect time because settings are
    // loaded in AppLayout BEFORE any channel page can mount.
    const { readStates, lastMessages } = useReadStateStore.getState()
    const lastReadId = readStates[cid]
    // Prefer the channel object's last_message_id (always populated) over the
    // guilds_last_messages snapshot from settings (may omit some channels).
    const lastMsgId = channelLastMessageId ?? lastMessages[cid]

    let hasUnread = false
    try {
      hasUnread = !!(lastReadId && lastMsgId && BigInt(lastReadId) < BigInt(lastMsgId))
    } catch { /* ignore BigInt parse errors */ }

    // Helper: load messages around a pivot ID (used for jump and unread cases)
    async function loadAround(pivotId: string, opts?: { showSeparator?: boolean }) {
      const res = await messageApi.messageChannelChannelIdGet({
        channelId: cid,
        from: pivotId,
        direction: 'around',
        limit: PAGE_SIZE,
      })
      if (channelIdRef.current !== cid) return

      const data = res.data ?? []
      setMessages(cid, data)

      const knownLastMsgId = useReadStateStore.getState().lastMessages[cid]
      const loadedLastId = data.length > 0 ? String(data[data.length - 1].id) : null
      let includesLatest = false
      try {
        includesLatest = !!(loadedLastId && knownLastMsgId &&
          BigInt(loadedLastId) >= BigInt(knownLastMsgId))
      } catch { /* ignore */ }

      setLatestReached(includesLatest)
      latestReachedRef.current = includesLatest
      setEndReached(false); endReachedRef.current = false

      if (opts?.showSeparator) {
        const separatorPresent = data.some((m) => String(m.id) === pivotId)
        setUnreadSeparatorAfter(separatorPresent ? pivotId : null)
      }

      if (includesLatest && data.length > 0) {
        const last = data[data.length - 1]
        if (last?.id != null) ackChannel(cid, String(last.id))
      }
    }

    async function go() {
      try {
        if (isNewJump && jumpId) {
          // ── Case J: jump to a specific message from search ─────────────────
          await loadAround(jumpId)
        } else if (hasUnread && lastReadId) {
          // ── Case A: unread messages exist ──────────────────────────────────
          await loadAround(lastReadId, { showSeparator: true })
        } else {
          // ── Case B: fully read or first visit ─────────────────────────────
          await loadLatest(cid)
        }
      } catch {
        // failed — fall back to loading latest
        await loadLatest(cid).catch(() => {})
      } finally {
        if (channelIdRef.current === cid) setIsLoading(false)
      }
    }

    void go()
  // setMessages / ackChannel are stable Zustand refs — safe as deps
  // jumpToMessageId is read via ref inside the effect, not as a direct dep,
  // to avoid re-running when the jump is cleared after use.
  }, [channelId, jumpToMessageId, channelLastMessageId, setMessages, ackChannel]) // eslint-disable-line react-hooks/exhaustive-deps

  // Helper: fetch the latest page and ACK it
  async function loadLatest(cid: string): Promise<void> {
    const res = await messageApi.messageChannelChannelIdGet({ channelId: cid, limit: PAGE_SIZE })
    if (channelIdRef.current !== cid) return
    const data = res.data ?? []
    setMessages(cid, data)
    if (data.length < PAGE_SIZE) { setEndReached(true); endReachedRef.current = true }
    setLatestReached(true); latestReachedRef.current = true
    // ACK the latest loaded message
    if (data.length > 0) {
      const last = data[data.length - 1]
      if (last?.id != null) ackChannel(cid, String(last.id))
    }
  }

  // ── Load older page ───────────────────────────────────────────────────────────
  const loadOlder = useCallback(() => {
    const cid = channelIdRef.current
    if (!cid || loadingOlderRef.current || endReachedRef.current) return
    const oldest = messagesRef.current[0]
    if (!oldest) return

    loadingOlderRef.current = true
    setIsLoadingOlder(true)

    void messageApi
      .messageChannelChannelIdGet({
        channelId: cid,
        from: String(oldest.id),
        direction: 'before',
        limit: PAGE_SIZE,
      })
      .then((res) => {
        if (channelIdRef.current !== cid) return
        const batch = res.data ?? []
        if (batch.length < PAGE_SIZE) { setEndReached(true); endReachedRef.current = true }
        if (batch.length > 0) prependMessages(cid, batch)
        // Batch both updates in the same commit for correct scroll preservation
        loadingOlderRef.current = false
        setIsLoadingOlder(false)
      })
      .catch(() => { loadingOlderRef.current = false; setIsLoadingOlder(false) })
  }, [prependMessages])

  // ── Load newer page ───────────────────────────────────────────────────────────
  const loadNewer = useCallback(() => {
    const cid = channelIdRef.current
    if (!cid || loadingNewerRef.current || latestReachedRef.current) return
    const newest = messagesRef.current[messagesRef.current.length - 1]
    if (!newest) return

    loadingNewerRef.current = true
    setIsLoadingNewer(true)

    void messageApi
      .messageChannelChannelIdGet({
        channelId: cid,
        from: String(newest.id),
        direction: 'after',
        limit: PAGE_SIZE,
      })
      .then((res) => {
        if (channelIdRef.current !== cid) return
        const batch = res.data ?? []
        if (batch.length > 0) appendMessages(cid, batch)
        if (batch.length < PAGE_SIZE) {
          setLatestReached(true); latestReachedRef.current = true
          // Reached the present — hide the "NEW MESSAGES" separator
          setUnreadSeparatorAfter(null)
          // ACK the last message
          const last = batch.length > 0
            ? batch[batch.length - 1]
            : messagesRef.current[messagesRef.current.length - 1]
          if (last?.id != null) {
            useReadStateStore.getState().ackChannel(cid, String(last.id))
          }
        }
        loadingNewerRef.current = false
        setIsLoadingNewer(false)
      })
      .catch(() => { loadingNewerRef.current = false; setIsLoadingNewer(false) })
  }, [appendMessages])

  // ── ACK latest (called by MessageList when user is at the bottom) ─────────────
  const ackLatest = useCallback(() => {
    const cid = channelIdRef.current
    if (!cid) return
    const last = messagesRef.current[messagesRef.current.length - 1]
    if (!last?.id) return
    // Always clear the separator when the user reaches the bottom — they've
    // seen the new messages regardless of whether the channel was "unread".
    setUnreadSeparatorAfter(null)
    // Skip the API ACK when the channel is already fully read.
    if (!useReadStateStore.getState().isUnread(cid)) return
    ackChannel(cid, String(last.id))
  }, [ackChannel])

  return {
    messages,
    isLoading,
    isLoadingOlder,
    isLoadingNewer,
    endReached,
    latestReached,
    unreadSeparatorAfter,
    loadOlder,
    loadNewer,
    ackLatest,
  }
}
