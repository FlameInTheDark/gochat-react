import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
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
import type { DtoMember, DtoMessage } from '@/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

interface DMPageLocationState {
  jumpToMessageId?: string
  jumpBehavior?: JumpBehavior
  jumpToMessagePosition?: number
}

export default function DMPage() {
  // NOTE: the route param is named :userId but by the time we land here the
  // navigation target is the DM *channel* ID returned by the friends API.
  const { userId: channelId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const locationState = location.state as DMPageLocationState | null
  const jumpIdFromState = locationState?.jumpToMessageId
  const jumpBehaviorFromState = locationState?.jumpBehavior ?? 'direct-scroll'
  const jumpPositionFromState = locationState?.jumpToMessagePosition ?? null
  const [jumpRequest, setJumpRequest] = useState<JumpRequest | null>(null)

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

  const { data: participantUser } = useQuery({
    queryKey: ['user', participantId],
    queryFn: async () => {
      if (!participantId) return null
      const res = await userApi.userUserIdGet({ userId: participantId })
      return res.data ?? null
    },
    enabled: !!participantId,
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
    const name = participantUser?.name ?? dmChannel?.name ?? channelId
    return `@${name}`
  }, [isGroupDm, dmChannel?.name, participantUser?.name, channelId])

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
  const lastSearchParamsRef = useRef<{ chips: AppliedFilter[]; text: string } | null>(null)
  const searchBarRef = useRef<SearchBarHandle>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

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

  if (!channelId) return null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* DM Header */}
      <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
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

        <div className="ml-auto flex items-center gap-2">
          <SearchBar
            ref={searchBarRef}
            className="w-60 focus-within:w-80 transition-[width] duration-200 h-7 rounded-md border border-input bg-muted/30 px-2"
            members={dmMembers}
            allowedFilters={['from', 'has']}
            onSearch={(p) => void doSearch(p, 0)}
            onClear={clearSearch}
            hasResults={hasSearched}
          />
        </div>
      </div>

      {/* Content row */}
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
            onHighlightHandled={handleJumpHandled}
            onLoadGap={loadGap}
            onJumpToPresent={jumpToPresent}
            onAckLatest={ackLatest}
          />
          <MessageInput ref={messageInputRef} channelId={channelId} channelName={displayName} />
        </ChatAttachmentDropZone>

        {/* Search results panel */}
        {hasSearched && (
          <div className={cn('flex min-h-0 flex-col overflow-hidden border-l border-sidebar-border bg-sidebar shrink-0 w-80')}>
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
