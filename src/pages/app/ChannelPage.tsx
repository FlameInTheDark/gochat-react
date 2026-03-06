import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Hash, Volume2, MicOff, HeadphoneOff, Users, Search } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { guildApi, rolesApi } from '@/api/client'
import { useVoiceStore } from '@/stores/voiceStore'
import { ChannelType } from '@/types'
import type { ServerOutletContext } from './ServerLayout'
import type { MentionResolver } from '@/lib/messageParser'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import MemberList from '@/components/layout/MemberList'
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
  const [showSearch, setShowSearch] = useState(false)

  // Jump-to-message from search.
  //
  // Strategy: read the ID from route state once, immediately clear the route
  // state (prevents replay on back-navigation / refresh), but persist the ID
  // in local state so it survives the state-clear and remains available for
  // MessageList to highlight the message AFTER the async load completes.
  // Auto-clear after 3 s (animation is 2.5 s) so new arrivals don't re-scroll.
  const jumpIdFromState =
    (location.state as { jumpToMessageId?: string } | null)?.jumpToMessageId

  const [jumpToMessageId, setJumpToMessageId] = useState<string | undefined>(
    jumpIdFromState,
  )

  // Capture a new jump from route state and clear the route state.
  useEffect(() => {
    if (!jumpIdFromState) return
    setJumpToMessageId(jumpIdFromState)
    navigate(location.pathname, { replace: true, state: {} })
  }, [jumpIdFromState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clear local jump ID after the highlight animation finishes.
  useEffect(() => {
    if (!jumpToMessageId) return
    const t = setTimeout(() => setJumpToMessageId(undefined), 3_000)
    return () => clearTimeout(t)
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
  const localCameraEnabled = useVoiceStore((s) => s.localCameraEnabled)
  const localVideoStream = useVoiceStore((s) => s.localVideoStream)

  // Get current user for avatar display in voice
  const currentUser = useAuthStore((s) => s.user)

  // Guild data for mention resolution in messages — reuse cached queries
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

  // Subscribe to real-time messages for this channel
  // (read state is managed by useMessagePagination / readStateStore)
  useEffect(() => {
    if (channelId) subscribeChannel(channelId)
  }, [channelId])

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
    // Filter out the current user from peers since we render them separately
    const currentUserId = String(currentUser?.id ?? '')
    const peerEntries = Object.entries(voicePeers).filter(([userId]) => userId !== currentUserId)

    return (
      <div className="flex flex-col flex-1 min-h-0">
        {/* Channel header */}
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

        {/* Voice participants */}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 overflow-auto">
          {isConnected ? (
            <>
              <p className="text-sm text-muted-foreground">
                {peerEntries.length === 0
                  ? t('channel.connected', { count: 1 })
                  : t('channel.connected_plural', { count: peerEntries.length + 1 })}
              </p>

              <div className="flex flex-wrap justify-center gap-4 w-full">
                {/* Local user */}
                <VoiceParticipant
                  label={`${currentUser?.name ?? t('channel.you')} (${t('channel.you')})`}
                  avatarUrl={currentUser?.avatar?.url}
                  speaking={false}
                  muted={localMuted}
                  deafened={localDeafened}
                  videoStream={localCameraEnabled ? localVideoStream : null}
                  isLocal
                />
                {/* Remote peers */}
                {peerEntries.map(([userId, peer]) => (
                  <VoiceParticipantRemote
                    key={userId}
                    userId={userId}
                    peer={peer}
                    members={members}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>
    )
  }

  // Text channel view
  return (
    <div className="flex flex-1 min-h-0">
      {/* Main chat column */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Channel header */}
        <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-semibold">{channel?.name ?? channelId}</span>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="h-5 mx-1" />
              <span className="text-sm text-muted-foreground truncate">{channel.topic}</span>
            </>
          )}

          {/* Toolbar */}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setShowSearch((v) => !v)}
              title={showSearch ? t('channel.closeSearch') : t('channel.searchMessages')}
              className={cn(
                'w-8 h-8 flex items-center justify-center rounded transition-colors',
                showSearch
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Search className="w-4 h-4" />
            </button>
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
          </div>
        </div>

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

      {/* Search panel */}
      {showSearch && serverId && (
        <SearchPanel
          serverId={serverId}
          channelId={channelId}
          channels={channels}
          members={members}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Member list sidebar */}
      {showMembers && serverId && <MemberList serverId={serverId} />}
    </div>
  )
}

/**
 * Attaches a MediaStream to a <video> element.
 * For remote streams, calls onFrozen/onActive based on whether new frames
 * are being decoded — used to detect when the sender disables their camera
 * without a mute event from the SFU.
 */
function VideoFeed({
  stream,
  mirror = false,
  onFrozen,
  onActive,
}: {
  stream: MediaStream
  mirror?: boolean
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

  // Freeze detection: poll totalVideoFrames every second.
  // If it stops advancing for 3 consecutive checks (~3 s), the track is frozen.
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
      className={cn('w-full h-full object-cover rounded-lg', mirror && '[transform:scaleX(-1)]')}
    />
  )
}

function VoiceParticipant({
  label,
  avatarUrl,
  speaking,
  muted,
  deafened,
  videoStream,
  isLocal,
}: {
  label: string
  avatarUrl?: string
  speaking: boolean
  muted: boolean
  deafened?: boolean
  videoStream?: MediaStream | null
  isLocal?: boolean
}) {
  const initials = label.charAt(0).toUpperCase()

  // Local freeze-detection state for remote streams.
  // When the sender silences their track, the SFU stops forwarding frames but
  // doesn't immediately send a mute event — the video element freezes on the
  // last frame. We detect this and hide the tile until frames resume.
  const [frozenLocally, setFrozenLocally] = useState(false)

  // Reset frozen state whenever the stream identity changes (new camera session)
  useEffect(() => { setFrozenLocally(false) }, [videoStream])

  const handleFrozen = useCallback(() => setFrozenLocally(true), [])
  const handleActive = useCallback(() => setFrozenLocally(false), [])

  // Local user's camera state is controlled directly via localCameraEnabled —
  // no need for freeze detection.
  const hasVideo = !!videoStream && (isLocal || !frozenLocally)

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className={cn(
          'relative overflow-hidden transition-all duration-150',
          hasVideo
            ? 'w-48 h-36 rounded-lg bg-zinc-900'
            : 'w-16 h-16 rounded-full',
          speaking && hasVideo && 'ring-2 ring-green-500 ring-offset-2 ring-offset-background',
        )}
      >
        {hasVideo ? (
          <>
            <VideoFeed
              key={videoStream!.id}
              stream={videoStream!}
              mirror={isLocal}
              onFrozen={isLocal ? undefined : handleFrozen}
              onActive={isLocal ? undefined : handleActive}
            />
            {/* Overlay: name + status icons at bottom */}
            <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-black/50 flex items-center justify-between gap-1">
              <span className="text-xs text-white truncate">{label}</span>
              <div className="flex items-center gap-1 shrink-0">
                {deafened ? (
                  <HeadphoneOff className="w-3 h-3 text-destructive" />
                ) : muted ? (
                  <MicOff className="w-3 h-3 text-destructive" />
                ) : null}
              </div>
            </div>
            {/* Speaking ring on video */}
            {speaking && (
              <div className="absolute inset-0 ring-2 ring-green-500 rounded-lg pointer-events-none" />
            )}
          </>
        ) : (
          <>
            <Avatar
              className={cn(
                'w-16 h-16 transition-all duration-150',
                speaking && 'ring-2 ring-green-500 ring-offset-2 ring-offset-background',
              )}
            >
              {avatarUrl && <AvatarImage src={avatarUrl} alt={label} className="object-cover" />}
              <AvatarFallback className="text-lg">{initials}</AvatarFallback>
            </Avatar>
            {/* Status indicator */}
            {deafened ? (
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-destructive flex items-center justify-center">
                <HeadphoneOff className="w-3 h-3 text-white" />
              </div>
            ) : muted ? (
              <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-destructive flex items-center justify-center">
                <MicOff className="w-3 h-3 text-white" />
              </div>
            ) : null}
          </>
        )}
      </div>
      {/* Label only shown for avatar mode (video mode has inline label) */}
      {!hasVideo && (
        <span className="text-xs text-muted-foreground truncate max-w-[80px]">{label}</span>
      )}
    </div>
  )
}

// Separate component for remote peers to handle member lookup with proper reactivity
function VoiceParticipantRemote({
  userId,
  peer,
  members,
}: {
  userId: string
  peer: { speaking: boolean; muted: boolean; deafened?: boolean; videoStream: MediaStream | null }
  members: { user?: { id?: number; name?: string; avatar?: { url?: string } }; username?: string }[] | undefined
}) {
  // Find member - compare as strings since userId from voice is string, member.user.id is number
  const member = members?.find((m) => String(m.user?.id) === userId)
  const displayName = member?.username ?? member?.user?.name ?? `User ${userId.slice(0, 6)}`
  const avatarUrl = member?.user?.avatar?.url

  return (
    <VoiceParticipant
      label={displayName}
      avatarUrl={avatarUrl}
      speaking={peer.speaking}
      muted={peer.muted}
      deafened={peer.deafened}
      videoStream={peer.videoStream}
    />
  )
}

