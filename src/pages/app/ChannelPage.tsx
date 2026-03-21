import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
import { Hash, Spool, Volume2, Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Video, VideoOff, Users } from 'lucide-react'
import axios from 'axios'
import { Separator } from '@/components/ui/separator'
import { guildApi, messageApi, rolesApi, searchApi } from '@/api/client'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import { useVoiceStore } from '@/stores/voiceStore'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoGuild, DtoMessage } from '@/types'
import type { ServerOutletContext } from './ServerLayout'
import type { MentionResolver } from '@/lib/messageParser'
import MessageList from '@/components/chat/MessageList'
import ChatAttachmentDropZone from '@/components/chat/ChatAttachmentDropZone'
import MessageInput, { type MessageInputHandle } from '@/components/chat/MessageInput'
import MemberList from '@/components/layout/MemberList'
import SearchBar, { type SearchBarHandle, type AppliedFilter } from '@/components/chat/SearchBar'
import SearchPanel from '@/components/chat/SearchPanel'
import ThreadCreatePanel from '@/components/chat/ThreadCreatePanel'
import ThreadListPanel from '@/components/chat/ThreadListPanel'
import ThreadPanel from '@/components/chat/ThreadPanel'
import { activateChannel, deactivateChannel } from '@/services/wsService'
import { joinVoice, leaveVoice, setMuted, setDeafened, enableCamera, disableCamera } from '@/services/voiceService'
import { toast } from 'sonner'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import { useMessageStore } from '@/stores/messageStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { useUnreadStore } from '@/stores/unreadStore'
import TypingIndicator from '@/components/chat/TypingIndicator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import { useTranslation } from 'react-i18next'
import { calculateEffectivePermissions, hasPermission, PermissionBits } from '@/lib/permissions'
import { getTopRoleColor } from '@/lib/memberColors'
import { createJumpRequest, type JumpBehavior, type JumpRequest } from '@/lib/messageJump'
import { isAutoThreadFollowup, isThreadChannel, sortThreadsByActivity } from '@/lib/threads'
import { buildMessagePreviewText } from '@/lib/messagePreview'

type RightPanelMode = 'members' | 'none' | 'threads' | 'thread' | 'thread-create'
type NonThreadRightPanelMode = Exclude<RightPanelMode, 'threads' | 'thread' | 'thread-create'>
type RightPanelWidthKey = 'search' | 'members' | 'threads' | 'thread' | 'threadCreate'

interface ChannelPageLocationState {
  jumpToMessageId?: string
  jumpBehavior?: JumpBehavior
  jumpToMessagePosition?: number
  openThreadId?: string
  threadJumpToMessageId?: string
  threadJumpBehavior?: JumpBehavior
  threadJumpToMessagePosition?: number
}

interface MissingThreadLookupResult {
  thread: DtoChannel | null
  missing: boolean
}

const EMPTY_MESSAGES: DtoMessage[] = []
const THREAD_PREVIEW_FETCH_LIMIT = 20
const RIGHT_PANEL_WIDTH_STORAGE_KEY = 'channel-page.right-panel-widths'
const RIGHT_PANEL_WIDTH_KEYS: RightPanelWidthKey[] = [
  'search',
  'members',
  'threads',
  'thread',
  'threadCreate',
]
const DEFAULT_RIGHT_PANEL_WIDTHS: Record<RightPanelWidthKey, number> = {
  search: 320,
  members: 240,
  threads: 352,
  thread: 416,
  threadCreate: 352,
}

function getRightPanelMaxWidth(): number {
  if (typeof window === 'undefined') return 640
  return Math.max(260, Math.min(640, Math.floor(window.innerWidth * 0.7)))
}

function clampRightPanelWidth(width: number): number {
  return Math.min(Math.max(Math.round(width), 220), getRightPanelMaxWidth())
}

function loadRightPanelWidths(): Record<RightPanelWidthKey, number> {
  const defaults = { ...DEFAULT_RIGHT_PANEL_WIDTHS }
  if (typeof window === 'undefined') return defaults

  try {
    const raw = window.localStorage.getItem(RIGHT_PANEL_WIDTH_STORAGE_KEY)
    if (!raw) return defaults

    const parsed = JSON.parse(raw) as Partial<Record<RightPanelWidthKey, number>>
    return {
      search: clampRightPanelWidth(parsed.search ?? defaults.search),
      members: clampRightPanelWidth(parsed.members ?? defaults.members),
      threads: clampRightPanelWidth(parsed.threads ?? defaults.threads),
      thread: clampRightPanelWidth(parsed.thread ?? defaults.thread),
      threadCreate: clampRightPanelWidth(parsed.threadCreate ?? defaults.threadCreate),
    }
  } catch {
    return defaults
  }
}

function getRightPanelWidthKey(
  hasSearched: boolean,
  mode: RightPanelMode,
): RightPanelWidthKey {
  if (hasSearched) return 'search'
  if (mode === 'thread') return 'thread'
  if (mode === 'threads') return 'threads'
  if (mode === 'thread-create') return 'threadCreate'
  return 'members'
}

function isThreadRightPanelMode(mode: RightPanelMode): boolean {
  return mode === 'threads' || mode === 'thread' || mode === 'thread-create'
}

function toNonThreadRightPanelMode(mode: RightPanelMode): NonThreadRightPanelMode {
  return mode === 'members' ? 'members' : 'none'
}

function buildThreadPreviewText(
  message: DtoMessage | null | undefined,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  return buildMessagePreviewText(message, {
    emptyText: t('threads.previewEmpty'),
    embedsText: t('threads.previewEmbeds'),
    attachmentsText: (count) => t('threads.previewAttachments', { count }),
  })
}

function isThreadLookupNotFound(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 404
}

