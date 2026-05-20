import { useState, useEffect, useMemo, useRef, useCallback, type PointerEvent as ReactPointerEvent } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Users, ChevronLeft, Search, X, Phone, Maximize2, Minimize2 } from 'lucide-react'
import { toast } from 'sonner'
import { activateChannel, deactivateChannel } from '@/services/wsService'
import ChatAttachmentDropZone from '@/components/chat/ChatAttachmentDropZone'
import MessageList from '@/components/chat/MessageList'
import MessageInput, { type MessageInputHandle } from '@/components/chat/MessageInput'
import SearchBar, { type SearchBarHandle, type AppliedFilter } from '@/components/chat/SearchBar'
import SearchPanel from '@/components/chat/SearchPanel'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import { createJumpRequest, type JumpBehavior, type JumpRequest } from '@/lib/messageJump'
import { userApi, searchApi } from '@/api/client'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import { ChannelType } from '@/types'
import type { DtoMember, DtoMessage, DtoUser } from '@/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { useClientMode } from '@/hooks/useClientMode'
import { dmCallApi } from '@/services/dmCallApi'
import { joinVoice, leaveVoice } from '@/services/voiceService'
import { syncChannelStreams } from '@/services/streamService'
import { useDMCallStore } from '@/stores/dmCallStore'
import { useVoiceStore } from '@/stores/voiceStore'
import VoiceCallStage, { type VoiceCallParticipant } from '@/components/voice/VoiceCallStage'

interface DMPageLocationState {
  jumpToMessageId?: string
  jumpBehavior?: JumpBehavior
  jumpToMessagePosition?: number
}

const RAW_ID_PATTERN = /^\d{10,}$/

function presentableDmName(name: string | null | undefined) {
  const trimmed = name?.trim()
  if (!trimmed || RAW_ID_PATTERN.test(trimmed)) return null
  return trimmed
}

