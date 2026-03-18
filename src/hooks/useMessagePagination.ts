import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { messageApi } from '@/api/client'
import { useMessageStore, type PendingMessage } from '@/stores/messageStore'
import { useReadStateStore } from '@/stores/readStateStore'
import type { DtoMessage } from '@/types'
import {
  getMessageRowKey,
  type JumpRequest,
  type MessageTimelineGapDirection,
  type MessageTimelineGapKind,
  type MessageTimelineGapStatus,
  type MessageTimelineMode,
  type MessageTimelineRow,
} from '@/lib/messageJump'
import { compareSnowflakes, maxSnowflake, snowflakeToDate, snowflakeToDayLabel } from '@/lib/snowflake'

const PAGE_SIZE = 50
const JUMP_WINDOW_SIZE = 100
const SMALL_FETCH_PAGE_SIZE = 20
const EMPTY_MESSAGES: DtoMessage[] = []
const EMPTY_PENDING_MESSAGES: PendingMessage[] = []
const EMPTY_MESSAGE_ROW_KEYS: Record<string, string> = {}
const ESTIMATED_ROW_PX = 44
const MIN_GAP_HEIGHT = 96
const MAX_GAP_HEIGHT = 2_400
const FIVE_MINUTES = 5 * 60 * 1000
const FIRST_MESSAGE_POSITION = 1

type TimelineSegment = LoadedTimelineSegment | GapTimelineSegment

interface LoadedTimelineSegment {
  type: 'loaded'
  key: string
  messageIds: string[]
}

interface GapTimelineSegment {
  type: 'gap'
  key: string
  direction: MessageTimelineGapDirection
  gapKind: MessageTimelineGapKind
  status: MessageTimelineGapStatus
  heightPx: number
  startPosition?: number
  endPosition?: number
}

interface TimelineState {
  mode: MessageTimelineMode
  segments: TimelineSegment[]
  targetMessageId: string | null
  channelMaxPosition?: number
  unreadSeparatorAfter: string | null
}

interface JumpContextResult {
  messages: DtoMessage[]
  latestPosition?: number
  olderHasMoreFallback: boolean
  newerHasMoreFallback: boolean
}

interface FetchState {
  key: string
  controller: AbortController
}

export interface MessagePaginationState {
  rows: MessageTimelineRow[]
  mode: MessageTimelineMode
  jumpTargetRowKey: string | null
  focusTargetRowKey: string | null
  isLoadingInitial: boolean
  isLoadingOlder: boolean
  isLoadingNewer: boolean
  loadGap: (gapKey: string) => void
  loadOlder: () => void
  loadNewer: () => void
  jumpToPresent: () => void
  ackLatest: () => void
}

function isRequestCanceled(error: unknown): boolean {
  return axios.isAxiosError(error) && error.code === 'ERR_CANCELED'
}

function shouldResumeFromLastRead(
  lastReadId: string | undefined,
  knownLatestId: string | undefined,
): boolean {
  return !!lastReadId && !!knownLatestId && compareSnowflakes(lastReadId, knownLatestId) < 0
}

function normalizeMessages(
  messages: DtoMessage[],
  options?: { excludeIds?: Set<string> },
): DtoMessage[] {
  const deduped = new Map<string, DtoMessage>()

  messages.forEach((message) => {
    if (message.id == null) return
    const id = String(message.id)
    if (options?.excludeIds?.has(id)) return
    deduped.set(id, message)
  })

  return [...deduped.values()].sort((left, right) => compareSnowflakes(left.id, right.id))
}

function mergeUniqueMessages(...batches: DtoMessage[][]): DtoMessage[] {
  return normalizeMessages(batches.flat())
}

function collectMessageIds(messages: DtoMessage[]): string[] {
  return messages
    .filter((message) => message.id != null)
    .map((message) => String(message.id))
}

function getOldestMessage(messages: DtoMessage[]): DtoMessage | null {
  return messages[0] ?? null
}

function getNewestMessage(messages: DtoMessage[]): DtoMessage | null {
  return messages[messages.length - 1] ?? null
}

function getBoundaryPosition(message: DtoMessage | null | undefined): number | undefined {
  return typeof message?.position === 'number' ? message.position : undefined
}

function hasReachedHistoryStart(position: number | undefined): boolean {
  return position != null && position <= FIRST_MESSAGE_POSITION
}

function hasMessageId(messages: DtoMessage[], messageId: string): boolean {
  return messages.some((message) => String(message.id) === messageId)
}

function resolveUnreadSeparatorAfter(
  messages: DtoMessage[],
  lastReadId: string | undefined,
  knownLatestId: string | undefined,
): string | null {
  if (!lastReadId || !knownLatestId) return null
  if (compareSnowflakes(lastReadId, knownLatestId) >= 0) return null
  return hasMessageId(messages, lastReadId) ? lastReadId : null
}

function buildLoadedSegment(messages: DtoMessage[], label = 'loaded'): LoadedTimelineSegment {
  const ids = collectMessageIds(messages)
  const firstId = ids[0] ?? 'empty'
  const lastId = ids[ids.length - 1] ?? firstId
  return {
    type: 'loaded',
    key: `${label}:${firstId}:${lastId}`,
    messageIds: ids,
  }
}

function buildGapHeight(startPosition?: number, endPosition?: number): number {
  const approxMissingCount =
    startPosition != null && endPosition != null
      ? Math.max(0, endPosition - startPosition + 1)
      : 1

  return Math.min(
    Math.max(approxMissingCount * ESTIMATED_ROW_PX, MIN_GAP_HEIGHT),
    MAX_GAP_HEIGHT,
  )
}

function createGapSegment(params: {
  key: string
  direction: MessageTimelineGapDirection
  gapKind: MessageTimelineGapKind
  status?: MessageTimelineGapStatus
  startPosition?: number
  endPosition?: number
}): GapTimelineSegment {
  return {
    type: 'gap',
    key: params.key,
    direction: params.direction,
    gapKind: params.gapKind,
    status: params.status ?? 'idle',
    startPosition: params.startPosition,
    endPosition: params.endPosition,
    heightPx: buildGapHeight(params.startPosition, params.endPosition),
  }
}

function materializeSegmentMessages(
  segment: LoadedTimelineSegment,
  messageMap: Map<string, DtoMessage>,
): DtoMessage[] {
  return segment.messageIds
    .map((id) => messageMap.get(id))
    .filter((message): message is DtoMessage => message != null)
}

function collectMaterializedMessages(
  segments: TimelineSegment[],
  messageMap: Map<string, DtoMessage>,
): DtoMessage[] {
  return mergeUniqueMessages(
    ...segments
      .filter((segment): segment is LoadedTimelineSegment => segment.type === 'loaded')
      .map((segment) => materializeSegmentMessages(segment, messageMap)),
  )
}