export default function ChannelPage() {
  const { channelId, serverId } = useParams<{ channelId: string; serverId: string }>()
  const { channels } = useOutletContext<ServerOutletContext>()
  const channel = channels.find((c) => String(c.id) === channelId)
  const isVoice = channel?.type === ChannelType.ChannelTypeGuildVoice
  const isTextChannel = channel?.type === ChannelType.ChannelTypeGuild

  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  useEffect(() => {
    if (channel?.name) {
      document.title = `#${channel.name} — GoChat`
    }
    return () => { document.title = 'GoChat' }
  }, [channel?.name])

  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('members')
  const [rightPanelModeBeforeThreads, setRightPanelModeBeforeThreads] =
    useState<NonThreadRightPanelMode>('members')
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [threadJumpRequest, setThreadJumpRequest] = useState<JumpRequest | null>(null)
  const [createThreadSource, setCreateThreadSource] = useState<DtoMessage | null>(null)
  const [replyTarget, setReplyTarget] = useState<DtoMessage | null>(null)
  const [rightPanelWidths, setRightPanelWidths] = useState<Record<RightPanelWidthKey, number>>(
    () => loadRightPanelWidths(),
  )

  // ── Search state ────────────────────────────────────────────────────────────
  const [searchResults, setSearchResults] = useState<DtoMessage[]>([])
  const [searchTotalPages, setSearchTotalPages] = useState(0)
  const [searchPage, setSearchPage] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const lastSearchParamsRef = useRef<{ chips: AppliedFilter[]; text: string } | null>(null)
  const searchBarRef = useRef<SearchBarHandle>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const rightPanelResizeCleanupRef = useRef<(() => void) | null>(null)

  // Jump-to-message from search.
  const locationState = location.state as ChannelPageLocationState | null
  const jumpIdFromState = locationState?.jumpToMessageId
  const jumpBehaviorFromState = locationState?.jumpBehavior ?? 'direct-scroll'
  const jumpPositionFromState = locationState?.jumpToMessagePosition ?? null
  const openThreadIdFromState = locationState?.openThreadId
  const threadJumpIdFromState = locationState?.threadJumpToMessageId
  const threadJumpBehaviorFromState = locationState?.threadJumpBehavior ?? 'direct-scroll'
  const threadJumpPositionFromState = locationState?.threadJumpToMessagePosition ?? null

  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)

  // Derive the jump request from location state synchronously (useMemo runs during render,
  // before any effects). This ensures useMessagePagination sees the jump on the same render
  // that channelId changes, preventing a spurious loadInitialWindow call.
  const locationStateJump = useMemo(
    () => jumpIdFromState
      ? createJumpRequest(jumpIdFromState, {
          behavior: jumpBehaviorFromState,
          positionHint: jumpPositionFromState,
        })
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jumpIdFromState], // stable while location state is unchanged; behavior/position change together
  )

  // The effective jump request: location state takes priority (cross-channel nav),
  // falling back to the state-based request (same-channel jumps via setJumpRequest).
  const effectiveJumpRequest = locationStateJump ?? jumpRequest

  useEffect(() => {
    if (!jumpIdFromState && !openThreadIdFromState && !threadJumpIdFromState) return
    // Copy the location-state jump into jumpRequest state so effectiveJumpRequest stays
    // non-null after location state is cleared (happens below via navigate).
    if (jumpIdFromState && locationStateJump) {
      setJumpRequest(locationStateJump)
    }
    if (openThreadIdFromState) {
      setRightPanelModeBeforeThreads((current) => (
        isThreadRightPanelMode(rightPanelMode) ? current : toNonThreadRightPanelMode(rightPanelMode)
      ))
      setActiveThreadId(openThreadIdFromState)
      setRightPanelMode('thread')
    }
    if (threadJumpIdFromState) {
      setThreadJumpRequest(
        createJumpRequest(threadJumpIdFromState, {
          behavior: threadJumpBehaviorFromState,
          positionHint: threadJumpPositionFromState,
        }),
      )
    }
    navigate(location.pathname, { replace: true, state: {} })
  }, [
    jumpIdFromState,
    locationStateJump,
    navigate,
    location.pathname,
    openThreadIdFromState,
    rightPanelMode,
    threadJumpBehaviorFromState,
    threadJumpIdFromState,
    threadJumpPositionFromState,
  ])

  const handleChannelJumpHandled = useCallback((requestKey: string) => {
    setJumpRequest((current) => current?.requestKey === requestKey ? null : current)
  }, [])

  const handleThreadJumpHandled = useCallback((requestKey: string) => {
    setThreadJumpRequest((current) => current?.requestKey === requestKey ? null : current)
  }, [])

  const {
    rows,
    mode,
    jumpTargetRowKey,
    focusTargetRowKey,
    isLoadingInitial,
    loadGap,
    jumpToPresent,
    ackLatest,
  } = useMessagePagination(
    isVoice ? undefined : channelId,
    effectiveJumpRequest,
    channel?.last_message_id != null ? String(channel.last_message_id) : undefined,
  )

  const voiceChannelId = useVoiceStore((s) => s.channelId)
  const voicePeers = useVoiceStore((s) => s.peers)
  const localMuted = useVoiceStore((s) => s.localMuted)
  const localDeafened = useVoiceStore((s) => s.localDeafened)
  const localSpeaking = useVoiceStore((s) => s.localSpeaking)
  const localCameraEnabled = useVoiceStore((s) => s.localCameraEnabled)
  const localVideoStream = useVoiceStore((s) => s.localVideoStream)

  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  // Reset spotlight when navigating away from a channel
  useEffect(() => { setSpotlightId(null) }, [channelId])

  const currentUser = useAuthStore((s) => s.user)
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find(
    (g) => String(g.id) === serverId,
  )

  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })
  const { data: roles } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () =>
      rolesApi.guildGuildIdRolesGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 60_000,
  })

  const currentMember = members?.find((m) => String(m.user?.id) === String(currentUser?.id))
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)
  const effectivePermissions = currentMember && roles
    ? calculateEffectivePermissions(currentMember, roles)
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const canCreateThreads = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.CREATE_THREADS)
  const canSendInThreads = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.SEND_MESSAGES_IN_THREADS)
  const canManageThreads = isOwner || isAdmin || hasPermission(effectivePermissions, PermissionBits.MANAGE_THREADS)

  const { data: threadListData = [], isLoading: isThreadsLoading } = useQuery({
    queryKey: ['channel-threads', serverId, channelId],
    queryFn: () =>
      guildApi.guildGuildIdChannelChannelIdThreadsGet({
        guildId: serverId!,
        channelId: channelId!,
      }).then((res) => res.data ?? []),
    enabled: !!serverId && !!channelId && isTextChannel,
    staleTime: 30_000,
  })

  const channelThreads = useMemo(
    () => sortThreadsByActivity(threadListData),
    [threadListData],
  )

  const activeThreadFromList = channelThreads.find((thread) => String(thread.id) === activeThreadId)
  const { data: directThreadChannel, isLoading: isActiveThreadLoading } = useQuery({
    queryKey: ['thread-channel', serverId, activeThreadId],
    queryFn: () =>
      guildApi.guildGuildIdChannelChannelIdGet({
        guildId: serverId!,
        channelId: activeThreadId!,
      }).then((res) => res.data),
    enabled: !!serverId && !!activeThreadId && !activeThreadFromList,
    staleTime: 30_000,
  })

  const activeThread = activeThreadFromList ?? (
    isThreadChannel(directThreadChannel) ? directThreadChannel : null
  )

  const channelMessages = useMessageStore((s) =>
    channelId ? (s.messages[channelId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  )
  const threadMessages = useMessageStore((s) => s.messages)

  const knownThreadById = useMemo(() => {
    const map = new Map<string, DtoChannel>()
    const addThread = (thread: DtoChannel | null | undefined) => {
      if (!isThreadChannel(thread) || thread.id == null) return
      map.set(String(thread.id), thread)
    }

    channelThreads.forEach(addThread)
    addThread(activeThread)
    channels.forEach(addThread)
    channelMessages.forEach((message) => addThread(message.thread))

    return map
  }, [activeThread, channelMessages, channelThreads, channels])

  const missingThreadLookupTargets = useMemo(() => {
    const ordered: string[] = []
    const seen = new Set<string>()

    channelMessages.forEach((message) => {
      const attachedThread = isThreadChannel(message.thread) ? message.thread : null
      const threadId = attachedThread?.id != null
        ? String(attachedThread.id)
        : message.thread_id != null
          ? String(message.thread_id)
          : null
      if (!threadId || attachedThread || knownThreadById.has(threadId) || seen.has(threadId)) return

      const channelThreadCandidate = channels.find((candidate) => String(candidate.id) === threadId)
      if (isThreadChannel(channelThreadCandidate)) return

      seen.add(threadId)
      ordered.push(threadId)
    })

    return ordered
  }, [channelMessages, channels, knownThreadById])

  const missingThreadLookupQueries = useQueries({
    queries: missingThreadLookupTargets.map((threadId) => ({
      queryKey: ['thread-link', serverId, threadId],
      queryFn: async (): Promise<MissingThreadLookupResult> => {
        try {
          const res = await guildApi.guildGuildIdChannelChannelIdGet({
            guildId: serverId!,
            channelId: threadId,
          })

          return {
            thread: isThreadChannel(res.data) ? res.data : null,
            missing: false,
          }
        } catch (error) {
          if (isThreadLookupNotFound(error)) {
            return { thread: null, missing: true }
          }
          throw error
        }
      },
      enabled: !!serverId,
      retry: false,
      staleTime: 60_000,
    })),
  })

  const fetchedThreadById = useMemo(() => {
    const map = new Map<string, DtoChannel>()

    missingThreadLookupTargets.forEach((threadId, index) => {
      const result = missingThreadLookupQueries[index]?.data
      if (result?.thread) {
        map.set(threadId, result.thread)
      }
    })

    return map
  }, [missingThreadLookupQueries, missingThreadLookupTargets])

  const missingThreadIds = useMemo(() => {
    const ids = new Set<string>()

    missingThreadLookupTargets.forEach((threadId, index) => {
      if (missingThreadLookupQueries[index]?.data?.missing) {
        ids.add(threadId)
      }
    })

    return ids
  }, [missingThreadLookupQueries, missingThreadLookupTargets])

  const threadById = useMemo(() => {
    const map = new Map(knownThreadById)
    fetchedThreadById.forEach((thread, threadId) => {
      map.set(threadId, thread)
    })
    return map
  }, [fetchedThreadById, knownThreadById])

  useEffect(() => {
    if (!serverId) return

    const readStateStore = useReadStateStore.getState()
    const unreadStore = useUnreadStore.getState()
    const mentionStore = useMentionStore.getState()

    threadById.forEach((_, threadId) => {
      if (readStateStore.isUnread(threadId)) {
        unreadStore.markUnread(threadId, serverId)
      }
      if (mentionStore.getChannelMentionCount(threadId) > 0) {
        mentionStore.associateGuild(threadId, serverId)
      }
    })
  }, [serverId, threadById])

  const renderedThreadTargets = useMemo(() => {
    const ordered: DtoChannel[] = []
    const seen = new Set<string>()
    const addThread = (thread: DtoChannel | null | undefined) => {
      if (!isThreadChannel(thread) || thread.id == null) return
      const id = String(thread.id)
      if (seen.has(id)) return
      seen.add(id)
      ordered.push(thread)
    }

    channelMessages.forEach((message) => {
      if (message.type !== 0 || message.thread_id == null) return
      addThread(isThreadChannel(message.thread) ? message.thread : threadById.get(String(message.thread_id)))
    })

    return ordered
  }, [channelMessages, threadById])

  const shouldLoadThreadListPreviews = rightPanelMode === 'threads'

  const threadPreviewTargets = useMemo(() => {
    const ordered: DtoChannel[] = []
    const seen = new Set<string>()
    const addThread = (thread: DtoChannel | null | undefined) => {
      if (!isThreadChannel(thread) || thread.id == null) return
      const id = String(thread.id)
      if (seen.has(id)) return
      seen.add(id)
      ordered.push(thread)
    }

    renderedThreadTargets.forEach(addThread)
    if (shouldLoadThreadListPreviews) {
      channelThreads.forEach(addThread)
    }

    return ordered
  }, [channelThreads, renderedThreadTargets, shouldLoadThreadListPreviews])

  const threadPreviewQueries = useQueries({
    queries: threadPreviewTargets.map((thread) => ({
      queryKey: ['thread-preview', String(thread.id), String(thread.last_message_id ?? 0)],
      queryFn: async () => {
        if (thread.last_message_id == null) return null
        const res = await messageApi.messageChannelChannelIdGet({
          channelId: String(thread.id),
          limit: THREAD_PREVIEW_FETCH_LIMIT,
        })
        return res.data?.[0] ?? null
      },
      enabled: thread.last_message_id != null,
      staleTime: 30_000,
    })),
  })

  const threadPreviewMessageMap = useMemo(() => {
    const previews: Record<string, DtoMessage | null> = {}
    threadPreviewTargets.forEach((thread, index) => {
      const threadId = String(thread.id)
      const storedMessages = threadMessages[threadId] ?? []
      previews[threadId] = storedMessages[storedMessages.length - 1] ?? threadPreviewQueries[index]?.data ?? null
    })
    return previews
  }, [threadMessages, threadPreviewQueries, threadPreviewTargets])

  const threadPreviewMap = useMemo(() => {
    const previews: Record<string, string> = {}
    channelThreads.forEach((thread) => {
      previews[String(thread.id)] = buildThreadPreviewText(
        threadPreviewMessageMap[String(thread.id)],
        t,
      )
    })
    return previews
  }, [channelThreads, threadPreviewMessageMap, t])

  const memberColorMap = useMemo(() => {
    const colors: Record<string, string> = {}
    if (!members?.length || !roles?.length) return colors

    members.forEach((member) => {
      const userId = member.user?.id != null ? String(member.user.id) : null
      if (!userId) return
      const color = getTopRoleColor(member.roles, roles)
      if (color) {
        colors[userId] = color
      }
    })

    return colors
  }, [members, roles])

  const openUserProfile = useUiStore((s) => s.openUserProfile)

  const handleUserClick = useCallback(
    (userId: string, x: number, y: number) => {
      openUserProfile(userId, serverId ?? null, x, y)
    },
    [openUserProfile, serverId],
  )

  const handleChannelClick = useCallback(
    (targetChannelId: string) => {
      navigate(`/app/${serverId}/${targetChannelId}`)
    },
    [navigate, serverId],
  )

  const mentionResolver = useMemo<MentionResolver>(
    () => ({
      user: (id) => {
        const m = members?.find((m) => String(m.user?.id) === id)
        return m?.username ?? m?.user?.name
      },
      channel: (id) => {
        const thread = channelThreads?.find((c) => String(c.id) === id)
        return thread?.name ?? channels.find((c) => String(c.id) === id)?.name
      },
      role: (id) => roles?.find((r) => String(r.id) === id)?.name,
      onUserClick: handleUserClick,
      onChannelClick: handleChannelClick,
    }),
    [members, channelThreads, channels, roles, handleUserClick, handleChannelClick],
  )

  const clearSearch = useCallback(() => {
    setSearchResults([])
    setSearchTotalPages(0)
    setSearchPage(0)
    setIsSearching(false)
    setHasSearched(false)
    lastSearchParamsRef.current = null
    searchBarRef.current?.clear()
  }, [])

  useEffect(() => {
    if (!channelId) return
    activateChannel(channelId)
    return () => {
      deactivateChannel(channelId)
    }
  }, [channelId])

  // Clear search when navigating to a different channel
  useEffect(() => {
    clearSearch()
    setRightPanelMode('members')
    setRightPanelModeBeforeThreads('members')
    setJumpRequest(null)
    setActiveThreadId(null)
    setThreadJumpRequest(null)
    setCreateThreadSource(null)
    setReplyTarget(null)
  }, [channelId, clearSearch])

  async function doSearch(params: { chips: AppliedFilter[]; text: string }, pageNum: number) {
    const content = params.text
    const hasFilters = params.chips.filter((f) => f.type === 'has').map((f) => f.apiValue as SearchMessageSearchRequestHasEnum)
    const fromChip = params.chips.find((f) => f.type === 'from')
    const inChip = params.chips.find((f) => f.type === 'in')

    if (!content && !hasFilters.length && !fromChip && !inChip) return

    const targetChannelId = inChip?.apiValue ?? channelId!
    lastSearchParamsRef.current = params

    setIsSearching(true)
    setHasSearched(true)
    try {
      const res = await searchApi.searchGuildIdMessagesPost({
        guildId: serverId!,
        request: {
          content: content || undefined,
          author_id: fromChip ? (fromChip.apiValue as unknown as string) : undefined,
          channel_id: targetChannelId as unknown as string,
          has: hasFilters.length ? hasFilters : undefined,
          page: pageNum,
        },
      })
      const raw = res.data
      const first = Array.isArray(raw) ? raw[0] : raw
      setSearchResults((first as { messages?: DtoMessage[] })?.messages ?? [])
      setSearchTotalPages((first as { pages?: number })?.pages ?? 1)
      setSearchPage(pageNum)
    } catch {
      setSearchResults([])
      setSearchTotalPages(0)
    } finally {
      setIsSearching(false)
    }
  }

  function goToPage(page: number) {
    if (lastSearchParamsRef.current) {
      void doSearch(lastSearchParamsRef.current, page)
    }
  }

  const openThread = useCallback((
    threadId: string,
    options?: {
      jumpToMessageId?: string
      jumpBehavior?: JumpBehavior
      jumpPosition?: number | null
    },
  ) => {
    clearSearch()
    setCreateThreadSource(null)
    setRightPanelModeBeforeThreads((current) => (
      isThreadRightPanelMode(rightPanelMode) ? current : toNonThreadRightPanelMode(rightPanelMode)
    ))
    setActiveThreadId(threadId)
    setThreadJumpRequest(
      options?.jumpToMessageId
        ? createJumpRequest(options.jumpToMessageId, {
            behavior: options.jumpBehavior ?? 'direct-scroll',
            positionHint: options.jumpPosition ?? null,
          })
        : null,
    )
    setRightPanelMode('thread')
  }, [clearSearch, rightPanelMode])

  const openThreadList = useCallback(() => {
    clearSearch()
    setCreateThreadSource(null)
    setRightPanelModeBeforeThreads((current) => (
      isThreadRightPanelMode(rightPanelMode) ? current : toNonThreadRightPanelMode(rightPanelMode)
    ))
    setActiveThreadId(null)
    setThreadJumpRequest(null)
    setRightPanelMode('threads')
  }, [clearSearch, rightPanelMode])

  function handleThreadButtonClick() {
    clearSearch()
    setCreateThreadSource(null)
    setActiveThreadId(null)
    setThreadJumpRequest(null)
    setRightPanelMode((mode) => {
      if (isThreadRightPanelMode(mode)) return rightPanelModeBeforeThreads
      setRightPanelModeBeforeThreads(toNonThreadRightPanelMode(mode))
      return 'threads'
    })
  }

  function handleMembersButtonClick() {
    clearSearch()
    setCreateThreadSource(null)
    setRightPanelMode((mode) => (mode === 'members' ? 'none' : 'members'))
  }

  const handleCreateThreadAction = useCallback((message: DtoMessage) => {
    clearSearch()
    setRightPanelModeBeforeThreads((current) => (
      isThreadRightPanelMode(rightPanelMode) ? current : toNonThreadRightPanelMode(rightPanelMode)
    ))
    setCreateThreadSource(message)
    setRightPanelMode('thread-create')
  }, [clearSearch, rightPanelMode])

  const handleCreateThread = useCallback(async ({
    name,
    content,
    attachmentIds,
    nonce,
    sourceMessageId,
  }: {
    name?: string
    content: string
    attachmentIds: number[]
    nonce: string
    sourceMessageId: string
  }) => {
    if (!channelId) return
    const res = await messageApi.messageChannelChannelIdMessageIdThreadPost({
      channelId: channelId as unknown as number,
      messageId: sourceMessageId as unknown as number,
      request: {
        name,
        content,
        attachments: attachmentIds.length > 0 ? attachmentIds : undefined,
        nonce,
      },
    })
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['channels', serverId] }),
      queryClient.invalidateQueries({ queryKey: ['channel-threads', serverId, channelId] }),
    ])
    openThread(String(res.data.id))
  }, [channelId, openThread, queryClient, serverId])

  const openMessageLocation = useCallback(async (
    targetChannelId: string,
    messageId: string,
    options?: {
      jumpBehavior?: JumpBehavior
      jumpPosition?: number | null
    },
  ) => {
    if (!serverId) return
    const jumpBehavior = options?.jumpBehavior ?? 'direct-scroll'

    if (targetChannelId === channelId) {
      setJumpRequest(createJumpRequest(messageId, {
        behavior: jumpBehavior,
        positionHint: options?.jumpPosition ?? null,
      }))
      return
    }

    if (targetChannelId === activeThreadId) {
      openThread(targetChannelId, {
        jumpToMessageId: messageId,
        jumpBehavior,
        jumpPosition: options?.jumpPosition ?? null,
      })
      return
    }

    const knownChannel = threadById.get(targetChannelId)
      ?? channels.find((c) => String(c.id) === targetChannelId)

    if (isThreadChannel(knownChannel) && knownChannel.parent_id != null) {
      if (String(knownChannel.parent_id) === channelId) {
        openThread(targetChannelId, {
          jumpToMessageId: messageId,
          jumpBehavior,
          jumpPosition: options?.jumpPosition ?? null,
        })
        return
      }

      navigate(`/app/${serverId}/${String(knownChannel.parent_id)}`, {
        state: {
          openThreadId: targetChannelId,
          threadJumpToMessageId: messageId,
          threadJumpBehavior: jumpBehavior,
          threadJumpToMessagePosition: options?.jumpPosition ?? undefined,
        } satisfies ChannelPageLocationState,
      })
      return
    }

    if (!knownChannel) {
      try {
        const res = await guildApi.guildGuildIdChannelChannelIdGet({
          guildId: serverId,
          channelId: targetChannelId,
        })
        if (isThreadChannel(res.data) && res.data.parent_id != null) {
          if (String(res.data.parent_id) === channelId) {
            openThread(targetChannelId, {
              jumpToMessageId: messageId,
              jumpBehavior,
              jumpPosition: options?.jumpPosition ?? null,
            })
            return
          }

          navigate(`/app/${serverId}/${String(res.data.parent_id)}`, {
            state: {
              openThreadId: targetChannelId,
              threadJumpToMessageId: messageId,
              threadJumpBehavior: jumpBehavior,
              threadJumpToMessagePosition: options?.jumpPosition ?? undefined,
            } satisfies ChannelPageLocationState,
          })
          return
        }
      } catch {
        // Fall back to the default channel jump below.
      }
    }

    navigate(`/app/${serverId}/${targetChannelId}`, {
      state: {
        jumpToMessageId: messageId,
        jumpBehavior,
        jumpToMessagePosition: options?.jumpPosition ?? undefined,
      } satisfies ChannelPageLocationState,
    })
  }, [activeThreadId, channelId, channels, navigate, openThread, serverId, threadById])

  async function handleSearchJump(msg: DtoMessage) {
    if (msg.channel_id == null || msg.id == null) return
    await openMessageLocation(String(msg.channel_id), String(msg.id), {
      jumpBehavior: 'direct-scroll',
      jumpPosition: msg.position ?? null,
    })
  }

  useEffect(() => {
    if (!activeThreadId || activeThread || isActiveThreadLoading) return
    setActiveThreadId(null)
    setThreadJumpRequest(null)
    setRightPanelMode('threads')
  }, [activeThread, activeThreadId, isActiveThreadLoading])

  if (!channelId) return null

  const Icon = isVoice ? Volume2 : Hash

  async function handleJoinVoice() {
    if (!channel || !serverId || !channelId) return
    try {
      const res = await guildApi.guildGuildIdVoiceChannelIdJoinPost({ guildId: serverId, channelId })
      if (res.data.sfu_url && res.data.sfu_token) {
        await joinVoice(serverId, channelId, channel.name ?? channelId, res.data.sfu_url, res.data.sfu_token)
      }
    } catch {
      toast.error(t('channelSidebar.joinVoiceFailed'))
    }
  }

  function voiceToggleMute() {
    if (localMuted && localDeafened) {
      setDeafened(false)
      setMuted(false)
    } else {
      setMuted(!localMuted)
    }
  }

  function voiceToggleDeafen() {
    setDeafened(!localDeafened)
  }

  function voiceToggleCamera() {
    if (localCameraEnabled) {
      disableCamera()
    } else {
      void enableCamera()
    }
  }

  const canManageActiveThread = !!activeThread && (
    canManageThreads ||
    (currentUser?.id !== undefined && String(activeThread.creator_id) === String(currentUser.id))
  )

  const getParentMessageProps = useCallback(function getParentMessageProps(msg: DtoMessage) {
    const isInformationalMessage = msg.type === 2 || msg.type === 3 || msg.type === 4
    const canReply =
      (msg.type === 0 || msg.type === 1) &&
      !isAutoThreadFollowup(msg) &&
      msg.id != null
    const attachedThread = isThreadChannel(msg.thread) ? msg.thread : null
    const threadId = attachedThread?.id != null
      ? String(attachedThread.id)
      : msg.thread_id != null
        ? String(msg.thread_id)
        : null
    const channelThreadCandidate = threadId
      ? channels.find((candidate) => String(candidate.id) === threadId)
      : null
    const linkedThread = attachedThread
      ?? (threadId ? threadById.get(threadId) : null)
      ?? (isThreadChannel(channelThreadCandidate) ? channelThreadCandidate : null)
    const isMissingThread = threadId != null && missingThreadIds.has(threadId)
    const threadPreviewMessage = threadId ? threadPreviewMessageMap[threadId] ?? null : null
    const threadPreview = msg.type === 0 && threadId && linkedThread
      ? {
          name: linkedThread.name ?? t('threads.threadFallback'),
          topic: linkedThread.topic?.trim() ? linkedThread.topic.trim() : null,
          previewMessage: threadPreviewMessage,
          previewText: buildThreadPreviewText(threadPreviewMessage, t),
          onClick: () => openThread(threadId),
        }
      : undefined

    const threadBadge = threadId && !threadPreview
      ? {
          label: isMissingThread
            ? t('threads.missingThread')
            : linkedThread?.name ?? t('threads.threadFallback'),
          onClick: isMissingThread ? undefined : () => openThread(threadId),
        }
      : undefined

    const threadAction = threadId && !isMissingThread
      ? {
          label: t('threads.openThread'),
          onClick: () => openThread(threadId),
        }
      : (
        isTextChannel &&
        canCreateThreads &&
        msg.id != null &&
        !isInformationalMessage
      )
        ? {
            label: t('threads.createThread'),
            onClick: () => handleCreateThreadAction(msg),
          }
        : undefined

    return {
      threadPreview,
      threadBadge,
      threadAction,
      replyAction: canReply ? {
        label: t('messageItem.reply'),
        onClick: () => setReplyTarget(msg),
      } : undefined,
      threadListAction: isTextChannel ? {
        label: t('threads.title'),
        onClick: openThreadList,
      } : undefined,
      onOpenReference: ({ channelId: targetChannelId, messageId }: { channelId: string; messageId: string }) => {
        void openMessageLocation(targetChannelId, messageId)
      },
      hideContent: threadBadge != null && isAutoThreadFollowup(msg),
      allowEdit: !isInformationalMessage,
      allowDelete: true,
    }
  }, [channels, threadById, missingThreadIds, threadPreviewMessageMap, t, openThread, handleCreateThreadAction, setReplyTarget, openThreadList, openMessageLocation, isTextChannel, canCreateThreads])

  const threadButtonActive =
    rightPanelMode === 'threads' ||
    rightPanelMode === 'thread' ||
    rightPanelMode === 'thread-create'
  const isThreadSidePanelVisible =
    !hasSearched &&
    (
      rightPanelMode === 'threads' ||
      rightPanelMode === 'thread' ||
      rightPanelMode === 'thread-create'
    )
  const activeRightPanelWidthKey = getRightPanelWidthKey(hasSearched, rightPanelMode)
  const activeRightPanelWidth = clampRightPanelWidth(
    rightPanelWidths[activeRightPanelWidthKey] ?? DEFAULT_RIGHT_PANEL_WIDTHS[activeRightPanelWidthKey],
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(RIGHT_PANEL_WIDTH_STORAGE_KEY, JSON.stringify(rightPanelWidths))
    } catch {
      // Ignore storage failures and keep the in-memory widths.
    }
  }, [rightPanelWidths])

  useEffect(() => {
    const handleResize = () => {
      setRightPanelWidths((current) => {
        let changed = false
        const next = { ...current }
        RIGHT_PANEL_WIDTH_KEYS.forEach((key) => {
          const currentWidth = current[key] ?? DEFAULT_RIGHT_PANEL_WIDTHS[key]
          const clamped = clampRightPanelWidth(currentWidth)
          if (clamped !== currentWidth) {
            next[key] = clamped
            changed = true
          }
        })
        return changed ? next : current
      })
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
    }
  }, [])

  useEffect(() => {
    return () => {
      rightPanelResizeCleanupRef.current?.()
    }
  }, [])

  const handleRightPanelResizeStart = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!isThreadSidePanelVisible) return
    event.preventDefault()

    rightPanelResizeCleanupRef.current?.()

    const widthKey = getRightPanelWidthKey(hasSearched, rightPanelMode)
    const startX = event.clientX
    const startWidth = rightPanelWidths[widthKey] ?? DEFAULT_RIGHT_PANEL_WIDTHS[widthKey]
    const previousUserSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRightPanelWidth(startWidth + (startX - moveEvent.clientX))
      setRightPanelWidths((current) => {
        if ((current[widthKey] ?? DEFAULT_RIGHT_PANEL_WIDTHS[widthKey]) === nextWidth) {
          return current
        }
        return { ...current, [widthKey]: nextWidth }
      })
    }

    const stopResizing = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', stopResizing)
      window.removeEventListener('pointercancel', stopResizing)
      document.body.style.userSelect = previousUserSelect
      document.body.style.cursor = previousCursor
      rightPanelResizeCleanupRef.current = null
    }

    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', stopResizing)
    window.addEventListener('pointercancel', stopResizing)
    rightPanelResizeCleanupRef.current = stopResizing
  }, [hasSearched, isThreadSidePanelVisible, rightPanelMode, rightPanelWidths])

  // Voice channel view
  if (isVoice) {
    const isConnected = voiceChannelId === channelId
    const currentUserId = String(currentUser?.id ?? '')
    const peerEntries = Object.entries(voicePeers).filter(([userId]) => userId !== currentUserId)

    // Normalised list of all voice participants
    const allParticipants = [
      {
        id: 'local',
        label: currentUser?.name ?? '',
        avatarUrl: currentUser?.avatar?.url,
        speaking: localSpeaking,
        muted: localMuted,
        deafened: localDeafened,
        videoStream: localCameraEnabled ? localVideoStream : null,
        isLocal: true as const,
      },
      ...peerEntries.map(([userId, peer]) => {
        const member = members?.find((m) => String(m.user?.id) === userId)
        return {
          id: userId,
          label: member?.username ?? member?.user?.name ?? `User ${userId.slice(0, 6)}`,
          avatarUrl: member?.user?.avatar?.url,
          speaking: peer.speaking,
          muted: peer.muted,
          deafened: peer.deafened,
          videoStream: peer.videoStream,
          isLocal: false as const,
        }
      }),
    ]

    const spotlightParticipant = spotlightId ? allParticipants.find((p) => p.id === spotlightId) ?? null : null
    const stripParticipants = spotlightId ? allParticipants.filter((p) => p.id !== spotlightId) : []

    return (
      <div className="flex flex-col flex-1 min-h-0">
        <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-semibold">{channel?.name ?? channelId}</span>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="h-5 mx-1" />
              <span className="text-sm text-muted-foreground truncate">{channel.topic}</span>
            </>
          )}
        </div>

        {isConnected ? (
          spotlightParticipant ? (
            /* ── Spotlight layout ─────────────────────────────────────────── */
            <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
              {/* Main spotlight area */}
              <div className="flex-1 min-h-0 flex items-center justify-center p-4">
                <VoiceParticipant
                  {...spotlightParticipant}
                  size="spotlight"
                  onClick={() => setSpotlightId(null)}
                />
              </div>
              {/* Bottom strip */}
              <div className="shrink-0 flex gap-3 px-4 pb-3 overflow-x-auto border-t border-sidebar-border pt-3">
                {stripParticipants.map((p) => (
                  <VoiceParticipant
                    key={p.id}
                    {...p}
                    size="compact"
                    onClick={p.videoStream ? () => setSpotlightId(p.id) : undefined}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* ── Grid layout ──────────────────────────────────────────────── */
            <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 overflow-auto">
              <p className="text-sm text-muted-foreground">
                {peerEntries.length === 0
                  ? t('channel.connected', { count: 1 })
                  : t('channel.connected_plural', { count: peerEntries.length + 1 })}
              </p>
              <div className="flex flex-wrap justify-center gap-4 w-full">
                {allParticipants.map((p) => (
                  <VoiceParticipant
                    key={p.id}
                    {...p}
                    onClick={p.videoStream ? () => setSpotlightId(p.id) : undefined}
                  />
                ))}
              </div>
            </div>
          )
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
            <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
              <Volume2 className="w-8 h-8 text-muted-foreground" />
            </div>
            <h3 className="text-xl font-bold">{channel?.name}</h3>
            <p className="text-sm text-muted-foreground">
              {t('channel.clickToJoin')}
            </p>
          </div>
        )}

        {/* Voice control bar */}
        <div className="shrink-0 border-t border-sidebar-border bg-background px-4 py-3 flex items-center justify-center gap-2">
          {isConnected ? (
            <>
              <button
                onClick={voiceToggleMute}
                title={localMuted ? t('voicePanel.unmute') : t('voicePanel.mute')}
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-full transition-colors',
                  localMuted
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : localSpeaking
                      ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      : 'bg-muted hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>
              <button
                onClick={voiceToggleDeafen}
                title={localDeafened ? t('voicePanel.undeafen') : t('voicePanel.deafen')}
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-full transition-colors',
                  localDeafened
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : 'bg-muted hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localDeafened ? <HeadphoneOff className="w-5 h-5" /> : <Headphones className="w-5 h-5" />}
              </button>
              <button
                onClick={voiceToggleCamera}
                title={localCameraEnabled ? t('voicePanel.cameraOff') : t('voicePanel.cameraOn')}
                className={cn(
                  'flex items-center justify-center w-10 h-10 rounded-full transition-colors',
                  localCameraEnabled
                    ? 'bg-primary/20 text-primary hover:bg-primary/30'
                    : 'bg-muted hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localCameraEnabled ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
              </button>
              <button
                onClick={leaveVoice}
                title={t('voicePanel.disconnect')}
                className="flex items-center justify-center w-10 h-10 rounded-full bg-muted hover:bg-destructive/20 text-muted-foreground hover:text-destructive transition-colors"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </>
          ) : (
            <button
              onClick={() => void handleJoinVoice()}
              className="px-6 py-2 rounded-md bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-colors"
            >
              {t('channel.joinVoice')}
            </button>
          )}
        </div>
      </div>
    )
  }

  // Text channel view
  return (
    <>
      <div className="flex flex-col flex-1 min-h-0">
        <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-semibold">{channel?.name ?? channelId}</span>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="h-5 mx-1" />
              <span className="text-sm text-muted-foreground truncate">{channel.topic}</span>
            </>
          )}

          <div className="ml-auto flex items-center gap-2">
            {isTextChannel && (
              <button
                onClick={handleThreadButtonClick}
                title={threadButtonActive ? t('threads.hideThreadList') : t('threads.showThreadList')}
                className={cn(
                  'w-8 h-8 flex items-center justify-center rounded transition-colors',
                  threadButtonActive
                    ? 'text-foreground bg-accent'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                )}
              >
                <Spool className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={handleMembersButtonClick}
              title={rightPanelMode === 'members' ? t('channel.hideMemberList') : t('channel.showMemberList')}
              className={cn(
                'w-8 h-8 flex items-center justify-center rounded transition-colors',
                rightPanelMode === 'members'
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Users className="w-4 h-4" />
            </button>
            <SearchBar
              ref={searchBarRef}
              className="w-60 focus-within:w-80 transition-[width] duration-200 h-7 rounded-md border border-input bg-muted/30 px-2"
              members={members}
              channels={channels}
              onSearch={(params) => void doSearch(params, 0)}
              onClear={clearSearch}
              hasResults={hasSearched}
            />
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          <ChatAttachmentDropZone
            className="flex-1 min-w-0"
            onFileDrop={(files) => {
              messageInputRef.current?.addFiles(files)
              messageInputRef.current?.focusEditor()
            }}
          >
            <MessageList
              key={channelId}
              rows={rows}
              mode={mode}
              isLoadingInitial={isLoadingInitial}
              jumpTargetRowKey={jumpTargetRowKey}
              focusTargetRowKey={focusTargetRowKey}
              highlightRequest={effectiveJumpRequest}
              onHighlightHandled={handleChannelJumpHandled}
              channelName={channel?.name}
              resolver={mentionResolver}
              getMessageProps={getParentMessageProps}
              onLoadGap={loadGap}
              onJumpToPresent={jumpToPresent}
              onAckLatest={ackLatest}
            />
            <TypingIndicator channelId={channelId} serverId={serverId ?? ''} />
            <MessageInput
              ref={messageInputRef}
              channelId={channelId}
              channelName={channel?.name ? `#${channel.name}` : channelId}
              resolver={mentionResolver}
              replyTo={replyTarget}
              onCancelReply={() => setReplyTarget(null)}
            />
          </ChatAttachmentDropZone>

          {(hasSearched || rightPanelMode !== 'none') && serverId && (
            <>
              {isThreadSidePanelVisible && (
                <div
                  className="group relative w-1.5 shrink-0 cursor-col-resize bg-transparent touch-none"
                  onPointerDown={handleRightPanelResizeStart}
                >
                  <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-sidebar-border/80 transition-colors group-hover:bg-foreground/30" />
                </div>
              )}
              <div
                className={cn(
                  'flex min-h-0 flex-col overflow-hidden border-l border-sidebar-border bg-sidebar shrink-0',
                  hasSearched
                    ? 'w-80'
                    : isThreadSidePanelVisible
                      ? ''
                      : 'w-60',
                )}
                style={isThreadSidePanelVisible ? { width: `${activeRightPanelWidth}px` } : undefined}
              >
                {hasSearched ? (
                  <SearchPanel
                    serverId={serverId}
                    results={searchResults}
                    channels={channels}
                    isLoading={isSearching}
                    hasSearched={hasSearched}
                    page={searchPage}
                    totalPages={searchTotalPages}
                    onPageChange={goToPage}
                    onJumpToMessage={handleSearchJump}
                    resolver={mentionResolver}
                    className="flex-1 min-h-0"
                  />
                ) : rightPanelMode === 'thread' && activeThread ? (
                  <ThreadPanel
                    serverId={serverId}
                    thread={activeThread}
                    canManageThread={canManageActiveThread}
                    canSendMessages={canSendInThreads}
                    highlightRequest={threadJumpRequest}
                    onHighlightHandled={handleThreadJumpHandled}
                    resolver={mentionResolver}
                    onOpenReferencedMessage={(targetChannelId, messageId) => {
                      void openMessageLocation(targetChannelId, messageId)
                    }}
                    onBack={() => setRightPanelMode('threads')}
                    onDeleted={() => {
                      setActiveThreadId(null)
                      setThreadJumpRequest(null)
                      setRightPanelMode('threads')
                    }}
                  />
                ) : rightPanelMode === 'thread-create' && createThreadSource ? (
                  <ThreadCreatePanel
                    parentChannelId={channelId}
                    sourceMessage={createThreadSource}
                    onBack={() => {
                      setCreateThreadSource(null)
                      setRightPanelMode('threads')
                    }}
                    onCreateThread={handleCreateThread}
                  />
                ) : rightPanelMode === 'thread' ? (
                  <div className="flex flex-1 min-h-0 items-center justify-center text-sm text-muted-foreground">
                    {t('common.loading')}
                  </div>
                ) : rightPanelMode === 'threads' ? (
                <ThreadListPanel
                  threads={channelThreads}
                  previews={threadPreviewMap}
                  previewMessages={threadPreviewMessageMap}
                  memberColors={memberColorMap}
                  isLoading={isThreadsLoading}
                  activeThreadId={activeThreadId}
                  resolver={mentionResolver}
                  onOpenThread={(threadId) => openThread(threadId)}
                />
                ) : (
                  <MemberList serverId={serverId} channel={channel} />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  )
}

/**
 * Attaches a MediaStream to a <video> element.
 */
function VideoFeed({
  stream,
  mirror = false,
  onAspect,
  onFrozen,
  onActive,
}: {
  stream: MediaStream
  mirror?: boolean
  onAspect?: (ratio: number) => void
  onFrozen?: () => void
  onActive?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    el.play().catch(() => {})
    return () => { el.srcObject = null }
  }, [stream])

  useEffect(() => {
    if (!onFrozen && !onActive) return
    const el = videoRef.current
    if (!el) return

    let lastFrames = -1
    let staleCount = 0
    const STALE_LIMIT = 3

    const check = () => {
      const q = el.getVideoPlaybackQuality?.()
      if (!q) return
      const frames = q.totalVideoFrames
      if (frames === lastFrames) {
        staleCount++
        if (staleCount === STALE_LIMIT) onFrozen?.()
      } else {
        if (staleCount >= STALE_LIMIT) onActive?.()
        staleCount = 0
        lastFrames = frames
      }
    }

    const timer = setInterval(check, 1000)
    return () => clearInterval(timer)
  }, [stream, onFrozen, onActive])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      onLoadedMetadata={(e) => {
        const { videoWidth: w, videoHeight: h } = e.currentTarget
        if (w && h) onAspect?.(w / h)
      }}
      className={cn('w-full h-full object-cover rounded-lg', mirror && '[transform:scaleX(-1)]')}
    />
  )
}

type ParticipantSize = 'normal' | 'compact' | 'spotlight'

function VoiceParticipant({
  label,
  avatarUrl,
  speaking,
  muted,
  deafened,
  videoStream,
  isLocal,
  size = 'normal',
  onClick,
}: {
  label: string
  avatarUrl?: string
  speaking: boolean
  muted: boolean
  deafened?: boolean
  videoStream?: MediaStream | null
  isLocal?: boolean
  size?: ParticipantSize
  onClick?: () => void
}) {
  const initials = label.charAt(0).toUpperCase()
  const streamId = videoStream?.id ?? null
  const [frozenStreamId, setFrozenStreamId] = useState<string | null>(null)
  const [videoAspectState, setVideoAspectState] = useState<{ streamId: string | null; ratio: number | null }>({
    streamId: null,
    ratio: null,
  })
  const videoAspect = videoAspectState.streamId === streamId ? videoAspectState.ratio : null
  const handleFrozen = useCallback(() => setFrozenStreamId(streamId), [streamId])
  const handleActive = useCallback(() => setFrozenStreamId(null), [])
  const handleAspect = useCallback(
    (ratio: number) => setVideoAspectState({ streamId, ratio }),
    [streamId],
  )
  const hasVideo = !!videoStream && (isLocal || frozenStreamId !== streamId)

  const avatarCls = size === 'spotlight' ? 'w-24 h-24' : size === 'compact' ? 'w-12 h-12' : 'w-20 h-20'
  const fallbackCls = size === 'spotlight' ? 'text-3xl' : size === 'compact' ? 'text-base' : 'text-xl'
  const badgeCls = size === 'spotlight' ? 'w-7 h-7' : 'w-5 h-5'
  const badgeIconCls = size === 'spotlight' ? 'w-4 h-4' : 'w-3 h-3'
  const labelCls = size === 'compact' ? 'text-[10px] max-w-[80px]' : 'text-xs max-w-[100px]'

  // Spotlight: full height, width derived from the camera's native aspect ratio.
  // This means the video is never cropped and never letterboxed — it's exactly
  // as wide as the AR dictates at the available height.
  const spotlightContainerStyle = size === 'spotlight' && hasVideo
    ? { height: '100%', aspectRatio: videoAspect ? String(videoAspect) : '16 / 9' }
    : undefined

  return (
    <div className={cn(
      'flex flex-col items-center gap-2',
      size === 'spotlight' && hasVideo && 'h-full',
    )}>
      {/*
        Outer wrapper has NO overflow-hidden — speaking ring and mute/deafen badges
        are positioned here and must render outside the avatar's clipping boundary.
      */}
      <div
        className={cn(
          'relative transition-all duration-150',
          hasVideo && onClick && 'cursor-pointer',
        )}
        style={spotlightContainerStyle}
        onClick={onClick}
      >
        {hasVideo ? (
          /* Video: overflow-hidden is scoped to the video container, not the wrapper */
          <div className={cn(
            'rounded-lg bg-zinc-900 overflow-hidden relative',
            size === 'spotlight' ? 'w-full h-full' : size === 'compact' ? 'w-36 h-24' : 'w-56 h-40',
          )}>
            <VideoFeed
              key={videoStream!.id}
              stream={videoStream!}
              mirror={isLocal}
              onAspect={size === 'spotlight' ? handleAspect : undefined}
              onFrozen={isLocal ? undefined : handleFrozen}
              onActive={isLocal ? undefined : handleActive}
            />
            {/* Label + icon bar inside the video */}
            <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-black/50 flex items-center justify-between gap-1">
              <span className="text-xs text-white truncate">{label}</span>
              <div className="flex items-center gap-1 shrink-0">
                {deafened
                  ? <HeadphoneOff className="w-3 h-3 text-destructive" />
                  : muted
                    ? <MicOff className="w-3 h-3 text-destructive" />
                    : null}
              </div>
            </div>
            {/* Speaking ring inside video */}
            {speaking && (
              <div className="absolute inset-0 ring-2 ring-green-500 rounded-lg pointer-events-none" />
            )}
          </div>
        ) : (
          /* Avatar: Avatar has its own overflow-hidden; ring and badge sit on the wrapper */
          <>
            <Avatar className={cn(avatarCls, 'transition-all duration-150')}>
              {avatarUrl && <AvatarImage src={avatarUrl} alt={label} className="object-cover" />}
              <AvatarFallback className={fallbackCls}>{initials}</AvatarFallback>
            </Avatar>
            {/* Speaking ring — sibling of Avatar, not clipped by it */}
            {speaking && (
              <div className="absolute inset-0 rounded-full ring-2 ring-green-500 ring-offset-2 ring-offset-background pointer-events-none" />
            )}
            {/* Mute/Deafen badge — sibling of Avatar, not clipped by it */}
            {(deafened || muted) && (
              <div className={cn(
                'absolute -bottom-1 -right-1 rounded-full bg-destructive border border-background flex items-center justify-center pointer-events-none',
                badgeCls,
              )}>
                {deafened
                  ? <HeadphoneOff className={cn(badgeIconCls, 'text-white')} />
                  : <MicOff className={cn(badgeIconCls, 'text-white')} />
                }
              </div>
            )}
          </>
        )}
      </div>
      {!hasVideo && (
        <span className={cn('text-muted-foreground truncate', labelCls)}>{label}</span>
      )}
    </div>
  )
}

