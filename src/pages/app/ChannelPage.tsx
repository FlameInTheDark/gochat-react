import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Hash, Volume2, MicOff, HeadphoneOff, Users } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { guildApi, rolesApi, searchApi } from '@/api/client'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import { useVoiceStore } from '@/stores/voiceStore'
import { ChannelType } from '@/types'
import type { DtoMessage } from '@/types'
import type { ServerOutletContext } from './ServerLayout'
import type { MentionResolver } from '@/lib/messageParser'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import MemberList from '@/components/layout/MemberList'
import SearchBar, { type SearchBarHandle, type AppliedFilter } from '@/components/chat/SearchBar'
import SearchPanel from '@/components/chat/SearchPanel'
import { subscribeChannel } from '@/services/wsService'
import { joinVoice } from '@/services/voiceService'
import { toast } from 'sonner'
import { useUiStore } from '@/stores/uiStore'
import { useAuthStore } from '@/stores/authStore'
import TypingIndicator from '@/components/chat/TypingIndicator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import { useTranslation } from 'react-i18next'

export default function ChannelPage() {
  const { channelId, serverId } = useParams<{ channelId: string; serverId: string }>()
  const { channels } = useOutletContext<ServerOutletContext>()
  const channel = channels.find((c) => String(c.id) === channelId)
  const isVoice = channel?.type === ChannelType.ChannelTypeGuildVoice

  const navigate = useNavigate()
  const location = useLocation()
  const { t } = useTranslation()

  const [showMembers, setShowMembers] = useState(true)

  // ── Search state ────────────────────────────────────────────────────────────
  const [searchResults, setSearchResults] = useState<DtoMessage[]>([])
  const [searchTotalPages, setSearchTotalPages] = useState(0)
  const [searchPage, setSearchPage] = useState(0)
  const [isSearching, setIsSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)
  const lastSearchParamsRef = useRef<{ chips: AppliedFilter[]; text: string } | null>(null)
  const searchBarRef = useRef<SearchBarHandle>(null)

  // Jump-to-message from search.
  const jumpIdFromState =
    (location.state as { jumpToMessageId?: string } | null)?.jumpToMessageId

  const [jumpToMessageId, setJumpToMessageId] = useState<string | undefined>(
    jumpIdFromState,
  )

  useEffect(() => {
    if (!jumpIdFromState) return
    setJumpToMessageId(jumpIdFromState)
    navigate(location.pathname, { replace: true, state: {} })
  }, [jumpIdFromState]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jumpToMessageId) return
    const timer = setTimeout(() => setJumpToMessageId(undefined), 3_000)
    return () => clearTimeout(timer)
  }, [jumpToMessageId])

  const {
    messages, isLoading, isLoadingOlder, isLoadingNewer,
    endReached, latestReached, unreadSeparatorAfter,
    loadOlder, loadNewer, ackLatest,
  } = useMessagePagination(
    isVoice ? undefined : channelId,
    jumpToMessageId,
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
      channel: (id) => channels.find((c) => String(c.id) === id)?.name,
      role: (id) => roles?.find((r) => String(r.id) === id)?.name,
      onUserClick: handleUserClick,
      onChannelClick: handleChannelClick,
    }),
    [members, channels, roles, handleUserClick, handleChannelClick],
  )

  useEffect(() => {
    if (channelId) subscribeChannel(channelId)
  }, [channelId])

  // Clear search when navigating to a different channel
  useEffect(() => {
    clearSearch()
  }, [channelId]) // eslint-disable-line react-hooks/exhaustive-deps

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
            <button
              onClick={() => void handleJoinVoice()}
              className="mt-2 px-5 py-2 rounded-md bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-colors"
            >
              {t('channel.joinVoice')}
            </button>
          </div>
        )}
      </div>
    )
  }

  // Text channel view
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Full-width header */}
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
          <button
            onClick={() => setShowMembers((v) => !v)}
            title={showMembers ? t('channel.hideMemberList') : t('channel.showMemberList')}
            className={cn(
              'w-8 h-8 flex items-center justify-center rounded transition-colors',
              showMembers
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
            highlightMessageId={jumpToMessageId}
            channelName={channel?.name}
            resolver={mentionResolver}
            onLoadOlder={loadOlder}
            onLoadNewer={loadNewer}
            onAckLatest={ackLatest}
          />
          <TypingIndicator channelId={channelId} serverId={serverId ?? ''} />
          <MessageInput
            channelId={channelId}
            channelName={
              channel?.type === ChannelType.ChannelTypeGuildVoice
                ? `🔊 ${channel?.name ?? channelId}`
                : `#${channel?.name ?? channelId}`
            }
          />
        </div>

        {/* Right panel: results OR members */}
        {(hasSearched || showMembers) && serverId && (
          <div className={cn(
            'flex flex-col border-l border-sidebar-border bg-sidebar shrink-0',
            hasSearched ? 'w-80' : 'w-60',
          )}>
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
                resolver={mentionResolver}
                className="flex-1 min-h-0"
              />
            ) : (
              <MemberList serverId={serverId} channel={channel} />
            )}
          </div>
        )}
      </div>
    </div>
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
  const [frozenLocally, setFrozenLocally] = useState(false)
  const [videoAspect, setVideoAspect] = useState<number | null>(null)
  useEffect(() => { setFrozenLocally(false); setVideoAspect(null) }, [videoStream])
  const handleFrozen = useCallback(() => setFrozenLocally(true), [])
  const handleActive = useCallback(() => setFrozenLocally(false), [])
  const hasVideo = !!videoStream && (isLocal || !frozenLocally)

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
              onAspect={size === 'spotlight' ? setVideoAspect : undefined}
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

