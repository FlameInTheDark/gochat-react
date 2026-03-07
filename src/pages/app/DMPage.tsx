import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Users } from 'lucide-react'
import { subscribeChannel } from '@/services/wsService'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import SearchBar, { type SearchBarHandle, type AppliedFilter } from '@/components/chat/SearchBar'
import SearchPanel from '@/components/chat/SearchPanel'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import { userApi, searchApi } from '@/api/client'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import { ChannelType } from '@/types'
import type { DtoMember, DtoMessage } from '@/types'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

export default function DMPage() {
  // NOTE: the route param is named :userId but by the time we land here the
  // navigation target is the DM *channel* ID returned by the friends API.
  const { userId: channelId } = useParams<{ userId: string }>()
  const {
    messages, isLoading, isLoadingOlder, isLoadingNewer,
    endReached, latestReached, unreadSeparatorAfter,
    loadOlder, loadNewer, ackLatest,
  } = useMessagePagination(channelId)

  useEffect(() => {
    if (channelId) subscribeChannel(channelId)
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

  const displayName = useMemo(() => {
    if (isGroupDm) return dmChannel?.name ?? 'Group'
    const name = participantUser?.name ?? dmChannel?.name ?? channelId
    return `@${name}`
  }, [isGroupDm, dmChannel?.name, participantUser?.name, channelId])

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

  // Clear search when channel changes
  useEffect(() => {
    clearSearch()
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps

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

  function clearSearch() {
    setSearchResults([])
    setSearchTotalPages(0)
    setSearchPage(0)
    setIsSearching(false)
    setHasSearched(false)
    lastSearchParamsRef.current = null
    searchBarRef.current?.clear()
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
        <div className="flex flex-col flex-1 min-w-0">
          <MessageList
            messages={messages}
            isLoading={isLoading}
            isLoadingOlder={isLoadingOlder}
            isLoadingNewer={isLoadingNewer}
            endReached={endReached}
            latestReached={latestReached}
            unreadSeparatorAfter={unreadSeparatorAfter}
            onLoadOlder={loadOlder}
            onLoadNewer={loadNewer}
            onAckLatest={ackLatest}
          />
          <MessageInput channelId={channelId} channelName={displayName} />
        </div>

        {/* Search results panel */}
        {hasSearched && (
          <div className={cn('flex flex-col border-l border-sidebar-border bg-sidebar shrink-0 w-80')}>
            <SearchPanel
              serverId=""
              results={searchResults}
              channels={[]}
              isLoading={isSearching}
              hasSearched={hasSearched}
              page={searchPage}
              totalPages={searchTotalPages}
              onPageChange={goToPage}
              className="flex-1 min-h-0"
            />
          </div>
        )}
      </div>
    </div>
  )
}