function getDayLabelForDate(date: Date): string {
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  const sameDay = (left: Date, right: Date) =>
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()

  if (sameDay(date, today)) return 'Today'
  if (sameDay(date, yesterday)) return 'Yesterday'
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function getMessageTimestamp(
  message: DtoMessage,
  optimisticCreatedAt?: number,
): number {
  return optimisticCreatedAt ?? snowflakeToDate(message.id).getTime()
}

function getMessageDayLabel(
  message: DtoMessage,
  optimisticCreatedAt?: number,
): string {
  return optimisticCreatedAt != null
    ? getDayLabelForDate(new Date(optimisticCreatedAt))
    : snowflakeToDayLabel(message.id)
}

function isGroupedWith(
  currentMessage: DtoMessage,
  previousMessage: DtoMessage,
  options?: {
    currentCreatedAt?: number
    previousCreatedAt?: number
  },
): boolean {
  const groupableTypes = new Set([0, 1])
  if (!groupableTypes.has(currentMessage.type ?? 0) || !groupableTypes.has(previousMessage.type ?? 0)) {
    return false
  }
  if (String(currentMessage.author?.id) !== String(previousMessage.author?.id)) return false

  const currentTime = getMessageTimestamp(currentMessage, options?.currentCreatedAt)
  const previousTime = getMessageTimestamp(previousMessage, options?.previousCreatedAt)
  if (new Date(currentTime).toDateString() !== new Date(previousTime).toDateString()) return false
  return currentTime - previousTime < FIVE_MINUTES
}

function shouldShowOlderGap(messages: DtoMessage[], fallbackHasMore: boolean): boolean {
  if (messages.length === 0) return false
  const oldestPosition = getBoundaryPosition(getOldestMessage(messages))
  if (oldestPosition != null) {
    return !hasReachedHistoryStart(oldestPosition)
  }
  return fallbackHasMore
}

function shouldShowNewerGap(
  messages: DtoMessage[],
  options: {
    fallbackHasMore: boolean
    latestPosition?: number
    knownLatestId?: string
  },
): boolean {
  if (messages.length === 0) return false

  const newestMessage = getNewestMessage(messages)
  const newestPosition = getBoundaryPosition(newestMessage)
  if (newestPosition != null && options.latestPosition != null) {
    return newestPosition < options.latestPosition
  }

  if (
    newestMessage?.id != null &&
    options.knownLatestId &&
    compareSnowflakes(newestMessage.id, options.knownLatestId) < 0
  ) {
    return true
  }

  return options.fallbackHasMore
}

function buildOlderEdgeGap(messages: DtoMessage[], status: MessageTimelineGapStatus = 'idle'): GapTimelineSegment {
  const oldestPosition = getBoundaryPosition(getOldestMessage(messages))
  return createGapSegment({
    key: 'gap:older-edge',
    direction: 'older',
    gapKind: 'older-edge',
    status,
    startPosition:
      oldestPosition != null && oldestPosition > FIRST_MESSAGE_POSITION
        ? FIRST_MESSAGE_POSITION
        : undefined,
    endPosition:
      oldestPosition != null && oldestPosition > FIRST_MESSAGE_POSITION
        ? oldestPosition - 1
        : undefined,
  })
}

function buildNewerEdgeGap(
  messages: DtoMessage[],
  latestPosition: number | undefined,
  status: MessageTimelineGapStatus = 'idle',
): GapTimelineSegment {
  const newestPosition = getBoundaryPosition(getNewestMessage(messages))
  return createGapSegment({
    key: 'gap:newer-edge',
    direction: 'newer',
    gapKind: 'newer-edge',
    status,
    startPosition: newestPosition != null ? newestPosition + 1 : undefined,
    endPosition: latestPosition,
  })
}

function buildBetweenGap(
  leftMessages: DtoMessage[],
  rightMessages: DtoMessage[],
  direction: MessageTimelineGapDirection,
  status: MessageTimelineGapStatus = 'idle',
): GapTimelineSegment {
  const leftNewestPosition = getBoundaryPosition(getNewestMessage(leftMessages))
  const rightOldestPosition = getBoundaryPosition(getOldestMessage(rightMessages))

  return createGapSegment({
    key: `gap:between:${direction}:${getNewestMessage(leftMessages)?.id ?? 'left'}:${getOldestMessage(rightMessages)?.id ?? 'right'}`,
    direction,
    gapKind: 'between',
    status,
    startPosition: leftNewestPosition != null ? leftNewestPosition + 1 : undefined,
    endPosition: rightOldestPosition != null ? rightOldestPosition - 1 : undefined,
  })
}

function buildJumpRunwayGap(
  direction: MessageTimelineGapDirection,
  requestKey: string,
): GapTimelineSegment {
  return createGapSegment({
    key: `gap:jump-runway:${requestKey}`,
    direction,
    gapKind: 'jump-runway',
    status: 'loading',
  })
}

function buildSingleIslandState(
  messages: DtoMessage[],
  options: {
    mode: MessageTimelineMode
    targetMessageId?: string | null
    latestPosition?: number
    unreadSeparatorAfter?: string | null
    olderHasMoreFallback: boolean
    newerHasMoreFallback: boolean
    knownLatestId?: string
  },
): TimelineState {
  const normalizedMessages = normalizeMessages(messages)
  const segments: TimelineSegment[] = []

  if (normalizedMessages.length > 0) {
    if (shouldShowOlderGap(normalizedMessages, options.olderHasMoreFallback)) {
      segments.push(buildOlderEdgeGap(normalizedMessages))
    }

    segments.push(buildLoadedSegment(normalizedMessages, 'loaded:island'))

    if (shouldShowNewerGap(normalizedMessages, {
      fallbackHasMore: options.newerHasMoreFallback,
      latestPosition: options.latestPosition,
      knownLatestId: options.knownLatestId,
    })) {
      segments.push(buildNewerEdgeGap(normalizedMessages, options.latestPosition))
    }
  }

  return {
    mode: options.mode,
    segments,
    targetMessageId: options.targetMessageId ?? null,
    channelMaxPosition: options.latestPosition,
    unreadSeparatorAfter: options.unreadSeparatorAfter ?? null,
  }
}

function canMergeLoadedRanges(leftMessages: DtoMessage[], rightMessages: DtoMessage[]): boolean {
  if (leftMessages.length === 0 || rightMessages.length === 0) return true

  const leftNewest = getNewestMessage(leftMessages)
  const rightOldest = getOldestMessage(rightMessages)
  if (!leftNewest?.id || !rightOldest?.id) return false
  if (compareSnowflakes(leftNewest.id, rightOldest.id) >= 0) return true

  const leftNewestPosition = getBoundaryPosition(leftNewest)
  const rightOldestPosition = getBoundaryPosition(rightOldest)
  if (leftNewestPosition != null && rightOldestPosition != null) {
    return leftNewestPosition + 1 >= rightOldestPosition
  }

  return false
}

function hasEdgeGap(state: TimelineState | null, direction: MessageTimelineGapDirection): boolean {
  if (!state) return false
  return state.segments.some((segment) =>
    segment.type === 'gap' &&
    segment.direction === direction &&
    (segment.gapKind === 'older-edge' || segment.gapKind === 'newer-edge' || segment.gapKind === 'jump-runway'),
  )
}

function areGapSegmentsEquivalent(
  left: GapTimelineSegment | null,
  right: GapTimelineSegment,
): boolean {
  if (!left) return false

  return left.key === right.key &&
    left.direction === right.direction &&
    left.gapKind === right.gapKind &&
    left.status === right.status &&
    left.heightPx === right.heightPx &&
    left.startPosition === right.startPosition &&
    left.endPosition === right.endPosition
}

function syncHistoryBrowseNewerGap(
  state: TimelineState,
  messages: DtoMessage[],
  knownLatestId?: string,
): TimelineState {
  const messageMap = new Map(
    messages
      .filter((message) => message.id != null)
      .map((message) => [String(message.id), message] as const),
  )
  const materializedMessages = collectMaterializedMessages(state.segments, messageMap)
  const latestPosition = Math.max(
    state.channelMaxPosition ?? getBoundaryPosition(getNewestMessage(messages)) ?? 0,
    getBoundaryPosition(getNewestMessage(messages)) ?? 0,
  ) || undefined

  if (materializedMessages.length === 0) {
    return latestPosition === state.channelMaxPosition
      ? state
      : {
          ...state,
          channelMaxPosition: latestPosition,
        }
  }

  const newerEdgeGapIndex = state.segments.findIndex((segment) =>
    segment.type === 'gap' &&
    segment.direction === 'newer' &&
    segment.gapKind === 'newer-edge',
  )
  const currentNewerEdgeGap = newerEdgeGapIndex >= 0
    ? state.segments[newerEdgeGapIndex] as GapTimelineSegment
    : null
  const shouldHaveNewerGap = shouldShowNewerGap(materializedMessages, {
    fallbackHasMore: currentNewerEdgeGap != null,
    latestPosition,
    knownLatestId,
  })

  let nextSegments = state.segments
  if (shouldHaveNewerGap) {
    const nextGap = buildNewerEdgeGap(
      materializedMessages,
      latestPosition,
      currentNewerEdgeGap?.status ?? 'idle',
    )

    if (currentNewerEdgeGap == null) {
      nextSegments = [...state.segments, nextGap]
    } else if (!areGapSegmentsEquivalent(currentNewerEdgeGap, nextGap)) {
      nextSegments = replaceSegmentAt(state.segments, newerEdgeGapIndex, nextGap)
    }
  } else if (currentNewerEdgeGap != null) {
    nextSegments = state.segments.filter((_, index) => index !== newerEdgeGapIndex)
  }

  if (nextSegments === state.segments && latestPosition === state.channelMaxPosition) {
    return state
  }

  return {
    ...state,
    channelMaxPosition: latestPosition,
    segments: nextSegments,
  }
}

function buildRunwayState(
  baseMessages: DtoMessage[],
  options: {
    direction: MessageTimelineGapDirection
    requestKey: string
    preserveOlderGap: boolean
    preserveNewerGap: boolean
    latestPosition?: number
  },
): TimelineState {
  const normalizedBase = normalizeMessages(baseMessages)
  const segments: TimelineSegment[] = []

  if (options.direction === 'newer') {
    if (options.preserveOlderGap && normalizedBase.length > 0) {
      segments.push(buildOlderEdgeGap(normalizedBase))
    }
    if (normalizedBase.length > 0) {
      segments.push(buildLoadedSegment(normalizedBase, 'loaded:base'))
    }
    segments.push(buildJumpRunwayGap('newer', options.requestKey))
  } else {
    segments.push(buildJumpRunwayGap('older', options.requestKey))
    if (normalizedBase.length > 0) {
      segments.push(buildLoadedSegment(normalizedBase, 'loaded:base'))
    }
    if (options.preserveNewerGap && normalizedBase.length > 0) {
      segments.push(buildNewerEdgeGap(normalizedBase, options.latestPosition))
    }
  }

  return {
    mode: 'jump-travel',
    segments,
    targetMessageId: null,
    channelMaxPosition: options.latestPosition,
    unreadSeparatorAfter: null,
  }
}

function buildJumpResultState(
  baseMessages: DtoMessage[],
  targetMessages: DtoMessage[],
  options: {
    direction: MessageTimelineGapDirection
    targetMessageId: string
    latestPosition?: number
    knownLatestId?: string
    targetOlderHasMoreFallback: boolean
    targetNewerHasMoreFallback: boolean
    preserveOlderGap: boolean
    preserveNewerGap: boolean
  },
): TimelineState {
  const normalizedBase = normalizeMessages(baseMessages)
  const normalizedTarget = normalizeMessages(targetMessages)

  if (normalizedBase.length === 0) {
    return buildSingleIslandState(normalizedTarget, {
      mode: 'history-browse',
      targetMessageId: options.targetMessageId,
      latestPosition: options.latestPosition,
      olderHasMoreFallback: options.targetOlderHasMoreFallback,
      newerHasMoreFallback: options.targetNewerHasMoreFallback,
      knownLatestId: options.knownLatestId,
    })
  }

  const olderMessages = options.direction === 'older' ? normalizedTarget : normalizedBase
  const newerMessages = options.direction === 'older' ? normalizedBase : normalizedTarget
  const hasOlderGap = options.direction === 'older'
    ? shouldShowOlderGap(normalizedTarget, options.targetOlderHasMoreFallback)
    : options.preserveOlderGap
  const hasNewerGap = options.direction === 'older'
    ? options.preserveNewerGap
    : shouldShowNewerGap(normalizedTarget, {
        fallbackHasMore: options.targetNewerHasMoreFallback,
        latestPosition: options.latestPosition,
        knownLatestId: options.knownLatestId,
      })

  if (canMergeLoadedRanges(olderMessages, newerMessages)) {
    const merged = mergeUniqueMessages(olderMessages, newerMessages)
    const segments: TimelineSegment[] = []

    if (hasOlderGap && merged.length > 0) {
      segments.push(buildOlderEdgeGap(merged))
    }
    if (merged.length > 0) {
      segments.push(buildLoadedSegment(merged, 'loaded:merged'))
    }
    if (hasNewerGap && merged.length > 0) {
      segments.push(buildNewerEdgeGap(merged, options.latestPosition))
    }

    return {
      mode: 'history-browse',
      segments,
      targetMessageId: options.targetMessageId,
      channelMaxPosition: options.latestPosition,
      unreadSeparatorAfter: null,
    }
  }

  const segments: TimelineSegment[] = []
  if (hasOlderGap && olderMessages.length > 0) {
    segments.push(buildOlderEdgeGap(olderMessages))
  }
  if (olderMessages.length > 0) {
    segments.push(buildLoadedSegment(olderMessages, 'loaded:older'))
  }
  if (olderMessages.length > 0 && newerMessages.length > 0) {
    segments.push(buildBetweenGap(
      olderMessages,
      newerMessages,
      options.direction === 'older' ? 'newer' : 'older',
    ))
  }
  if (newerMessages.length > 0) {
    segments.push(buildLoadedSegment(newerMessages, 'loaded:newer'))
  }
  if (hasNewerGap && newerMessages.length > 0) {
    segments.push(buildNewerEdgeGap(newerMessages, options.latestPosition))
  }

  return {
    mode: 'history-browse',
    segments,
    targetMessageId: options.targetMessageId,
    channelMaxPosition: options.latestPosition,
    unreadSeparatorAfter: null,
  }
}

function buildTimelineRows(
  state: TimelineState | null,
  messages: DtoMessage[],
  pendingMessages: PendingMessage[],
  messageRowKeys: Record<string, string>,
): MessageTimelineRow[] {
  if (!state) return []

  const messageMap = new Map(
    messages
      .filter((message) => message.id != null)
      .map((message) => [String(message.id), message] as const),
  )
  const confirmedPendingByMessageId = new Map(
    pendingMessages
      .filter((pendingMessage) => pendingMessage.message.id != null)
      .map((pendingMessage) => [String(pendingMessage.message.id), pendingMessage] as const),
  )
  const renderedPendingLocalIds = new Set<string>()

  const rows: MessageTimelineRow[] = []
  let previousRenderableMessage:
    | { message: DtoMessage; createdAt?: number; dayLabel: string }
    | null = null
  const firstSegment = state.segments.find((segment) => segment.type === 'loaded')
  const showConversationStart = state.segments.length === 0 ||
    (state.segments[0]?.type !== 'gap' && firstSegment != null)

  if (showConversationStart) {
    rows.push({
      kind: 'conversation-start',
      key: 'conversation-start',
    })
  }

  state.segments.forEach((segment) => {
    if (segment.type === 'gap') {
      const approxMissingCount =
        segment.startPosition != null && segment.endPosition != null
          ? Math.max(0, segment.endPosition - segment.startPosition + 1)
          : undefined

      rows.push({
        kind: 'gap',
        key: segment.key,
        direction: segment.direction,
        gapKind: segment.gapKind,
        status: segment.status,
        approxMissingCount,
        heightPx: segment.heightPx,
      })
      previousRenderableMessage = null
      return
    }

    const segmentMessages = materializeSegmentMessages(segment, messageMap)
    segmentMessages.forEach((message) => {
      const messageId = message.id != null ? String(message.id) : null
      const confirmedPending = messageId != null
        ? confirmedPendingByMessageId.get(messageId)
        : undefined
      const rowMessage = confirmedPending?.message ?? message
      const rowMessageId = rowMessage.id != null ? String(rowMessage.id) : null
      if (confirmedPending) {
        renderedPendingLocalIds.add(confirmedPending.localId)
      }

      const dayLabel = getMessageDayLabel(rowMessage)
      const localPreviousMessage = previousRenderableMessage
      const shouldShowDivider = !localPreviousMessage || dayLabel !== localPreviousMessage.dayLabel

      if (shouldShowDivider) {
        rows.push({
          kind: 'date-divider',
          key: rowMessageId != null ? `date:${rowMessageId}` : 'date:unknown',
          label: dayLabel,
        })
      }

      if (
        localPreviousMessage?.message.id != null &&
        state.unreadSeparatorAfter != null &&
        String(localPreviousMessage.message.id) === state.unreadSeparatorAfter
      ) {
        rows.push({
          kind: 'unread-separator',
          key: `unread:${state.unreadSeparatorAfter}`,
        })
      }

      rows.push({
        kind: 'message',
        key: rowMessageId != null
          ? (messageRowKeys[rowMessageId] ?? getMessageRowKey(rowMessageId))
          : getMessageRowKey('unknown'),
        message: rowMessage,
        grouped: localPreviousMessage
          ? isGroupedWith(rowMessage, localPreviousMessage.message, {
              previousCreatedAt: localPreviousMessage.createdAt,
            })
          : false,
      })

      previousRenderableMessage = { message: rowMessage, dayLabel }
    })
  })

  pendingMessages.forEach((pendingMessage) => {
    if (renderedPendingLocalIds.has(pendingMessage.localId)) return

    const isConfirmed = pendingMessage.status === 'confirmed' && pendingMessage.message.id != null
    const deliveryState: 'sending' | 'failed' | undefined = isConfirmed
      ? undefined
      : pendingMessage.status === 'failed'
        ? 'failed'
        : 'sending'
    const optimisticCreatedAt = isConfirmed ? undefined : pendingMessage.createdAt
    const dayLabel = getMessageDayLabel(pendingMessage.message, optimisticCreatedAt)
    const localPreviousMessage = previousRenderableMessage
    const shouldShowDivider = !localPreviousMessage || dayLabel !== localPreviousMessage.dayLabel

    if (shouldShowDivider) {
      rows.push({
        kind: 'date-divider',
        key: `date:pending:${pendingMessage.localId}`,
        label: dayLabel,
      })
    }

    rows.push({
      kind: 'message',
      key: `pending:${pendingMessage.localId}`,
      message: pendingMessage.message,
      grouped: localPreviousMessage
        ? isGroupedWith(pendingMessage.message, localPreviousMessage.message, {
            currentCreatedAt: optimisticCreatedAt,
            previousCreatedAt: localPreviousMessage.createdAt,
          })
        : false,
      pendingLocalId: deliveryState != null ? pendingMessage.localId : undefined,
      deliveryState,
      pendingAttachmentDrafts: deliveryState != null ? pendingMessage.attachmentDrafts : undefined,
      optimisticCreatedAt,
    })

    previousRenderableMessage = {
      message: pendingMessage.message,
      createdAt: optimisticCreatedAt,
      dayLabel,
    }
  })

  return rows
}

function findGapContext(segments: TimelineSegment[], gapKey: string) {
  const gapIndex = segments.findIndex((segment) => segment.type === 'gap' && segment.key === gapKey)
  if (gapIndex < 0) return null

  let previousLoadedIndex = -1
  for (let index = gapIndex - 1; index >= 0; index -= 1) {
    if (segments[index]?.type === 'loaded') {
      previousLoadedIndex = index
      break
    }
  }

  let nextLoadedIndex = -1
  for (let index = gapIndex + 1; index < segments.length; index += 1) {
    if (segments[index]?.type === 'loaded') {
      nextLoadedIndex = index
      break
    }
  }

  return {
    gapIndex,
    gap: segments[gapIndex] as GapTimelineSegment,
    previousLoadedIndex,
    nextLoadedIndex,
  }
}

function replaceSegmentAt<T>(items: T[], index: number, nextItem: T): T[] {
  const nextItems = [...items]
  nextItems[index] = nextItem
  return nextItems
}

function determineJumpDirection(
  request: JumpRequest,
  materializedMessages: DtoMessage[],
): MessageTimelineGapDirection {
  if (materializedMessages.length === 0) return 'older'

  const oldestMessage = getOldestMessage(materializedMessages)
  const newestMessage = getNewestMessage(materializedMessages)
  const oldestPosition = getBoundaryPosition(oldestMessage)
  const newestPosition = getBoundaryPosition(newestMessage)

  if (request.positionHint != null) {
    if (oldestPosition != null && request.positionHint < oldestPosition) {
      return 'older'
    }
    if (newestPosition != null && request.positionHint > newestPosition) {
      return 'newer'
    }
  }

  if (oldestMessage?.id != null && compareSnowflakes(request.messageId, oldestMessage.id) < 0) {
    return 'older'
  }

  return 'newer'
}

async function fetchLatestWindow(
  channelId: string,
  signal?: AbortSignal,
): Promise<{ messages: DtoMessage[]; latestPosition?: number; olderHasMoreFallback: boolean }> {
  const response = await messageApi.messageChannelChannelIdGet({
    channelId: channelId as unknown as number,
    limit: PAGE_SIZE,
  }, { signal })

  const normalizedMessages = normalizeMessages(response.data ?? [])
  const newestPosition = getBoundaryPosition(getNewestMessage(normalizedMessages))

  return {
    messages: normalizedMessages,
    latestPosition: newestPosition,
    olderHasMoreFallback: normalizedMessages.length >= PAGE_SIZE,
  }
}

async function fetchJumpContext(
  channelId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<JumpContextResult> {
  const halfLimit = Math.max(2, Math.floor(JUMP_WINDOW_SIZE / 2))

  const [aroundResponse, latestResponse] = await Promise.all([
    messageApi.messageChannelChannelIdGet({
      channelId: channelId as unknown as number,
      from: messageId as unknown as number,
      direction: 'around',
      limit: JUMP_WINDOW_SIZE,
    }, { signal }),
    messageApi.messageChannelChannelIdGet({
      channelId: channelId as unknown as number,
      limit: SMALL_FETCH_PAGE_SIZE,
    }, { signal }),
  ])

  const messages = normalizeMessages(aroundResponse.data ?? [])
  if (!hasMessageId(messages, messageId)) {
    throw new Error(`Jump target ${messageId} was not returned by context fetch`)
  }

  const targetIdx = messages.findIndex((m) => String(m.id) === messageId)
  const olderCount = targetIdx
  const newerCount = messages.length - targetIdx - 1

  const latestMessages = normalizeMessages(latestResponse.data ?? [])
  return {
    messages,
    latestPosition: getBoundaryPosition(getNewestMessage(latestMessages)),
    olderHasMoreFallback: olderCount >= halfLimit,
    newerHasMoreFallback: newerCount >= halfLimit,
  }
}

function applyGapBatchToState(
  currentState: TimelineState,
  gapKey: string,
  batch: DtoMessage[],
  options: {
    exhaustedByCount: boolean
    latestPosition?: number
    knownLatestId?: string
    messageMap: Map<string, DtoMessage>
  },
): TimelineState {
  const context = findGapContext(currentState.segments, gapKey)
  if (!context) return currentState

  const { gap, gapIndex, previousLoadedIndex, nextLoadedIndex } = context
  const segments = [...currentState.segments]

  if (gap.direction === 'older') {
    if (nextLoadedIndex < 0) return currentState

    const nextLoaded = segments[nextLoadedIndex] as LoadedTimelineSegment
    const nextMessages = mergeUniqueMessages(
      batch,
      materializeSegmentMessages(nextLoaded, options.messageMap),
    )
    const previousMessages = previousLoadedIndex >= 0
      ? materializeSegmentMessages(segments[previousLoadedIndex] as LoadedTimelineSegment, options.messageMap)
      : EMPTY_MESSAGES

    if (previousLoadedIndex >= 0 && canMergeLoadedRanges(previousMessages, nextMessages)) {
      const mergedMessages = mergeUniqueMessages(previousMessages, nextMessages)
      const rebuiltSegments = [
        ...segments.slice(0, previousLoadedIndex),
        buildLoadedSegment(mergedMessages, 'loaded:merged'),
        ...segments.slice(nextLoadedIndex + 1),
      ]

      return {
        ...currentState,
        mode: currentState.mode === 'live-tail' ? 'history-browse' : currentState.mode,
        segments: rebuiltSegments,
      }
    }

    const reachedEdge =
      options.exhaustedByCount ||
      hasReachedHistoryStart(getBoundaryPosition(getOldestMessage(nextMessages)))
    const nextSegments = replaceSegmentAt(
      segments,
      nextLoadedIndex,
      buildLoadedSegment(nextMessages, 'loaded:older-fill'),
    )

    if (previousLoadedIndex < 0) {
      return {
        ...currentState,
        mode: currentState.mode === 'live-tail' ? 'history-browse' : currentState.mode,
        segments: reachedEdge
          ? nextSegments.filter((segment) => segment.key !== gap.key)
          : replaceSegmentAt(nextSegments, gapIndex, buildOlderEdgeGap(nextMessages)),
      }
    }

    return {
      ...currentState,
      segments: replaceSegmentAt(
        nextSegments,
        gapIndex,
        buildBetweenGap(previousMessages, nextMessages, 'older'),
      ),
    }
  }

  if (previousLoadedIndex < 0) return currentState

  const previousLoaded = segments[previousLoadedIndex] as LoadedTimelineSegment
  const previousMessages = mergeUniqueMessages(
    materializeSegmentMessages(previousLoaded, options.messageMap),
    batch,
  )
  const nextMessages = nextLoadedIndex >= 0
    ? materializeSegmentMessages(segments[nextLoadedIndex] as LoadedTimelineSegment, options.messageMap)
    : EMPTY_MESSAGES

  if (nextLoadedIndex >= 0 && canMergeLoadedRanges(previousMessages, nextMessages)) {
    const mergedMessages = mergeUniqueMessages(previousMessages, nextMessages)
    const rebuiltSegments = [
      ...segments.slice(0, previousLoadedIndex),
      buildLoadedSegment(mergedMessages, 'loaded:merged'),
      ...segments.slice(nextLoadedIndex + 1),
    ]

    return {
      ...currentState,
      segments: rebuiltSegments,
    }
  }

  const newestMessage = getNewestMessage(previousMessages)
  const newestPosition = getBoundaryPosition(newestMessage)
  const reachedLatest =
    options.exhaustedByCount ||
    (
      newestPosition != null &&
      options.latestPosition != null &&
      newestPosition >= options.latestPosition
    ) ||
    (
      newestMessage?.id != null &&
      options.knownLatestId != null &&
      compareSnowflakes(newestMessage.id, options.knownLatestId) >= 0
    )
  const nextSegments = replaceSegmentAt(
    segments,
    previousLoadedIndex,
    buildLoadedSegment(previousMessages, 'loaded:newer-fill'),
  )

  if (nextLoadedIndex < 0) {
    return {
      ...currentState,
      segments: reachedLatest
        ? nextSegments.filter((segment) => segment.key !== gap.key)
        : replaceSegmentAt(nextSegments, gapIndex, buildNewerEdgeGap(previousMessages, options.latestPosition)),
    }
  }

  return {
    ...currentState,
    segments: replaceSegmentAt(
      nextSegments,
      gapIndex,
      buildBetweenGap(previousMessages, nextMessages, 'newer'),
    ),
  }
}

export function useMessagePagination(
  channelId: string | undefined,
  jumpRequest?: JumpRequest | null,
  channelLastMessageId?: string,
): MessagePaginationState {
  const [isLoadingInitial, setIsLoadingInitial] = useState(false)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [isLoadingNewer, setIsLoadingNewer] = useState(false)
  const [timelineState, setTimelineState] = useState<TimelineState | null>(null)
  const [timelineChannelId, setTimelineChannelId] = useState<string | null>(channelId ?? null)
  const [focusTargetRowKey, setFocusTargetRowKey] = useState<string | null>(null)

  const applyTimelineSnapshot = useCallback((
    cid: string,
    nextTimelineState: TimelineState | null,
    nextFocusTargetRowKey: string | null,
  ) => {
    setTimelineChannelId(cid)
    setFocusTargetRowKey(nextFocusTargetRowKey)
    setTimelineState(nextTimelineState)
  }, [])

  const setMessages = useMessageStore((s) => s.setMessages)
  const messages = useMessageStore((s) =>
    channelId ? (s.messages[channelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  )
  const pendingMessages = useMessageStore((s) =>
    channelId ? (s.pendingMessages[channelId] ?? EMPTY_PENDING_MESSAGES) : EMPTY_PENDING_MESSAGES,
  )
  const messageRowKeys = useMessageStore((s) =>
    channelId ? (s.messageRowKeys[channelId] ?? EMPTY_MESSAGE_ROW_KEYS) : EMPTY_MESSAGE_ROW_KEYS,
  )
  const ackChannel = useReadStateStore((s) => s.ackChannel)
  const updateLastMessage = useReadStateStore((s) => s.updateLastMessage)
  const lastReadId = useReadStateStore((s) =>
    channelId ? s.readStates[channelId] : undefined,
  )
  const cachedLastMessageId = useReadStateStore((s) =>
    channelId ? s.lastMessages[channelId] : undefined,
  )

  const knownLatestMessageId = maxSnowflake(channelLastMessageId, cachedLastMessageId)

  const activeTimelineState = timelineChannelId === channelId ? timelineState : null
  const activeFocusTargetRowKey = timelineChannelId === channelId ? focusTargetRowKey : null
  const prevRowMapRef = useRef<Map<string, MessageTimelineRow>>(new Map())
  const rows = useMemo(() => {
    const newRows = buildTimelineRows(activeTimelineState, messages, pendingMessages, messageRowKeys)
    // Stabilize row object references so memo(ListItem) can skip unchanged rows.
    // buildTimelineRows always creates new wrapper objects even for unchanged messages;
    // reusing the previous object when content is identical prevents all ~50 visible
    // items from re-rendering on every incoming WS message.
    const prevMap = prevRowMapRef.current
    const stabilized = newRows.map((row) => {
      const prev = prevMap.get(row.key)
      if (!prev || prev.kind !== row.kind) return row
      const entries = Object.entries(row) as [string, unknown][]
      if (entries.length !== Object.keys(prev).length) return row
      const unchanged = entries.every(([k, v]) => (prev as unknown as Record<string, unknown>)[k] === v)
      return unchanged ? prev : row
    })
    prevRowMapRef.current = new Map(stabilized.map((r) => [r.key, r]))
    return stabilized
  }, [activeTimelineState, messageRowKeys, messages, pendingMessages])
  const mode = activeTimelineState?.mode ?? 'live-tail'
  const activeTargetMessageId =
    jumpRequest?.messageId ??
    (activeTimelineState?.mode === 'history-browse'
      ? (activeTimelineState.targetMessageId ?? null)
      : null)
  const jumpTargetRowKey = activeTargetMessageId ? getMessageRowKey(activeTargetMessageId) : null
  const resolvedIsLoadingInitial = channelId != null && timelineChannelId !== channelId
    ? true
    : isLoadingInitial

  const channelIdRef = useRef(channelId)
  const messagesRef = useRef(messages)
  const timelineStateRef = useRef(timelineState)
  const isLoadingInitialRef = useRef(isLoadingInitial)
  const knownLatestMessageIdRef = useRef(knownLatestMessageId)
  const lastReadIdRef = useRef(lastReadId)
  const navigationFetchRef = useRef<AbortController | null>(null)
  const gapFetchesRef = useRef<Record<string, FetchState>>({})
  const previousChannelIdRef = useRef<string | undefined>(undefined)
  const lastHandledJumpRef = useRef<string | undefined>(undefined)

  channelIdRef.current = channelId
  messagesRef.current = messages
  timelineStateRef.current = timelineState
  isLoadingInitialRef.current = isLoadingInitial
  knownLatestMessageIdRef.current = knownLatestMessageId
  lastReadIdRef.current = lastReadId

  useEffect(() => {
    if (!channelId || !channelLastMessageId) return
    updateLastMessage(channelId, channelLastMessageId)
  }, [channelId, channelLastMessageId, updateLastMessage])

  const loadLatestWindow = useCallback(async (cid: string, signal?: AbortSignal) => {
    const latestWindow = await fetchLatestWindow(cid, signal)
    if (signal?.aborted || channelIdRef.current !== cid) return

    const unreadSeparatorAfter = resolveUnreadSeparatorAfter(
      latestWindow.messages,
      lastReadIdRef.current,
      knownLatestMessageIdRef.current,
    )

    setMessages(cid, latestWindow.messages)
    applyTimelineSnapshot(cid, buildSingleIslandState(latestWindow.messages, {
      mode: 'live-tail',
      latestPosition: latestWindow.latestPosition,
      unreadSeparatorAfter,
      olderHasMoreFallback: latestWindow.olderHasMoreFallback,
      newerHasMoreFallback: false,
      knownLatestId: knownLatestMessageIdRef.current,
    }), null)
  }, [applyTimelineSnapshot, setMessages])

  const loadInitialWindow = useCallback(async (cid: string, signal?: AbortSignal) => {
    const lastReadMessageId = lastReadIdRef.current
    const knownLatestId = knownLatestMessageIdRef.current

    if (lastReadMessageId && shouldResumeFromLastRead(lastReadMessageId, knownLatestId)) {
      try {
        const readStateWindow = await fetchJumpContext(cid, lastReadMessageId, signal)
        if (signal?.aborted || channelIdRef.current !== cid) return

        setMessages(cid, readStateWindow.messages)
        applyTimelineSnapshot(cid, buildSingleIslandState(readStateWindow.messages, {
          mode: 'history-browse',
          latestPosition: readStateWindow.latestPosition,
          unreadSeparatorAfter: resolveUnreadSeparatorAfter(
            readStateWindow.messages,
            lastReadMessageId,
            knownLatestId,
          ),
          olderHasMoreFallback: readStateWindow.olderHasMoreFallback,
          newerHasMoreFallback: readStateWindow.newerHasMoreFallback,
          knownLatestId,
        }), getMessageRowKey(lastReadMessageId))
        return
      } catch (error) {
        if (signal?.aborted || isRequestCanceled(error)) {
          throw error
        }
      }
    }
    await loadLatestWindow(cid, signal)
  }, [applyTimelineSnapshot, loadLatestWindow, setMessages])

  const performJumpLoad = useCallback(async (
    cid: string,
    request: JumpRequest,
    options: {
      baseMessages: DtoMessage[]
      previousState: TimelineState | null
      showRunway: boolean
    },
  ) => {
    navigationFetchRef.current?.abort()
    const controller = new AbortController()
    navigationFetchRef.current = controller
    setFocusTargetRowKey(null)

    if (options.showRunway && options.baseMessages.length > 0) {
      const direction = determineJumpDirection(request, options.baseMessages)
      applyTimelineSnapshot(cid, buildRunwayState(options.baseMessages, {
        direction,
        requestKey: request.requestKey,
        preserveOlderGap: hasEdgeGap(options.previousState, 'older'),
        preserveNewerGap: hasEdgeGap(options.previousState, 'newer'),
        latestPosition: options.previousState?.channelMaxPosition,
      }), null)
    } else {
      applyTimelineSnapshot(cid, null, null)
      setIsLoadingInitial(true)
    }

    try {
      const jumpContext = await fetchJumpContext(cid, request.messageId, controller.signal)
      if (controller.signal.aborted || channelIdRef.current !== cid) return

      const nextMessages = mergeUniqueMessages(options.baseMessages, jumpContext.messages)
      const direction = determineJumpDirection(request, options.baseMessages)
      const nextState = buildJumpResultState(options.baseMessages, jumpContext.messages, {
        direction,
        targetMessageId: request.messageId,
        latestPosition: jumpContext.latestPosition,
        knownLatestId: knownLatestMessageIdRef.current,
        targetOlderHasMoreFallback: jumpContext.olderHasMoreFallback,
        targetNewerHasMoreFallback: jumpContext.newerHasMoreFallback,
        preserveOlderGap: hasEdgeGap(options.previousState, 'older'),
        preserveNewerGap: hasEdgeGap(options.previousState, 'newer'),
      })

      setMessages(cid, nextMessages)
      applyTimelineSnapshot(cid, nextState, null)
    } finally {
      if (!controller.signal.aborted && channelIdRef.current === cid) {
        setIsLoadingInitial(false)
      }
    }
  }, [applyTimelineSnapshot, setMessages])

  useEffect(() => {
    if (!channelId) {
      setTimelineChannelId(null)
      setTimelineState(null)
      setFocusTargetRowKey(null)
      setIsLoadingInitial(false)
      return
    }

    const cid = channelId
    const requestedJump = jumpRequest ?? null
    const channelChanged = previousChannelIdRef.current !== cid
    previousChannelIdRef.current = cid
    const currentState = timelineStateRef.current
    const currentMessageMap = new Map(
      messagesRef.current
        .filter((message) => message.id != null)
        .map((message) => [String(message.id), message] as const),
    )

    const isNewJump = requestedJump?.requestKey !== undefined &&
      requestedJump.requestKey !== lastHandledJumpRef.current

    if (!channelChanged && !isNewJump && (currentState || isLoadingInitialRef.current)) {
      return
    }

    if (requestedJump && isNewJump) {
      lastHandledJumpRef.current = requestedJump.requestKey
    }

    if (channelChanged) {
      setFocusTargetRowKey(null)
    }

    navigationFetchRef.current?.abort()
    Object.values(gapFetchesRef.current).forEach((fetchState) => fetchState.controller.abort())
    gapFetchesRef.current = {}
    setIsLoadingOlder(false)
    setIsLoadingNewer(false)
    if (requestedJump) {
      setFocusTargetRowKey(null)
    }

    if (requestedJump && !channelChanged && currentState) {
      const materializedMessages = collectMaterializedMessages(currentState.segments, currentMessageMap)
      if (hasMessageId(materializedMessages, requestedJump.messageId)) {
        setTimelineChannelId(cid)
        setTimelineState((existing) => existing
          ? {
              ...existing,
              mode: existing.mode === 'jump-travel' ? 'history-browse' : existing.mode,
              targetMessageId: requestedJump.messageId,
            }
          : existing)
        setIsLoadingInitial(false)
        return
      }

      void performJumpLoad(cid, requestedJump, {
        baseMessages: EMPTY_MESSAGES,
        previousState: null,
        showRunway: false,
      }).catch((error) => {
        if (!isRequestCanceled(error) && channelIdRef.current === cid) {
          applyTimelineSnapshot(cid, currentState, null)
          setIsLoadingInitial(false)
        }
      })
      return
    }

    if (requestedJump) {
      void performJumpLoad(cid, requestedJump, {
        baseMessages: EMPTY_MESSAGES,
        previousState: null,
        showRunway: false,
      }).catch((error) => {
        if (!isRequestCanceled(error) && channelIdRef.current === cid) {
          applyTimelineSnapshot(cid, {
            mode: 'history-browse',
            segments: [],
            targetMessageId: null,
            channelMaxPosition: undefined,
            unreadSeparatorAfter: null,
          }, null)
          setIsLoadingInitial(false)
        }
      })
      return
    }

    const controller = new AbortController()
    navigationFetchRef.current = controller
    setIsLoadingInitial(true)
    applyTimelineSnapshot(cid, null, null)

    void loadInitialWindow(cid, controller.signal)
      .catch((error) => {
        if (!controller.signal.aborted && !isRequestCanceled(error) && channelIdRef.current === cid) {
          applyTimelineSnapshot(cid, null, null)
        }
      })
      .finally(() => {
        if (!controller.signal.aborted && channelIdRef.current === cid) {
          setIsLoadingInitial(false)
        }
      })

    return () => {
      controller.abort()
    }
  }, [applyTimelineSnapshot, channelId, jumpRequest, loadInitialWindow, performJumpLoad])

  useLayoutEffect(() => {
    if (!timelineState || timelineState.mode !== 'live-tail') return
    if (!channelId) return

    const messageMap = new Map(
      messages
        .filter((message) => message.id != null)
        .map((message) => [String(message.id), message] as const),
    )
    const loadedSegments = timelineState.segments.filter(
      (segment): segment is LoadedTimelineSegment => segment.type === 'loaded',
    )
    if (loadedSegments.length === 0) {
      if (messages.length === 0) return

      setTimelineChannelId(channelId)
      setTimelineState(buildSingleIslandState(messages, {
        mode: 'live-tail',
        latestPosition: Math.max(
          timelineState.channelMaxPosition ?? getBoundaryPosition(getNewestMessage(messages)) ?? 0,
          getBoundaryPosition(getNewestMessage(messages)) ?? 0,
        ) || undefined,
        unreadSeparatorAfter: resolveUnreadSeparatorAfter(
          messages,
          lastReadIdRef.current,
          knownLatestMessageId,
        ),
        olderHasMoreFallback: hasEdgeGap(timelineState, 'older'),
        newerHasMoreFallback: false,
        knownLatestId: knownLatestMessageId,
      }))
      return
    }
    if (loadedSegments.length !== 1) return

    const loadedMessages = materializeSegmentMessages(loadedSegments[0], messageMap)
    if (loadedMessages.length === 0) {
      if (messages.length === 0) return

      setTimelineChannelId(channelId)
      setTimelineState(buildSingleIslandState(messages, {
        mode: 'live-tail',
        latestPosition: Math.max(
          timelineState.channelMaxPosition ?? getBoundaryPosition(getNewestMessage(messages)) ?? 0,
          getBoundaryPosition(getNewestMessage(messages)) ?? 0,
        ) || undefined,
        unreadSeparatorAfter: resolveUnreadSeparatorAfter(
          messages,
          lastReadIdRef.current,
          knownLatestMessageId,
        ),
        olderHasMoreFallback: hasEdgeGap(timelineState, 'older'),
        newerHasMoreFallback: false,
        knownLatestId: knownLatestMessageId,
      }))
      return
    }

    const newestLoadedMessage = getNewestMessage(loadedMessages)
    const extraMessages = messages.filter((message) =>
      newestLoadedMessage?.id != null &&
      message.id != null &&
      compareSnowflakes(message.id, newestLoadedMessage.id) > 0,
    )
    if (extraMessages.length === 0) return

    const nextMessages = mergeUniqueMessages(loadedMessages, extraMessages)
    setTimelineChannelId(channelId)
    setTimelineState(buildSingleIslandState(nextMessages, {
      mode: 'live-tail',
      latestPosition: Math.max(
        timelineState.channelMaxPosition ?? getBoundaryPosition(getNewestMessage(nextMessages)) ?? 0,
        getBoundaryPosition(getNewestMessage(nextMessages)) ?? 0,
      ) || undefined,
      unreadSeparatorAfter: resolveUnreadSeparatorAfter(
        nextMessages,
        lastReadIdRef.current,
        knownLatestMessageId,
      ),
      olderHasMoreFallback: hasEdgeGap(timelineState, 'older'),
      newerHasMoreFallback: false,
      knownLatestId: knownLatestMessageId,
    }))
  }, [channelId, knownLatestMessageId, messages, timelineState])

  useEffect(() => {
    if (!timelineState || timelineState.mode !== 'history-browse') return
    if (!channelId) return

    // When there is no existing newer-edge gap the loaded window already covers
    // the latest messages.  New WS messages should be merged directly into the
    // loaded segment — just like the live-tail layout effect does — rather than
    // creating a gap that would trigger a redundant API fetch on every message.
    if (!hasEdgeGap(timelineState, 'newer')) {
      const messageMap = new Map(
        messages
          .filter((m) => m.id != null)
          .map((m) => [String(m.id), m] as const),
      )
      const loadedSegments = timelineState.segments.filter(
        (segment): segment is LoadedTimelineSegment => segment.type === 'loaded',
      )
      if (loadedSegments.length === 1) {
        const loadedMessages = materializeSegmentMessages(loadedSegments[0], messageMap)
        const newestLoaded = getNewestMessage(loadedMessages)
        if (newestLoaded != null) {
          const extraMessages = messages.filter(
            (m) => m.id != null && compareSnowflakes(m.id, newestLoaded.id) > 0,
          )
          if (extraMessages.length > 0) {
            const nextMessages = mergeUniqueMessages(loadedMessages, extraMessages)
            const latestPosition = Math.max(
              timelineState.channelMaxPosition ?? getBoundaryPosition(getNewestMessage(nextMessages)) ?? 0,
              getBoundaryPosition(getNewestMessage(nextMessages)) ?? 0,
            ) || undefined
            setTimelineChannelId(channelId)
            setTimelineState(buildSingleIslandState(nextMessages, {
              mode: 'history-browse',
              targetMessageId: timelineState.targetMessageId,
              latestPosition,
              unreadSeparatorAfter: timelineState.unreadSeparatorAfter,
              olderHasMoreFallback: hasEdgeGap(timelineState, 'older'),
              newerHasMoreFallback: false,
              knownLatestId: knownLatestMessageId,
            }))
            return
          }
        }
      }
    }

    const nextState = syncHistoryBrowseNewerGap(
      timelineState,
      messages,
      knownLatestMessageId,
    )

    if (nextState === timelineState) return

    setTimelineChannelId(channelId)
    setTimelineState(nextState)
  }, [channelId, knownLatestMessageId, messages, timelineState])

  useEffect(() => {
    if (!timelineState) return

    const messageMap = new Map(
      messages
        .filter((message) => message.id != null)
        .map((message) => [String(message.id), message] as const),
    )
    const materializedMessages = collectMaterializedMessages(timelineState.segments, messageMap)
    const nextUnreadSeparatorAfter = resolveUnreadSeparatorAfter(
      materializedMessages,
      lastReadId,
      knownLatestMessageId,
    )

    if (nextUnreadSeparatorAfter === timelineState.unreadSeparatorAfter) return

    setTimelineState((existing) => existing
      ? {
          ...existing,
          unreadSeparatorAfter: nextUnreadSeparatorAfter,
        }
      : existing)
  }, [knownLatestMessageId, lastReadId, messages, timelineState])

  const loadGap = useCallback((gapKey: string) => {
    const cid = channelIdRef.current
    const currentState = timelineStateRef.current
    if (!cid || !currentState) return

    const context = findGapContext(currentState.segments, gapKey)
    if (!context) return
    const { gap, previousLoadedIndex, nextLoadedIndex } = context
    if (gap.status === 'loading') return
    if (gapFetchesRef.current[gapKey]) return

    const messageMap = new Map(
      messagesRef.current
        .filter((message) => message.id != null)
        .map((message) => [String(message.id), message] as const),
    )

    let pivotId: string | null = null
    if (gap.direction === 'older' && nextLoadedIndex >= 0) {
      const nextLoaded = currentState.segments[nextLoadedIndex] as LoadedTimelineSegment
      const nextMessages = materializeSegmentMessages(nextLoaded, messageMap)
      pivotId = nextMessages[0]?.id != null ? String(nextMessages[0].id) : null
    } else if (gap.direction === 'newer' && previousLoadedIndex >= 0) {
      const previousLoaded = currentState.segments[previousLoadedIndex] as LoadedTimelineSegment
      const previousMessages = materializeSegmentMessages(previousLoaded, messageMap)
      const newestMessage = getNewestMessage(previousMessages)
      pivotId = newestMessage?.id != null ? String(newestMessage.id) : null
    }

    if (!pivotId) return

    const controller = new AbortController()
    gapFetchesRef.current[gapKey] = { key: gapKey, controller }
    if (gap.direction === 'older') {
      setIsLoadingOlder(true)
    } else {
      setIsLoadingNewer(true)
    }

    setTimelineState((existing) => existing
      ? {
          ...existing,
          mode: existing.mode === 'live-tail' && gap.direction === 'older'
            ? 'history-browse'
            : existing.mode,
          segments: existing.segments.map((segment) => (
            segment.type === 'gap' && segment.key === gapKey
              ? { ...segment, status: 'loading' }
              : segment
          )),
        }
      : existing)

    void messageApi.messageChannelChannelIdGet({
      channelId: cid as unknown as number,
      from: pivotId as unknown as number,
      direction: gap.direction === 'older' ? 'before' : 'after',
      limit: PAGE_SIZE,
    }, { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted || channelIdRef.current !== cid) return

        const batch = normalizeMessages(response.data ?? [], {
          excludeIds: new Set([pivotId!]),
        })
        const nextStoreMessages = mergeUniqueMessages(messagesRef.current, batch)
        const nextMessageMap = new Map(
          nextStoreMessages
            .filter((message) => message.id != null)
            .map((message) => [String(message.id), message] as const),
        )

        setMessages(cid, nextStoreMessages)
        setTimelineState((existing) => {
          if (!existing) return existing

          return applyGapBatchToState(existing, gapKey, batch, {
            exhaustedByCount: (response.data ?? []).length < PAGE_SIZE,
            latestPosition: existing.channelMaxPosition,
            knownLatestId: knownLatestMessageIdRef.current,
            messageMap: nextMessageMap,
          })
        })
      })
      .catch((error) => {
        if (controller.signal.aborted || isRequestCanceled(error)) return

        setTimelineState((existing) => existing
          ? {
              ...existing,
              segments: existing.segments.map((segment) => (
                segment.type === 'gap' && segment.key === gapKey
                  ? { ...segment, status: 'error' }
                  : segment
              )),
            }
          : existing)
      })
      .finally(() => {
        delete gapFetchesRef.current[gapKey]
        if (!controller.signal.aborted) {
          if (gap.direction === 'older') {
            setIsLoadingOlder(false)
          } else {
            setIsLoadingNewer(false)
          }
        }
      })
  }, [setMessages])

  const loadOlder = useCallback(() => {
    const firstOlderGap = timelineStateRef.current?.segments.find((segment) =>
      segment.type === 'gap' && segment.direction === 'older',
    )
    if (firstOlderGap?.type === 'gap') {
      loadGap(firstOlderGap.key)
    }
  }, [loadGap])

  const loadNewer = useCallback(() => {
    const firstNewerGap = [...(timelineStateRef.current?.segments ?? [])].reverse().find((segment) =>
      segment.type === 'gap' && segment.direction === 'newer',
    )
    if (firstNewerGap?.type === 'gap') {
      loadGap(firstNewerGap.key)
    }
  }, [loadGap])

  const jumpToPresent = useCallback(() => {
    const cid = channelIdRef.current
    if (!cid) return

    navigationFetchRef.current?.abort()
    Object.values(gapFetchesRef.current).forEach((fetchState) => fetchState.controller.abort())
    gapFetchesRef.current = {}
    setIsLoadingOlder(false)
    setIsLoadingNewer(false)

    const controller = new AbortController()
    navigationFetchRef.current = controller
    setIsLoadingInitial(true)

    void loadLatestWindow(cid, controller.signal)
      .finally(() => {
        if (!controller.signal.aborted && channelIdRef.current === cid) {
          setIsLoadingInitial(false)
        }
      })
  }, [loadLatestWindow])

  const ackLatest = useCallback(() => {
    const cid = channelIdRef.current
    const currentState = timelineStateRef.current
    if (!cid || !currentState) return
    if (hasEdgeGap(currentState, 'newer')) return

    const materializedMessages = collectMaterializedMessages(
      currentState.segments,
      new Map(
        messagesRef.current
          .filter((message) => message.id != null)
          .map((message) => [String(message.id), message] as const),
      ),
    )
    const newestLoadedMessage = getNewestMessage(materializedMessages)

    // When the channel is empty (all messages deleted), fall back to the channel's
    // known latest message ID so the unread indicator is cleared.
    const nextReadMessageId = newestLoadedMessage?.id != null
      ? String(newestLoadedMessage.id)
      : knownLatestMessageIdRef.current
    if (!nextReadMessageId) return
    const currentReadMessageId = useReadStateStore.getState().readStates[cid]
    if (compareSnowflakes(nextReadMessageId, currentReadMessageId) <= 0) return

    ackChannel(cid, nextReadMessageId)
  }, [ackChannel])

  return {
    rows,
    mode,
    jumpTargetRowKey,
    focusTargetRowKey: activeFocusTargetRowKey,
    isLoadingInitial: resolvedIsLoadingInitial,
    isLoadingOlder,
    isLoadingNewer,
    loadGap,
    loadOlder,
    loadNewer,
    jumpToPresent,
    ackLatest,
  }
}