export default function DMPage() {
  // NOTE: the route param is named :userId but by the time we land here the
  // navigation target is the DM *channel* ID returned by the friends API.
  const { userId: channelId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const locationState = location.state as DMPageLocationState | null
  const jumpIdFromState = locationState?.jumpToMessageId
  const jumpBehaviorFromState = locationState?.jumpBehavior ?? 'direct-scroll'
  const jumpPositionFromState = locationState?.jumpToMessagePosition ?? null
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)
  const [callPanelHeight, setCallPanelHeight] = useState(360)
  const [isCallChatHidden, setIsCallChatHidden] = useState(false)

  // Derive jump from location state synchronously so useMessagePagination sees it
  // on the same render that channelId changes, preventing a spurious loadInitialWindow.
  const locationStateJump = useMemo(
    () => jumpIdFromState
      ? createJumpRequest(jumpIdFromState, {
          behavior: jumpBehaviorFromState,
          positionHint: jumpPositionFromState,
        })
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [jumpIdFromState],
  )
  const effectiveJumpRequest = locationStateJump ?? jumpRequest

  useEffect(() => {
    if (!channelId) return
    activateChannel(channelId)
    return () => {
      deactivateChannel(channelId)
    }
  }, [channelId])

  // DM channel + participant info
  const { data: dmChannel } = useQuery({
    queryKey: ['dm-channel', channelId],
    queryFn: async () => {
      if (!channelId) return null
      const res = await userApi.userMeChannelsGet()
      return res.data?.find((ch) => String(ch.id) === channelId) ?? null
    },
    enabled: !!channelId,
  })

  const isGroupDm = dmChannel?.type === ChannelType.ChannelTypeGroupDM
  const participantId = !isGroupDm && dmChannel?.participant_id
    ? String(dmChannel.participant_id)
    : null

  const cachedParticipantUser = useMemo(() => {
    if (!participantId) return null
    const cachedUser = queryClient.getQueryData<DtoUser>(['user', participantId])
    if (cachedUser) return cachedUser

    return queryClient
      .getQueryData<DtoUser[]>(['friends'])
      ?.find((user) => String(user.id) === participantId) ?? null
  }, [participantId, queryClient])

  const { data: participantUser } = useQuery({
    queryKey: ['user', participantId],
    queryFn: async () => {
      if (!participantId) return null
      const res = await userApi.userUserIdGet({ userId: participantId })
      return res.data ?? null
    },
    enabled: !!participantId,
    initialData: cachedParticipantUser ?? undefined,
    staleTime: 5 * 60 * 1000,
  })

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
    channelId,
    effectiveJumpRequest,
    dmChannel?.last_message_id != null ? String(dmChannel.last_message_id) : undefined,
  )

  const displayName = useMemo(() => {
    if (isGroupDm) return dmChannel?.name ?? 'Group'
    const name = participantUser?.name
      ?? cachedParticipantUser?.name
      ?? presentableDmName(dmChannel?.name)
      ?? 'Direct Message'
    return `@${name}`
  }, [isGroupDm, dmChannel?.name, participantUser?.name, cachedParticipantUser?.name])

  useEffect(() => {
    document.title = `${displayName} — GoChat`
    return () => { document.title = 'GoChat' }
  }, [displayName])

  // Build a minimal DtoMember list for the "from:" autocomplete
  const dmMembers = useMemo<DtoMember[]>(() => {
    if (!participantUser) return []
    return [{ user: participantUser, username: participantUser.name }]
  }, [participantUser])

  // ── Search state ────────────────────────────────────────────────────────────
  const [searchResults, setSearchResults] = useState<DtoMessage[]>([])
  const [searchTotalPages, setSearchTotalPages] = useState(0)
  const [searchPage, setSearchPage] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const lastSearchParamsRef = useRef<{ chips: AppliedFilter[]; text: string } | null>(null)
  const searchBarRef = useRef<SearchBarHandle>(null)
  const isMobile = useClientMode() === 'mobile'
  const messageInputRef = useRef<MessageInputHandle | null>(null)
  const activeCall = useDMCallStore((state) => channelId ? state.calls[channelId] : null)
  const upsertCall = useDMCallStore((state) => state.upsertCall)
  const voice = useVoiceStore()
  const isInThisCall = voice.guildId === '@me' && voice.channelId === channelId
  const isChatVisible = !activeCall || !isCallChatHidden

  const clearSearch = useCallback(() => {
    setSearchResults([])
    setSearchTotalPages(0)
    setSearchPage(0)
    setIsSearching(false)
    setHasSearched(false)
    lastSearchParamsRef.current = null
    searchBarRef.current?.clear()
  }, [])

  // Clear search when channel changes
  useEffect(() => {
    clearSearch()
  }, [channelId, clearSearch])

  useEffect(() => {
    setJumpRequest(null)
  }, [channelId])

  useEffect(() => {
    if (!jumpIdFromState) return
    // jumpIdFromState is handled via locationStateJump above; just clear the location state.
    navigate(location.pathname, { replace: true, state: {} })
  }, [jumpIdFromState, location.pathname, navigate])

  const handleJumpHandled = useCallback((requestKey: string) => {
    setJumpRequest((current) => current?.requestKey === requestKey ? null : current)
  }, [])

  const handleSearchJump = useCallback(async (message: DtoMessage) => {
    if (message.id == null) return
    setJumpRequest(createJumpRequest(String(message.id), {
      behavior: 'preload-window',
      positionHint: message.position ?? null,
    }))
  }, [])

  async function doSearch(params: { chips: AppliedFilter[]; text: string }, pageNum: number) {
    const content = params.text
    const hasFilters = params.chips.filter((f) => f.type === 'has').map((f) => f.apiValue as SearchMessageSearchRequestHasEnum)
    const fromChip = params.chips.find((f) => f.type === 'from')

    if (!content && !hasFilters.length && !fromChip) return

    lastSearchParamsRef.current = params

    setIsSearching(true)
    setHasSearched(true)
    try {
      const res = await searchApi.searchGuildIdMessagesPost({
        guildId: '',
        request: {
          content: content || undefined,
          author_id: fromChip ? (fromChip.apiValue as unknown as string) : undefined,
          channel_id: channelId as unknown as string,
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

  const avatarInitial = (isGroupDm ? (dmChannel?.name ?? 'G') : (participantUser?.name ?? displayName))
    .replace('@', '').charAt(0).toUpperCase()

  async function handleStartOrJoinCall() {
    if (!channelId || isGroupDm) return
    try {
      const response = activeCall
        ? await dmCallApi.joinCall(channelId)
        : await dmCallApi.startCall(channelId)
      upsertCall(response.call)
      await joinVoice(
        '@me',
        channelId,
        displayName,
        response.sfuUrl,
        response.sfuToken,
        'Direct Messages',
        response.region,
        { privateCall: true },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to start call')
    }
  }

  async function handleLeaveCall() {
    try {
      await leaveVoice()
    } catch {
      toast.error('Unable to leave call')
    }
  }

  const handleCallPanelResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = callPanelHeight
    const pointerId = event.pointerId
    event.currentTarget.setPointerCapture(pointerId)

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const maxHeight = Math.max(280, Math.round(window.innerHeight * 0.72))
      const nextHeight = Math.max(260, Math.min(maxHeight, startHeight + moveEvent.clientY - startY))
      setCallPanelHeight(nextHeight)
    }
    const handlePointerUp = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp, { once: true })
    window.addEventListener('pointercancel', handlePointerUp, { once: true })
  }, [callPanelHeight])

  useEffect(() => {
    if (!channelId || !isInThisCall) return
    void syncChannelStreams('@me', channelId)
  }, [channelId, isInThisCall])

  const callParticipants = useMemo<VoiceCallParticipant[]>(() => {
    const items: VoiceCallParticipant[] = []
    if (participantId && participantUser) {
      items.push({
        id: participantId,
        name: participantUser.name ?? displayName.replace(/^@/, ''),
        avatarUrl: participantUser.avatar?.url,
      })
    }
    return items
  }, [displayName, participantId, participantUser])

  if (!channelId) return null

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-[radial-gradient(circle_at_50%_0%,rgba(99,102,241,.10),transparent_34%),#090a0f]">
      {/* DM Header */}
      <div className="h-12 border-b border-white/[0.08] flex items-center px-4 gap-2 shrink-0 bg-[#090a0f]">
        {isMobile && (
          <button
            onClick={() => navigate('/app/@me')}
            className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors shrink-0 -ml-1"
            aria-label="Back to DMs"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {isGroupDm ? (
          <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center shrink-0">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
          </div>
        ) : (
          <Avatar className="w-6 h-6 shrink-0">
            <AvatarImage src={participantUser?.avatar?.url} className="object-cover" />
            <AvatarFallback className="text-[10px]">{avatarInitial}</AvatarFallback>
          </Avatar>
        )}
        <span className="font-semibold truncate">{displayName}</span>

        {isMobile && (
          <div className="ml-auto flex items-center gap-1">
            {!isGroupDm && (
              <button
                onClick={() => void handleStartOrJoinCall()}
                aria-label={activeCall ? 'Join call' : 'Start call'}
                className="w-9 h-9 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <Phone className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => {
                const opening = !mobileSearchOpen
                setMobileSearchOpen(opening)
                if (opening) {
                  setTimeout(() => searchBarRef.current?.focus(), 50)
                } else {
                  clearSearch()
                }
              }}
              aria-label="Search"
              className={cn(
                'w-9 h-9 flex items-center justify-center rounded transition-colors',
                mobileSearchOpen || hasSearched
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Search className="w-4 h-4" />
            </button>
          </div>
        )}

        {!isMobile && (
          <div className="ml-auto flex items-center gap-2">
            {!isGroupDm && (
              <button
                onClick={() => void handleStartOrJoinCall()}
                aria-label={activeCall ? 'Join call' : 'Start call'}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              >
                <Phone className="h-4 w-4" />
              </button>
            )}
            <SearchBar
              ref={searchBarRef}
              className="w-60 focus-within:w-80 transition-[width] duration-200 h-8 rounded-xl border border-white/[0.09] bg-black/20 px-3"
              members={dmMembers}
              allowedFilters={['from', 'has']}
              onSearch={(p) => void doSearch(p, 0)}
              onClear={clearSearch}
              hasResults={hasSearched}
            />
          </div>
        )}
      </div>

      {/* Mobile search bar row */}
      {isMobile && mobileSearchOpen && (
        <div className="border-b border-white/[0.08] bg-[#090a0f] px-3 py-2 shrink-0">
          <SearchBar
            ref={searchBarRef}
            className="w-full h-8 rounded-xl border border-white/[0.09] bg-black/20 px-3"
            members={dmMembers}
            allowedFilters={['from', 'has']}
            onSearch={(p) => void doSearch(p, 0)}
            onClear={() => { clearSearch(); setMobileSearchOpen(false) }}
            hasResults={hasSearched}
          />
        </div>
      )}

      {/* Content row */}
      <div className="relative flex flex-1 min-h-0">
        <ChatAttachmentDropZone
          className="flex-1 min-w-0"
          onFileDrop={(files) => {
            messageInputRef.current?.addFiles(files)
            messageInputRef.current?.focusEditor()
          }}
        >
          {activeCall && (
            <div
              className={cn(
                'relative overflow-hidden border-b border-sidebar-border',
                isCallChatHidden ? 'flex-1' : 'shrink-0',
              )}
              style={isCallChatHidden ? undefined : { height: callPanelHeight }}
            >
              <VoiceCallStage
                guildId="@me"
                channelId={channelId}
                title={`Voice call with ${displayName}`}
                region={activeCall.region}
                participants={callParticipants}
                onJoin={handleStartOrJoinCall}
                onLeave={handleLeaveCall}
                showHeader={false}
                className="h-full min-h-0 border-b-0"
              />
              <button
                type="button"
                onClick={() => setIsCallChatHidden((hidden) => !hidden)}
                aria-label={isCallChatHidden ? 'Show chat' : 'Hide chat'}
                className="absolute right-3 top-3 z-30 flex h-8 w-8 items-center justify-center rounded-full bg-background/80 text-muted-foreground shadow-sm backdrop-blur transition-colors hover:bg-accent hover:text-foreground"
              >
                {isCallChatHidden ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </button>
              {!isCallChatHidden && (
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize call panel"
                  onPointerDown={handleCallPanelResizePointerDown}
                  className="absolute inset-x-0 bottom-0 z-20 flex h-2 cursor-row-resize items-center justify-center bg-transparent transition-colors hover:bg-primary/10"
                >
                  <div className="h-0.5 w-12 rounded-full bg-border" />
                </div>
              )}
            </div>
          )}
          {isChatVisible && (
            <>
              <MessageList
                key={channelId}
                rows={rows}
                mode={mode}
                isLoadingInitial={isLoadingInitial}
                jumpTargetRowKey={jumpTargetRowKey}
                focusTargetRowKey={focusTargetRowKey}
                highlightRequest={effectiveJumpRequest}
                onHighlightHandled={handleJumpHandled}
                onLoadGap={loadGap}
                onJumpToPresent={jumpToPresent}
                onAckLatest={ackLatest}
              />
              <MessageInput ref={messageInputRef} channelId={channelId} channelName={displayName} />
            </>
          )}
        </ChatAttachmentDropZone>

        {/* Search results panel — full-screen overlay on mobile, side panel on desktop */}
        {hasSearched && (
          <div className={cn(
            'flex min-h-0 flex-col overflow-hidden border-l border-white/[0.08] bg-sidebar shrink-0',
            isMobile ? 'absolute inset-0 z-40' : 'w-80',
          )}>
            {isMobile && (
              <div className="h-11 flex items-center px-4 border-b border-sidebar-border shrink-0">
                <span className="text-sm font-semibold flex-1">Search Results</span>
                <button
                  onClick={() => { clearSearch(); setMobileSearchOpen(false) }}
                  className="w-7 h-7 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            <SearchPanel
              serverId=""
              results={searchResults}
              channels={[]}
              isLoading={isSearching}
              hasSearched={hasSearched}
              page={searchPage}
              totalPages={searchTotalPages}
              onPageChange={goToPage}
              onJumpToMessage={handleSearchJump}
              className="flex-1 min-h-0"
            />
          </div>
        )}
      </div>
    </div>
  )
}
