import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Hash, Volume2, MicOff, Headphones, Users, Search } from 'lucide-react'
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
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
          {isConnected ? (
            <>
              <p className="text-sm text-muted-foreground">
                {peerEntries.length === 0
                  ? t('channel.connected', { count: 1 })
                  : t('channel.connected_plural', { count: peerEntries.length + 1 })}
              </p>

              <div className="flex flex-wrap justify-center gap-4">
                {/* Local user */}
                <VoiceParticipant
                  label={`${currentUser?.name ?? t('channel.you')} (You)`}
                  avatarUrl={currentUser?.avatar?.url}
                  speaking={false}
                  muted={localMuted}
                  deafened={localDeafened}
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
        <TypingIndicator channelId={channelId} />
        <MessageInput channelId={channelId} channelName={channel?.name} />
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

function VoiceParticipant({
  label,
  avatarUrl,
  speaking,
  muted,
  deafened,
}: {
  label: string
  avatarUrl?: string
  speaking: boolean
  muted: boolean
  deafened?: boolean
}) {
  const initials = label.charAt(0).toUpperCase()
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <Avatar
          className={cn(
            'w-16 h-16 transition-all',
            speaking && 'ring-2 ring-green-500 ring-offset-2 ring-offset-background',
          )}
        >
          {avatarUrl && <AvatarImage src={avatarUrl} alt={label} className="object-cover" />}
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        {/* Status indicator: show deafen over mute, or just one */}
        {deafened ? (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-destructive flex items-center justify-center">
            <Headphones className="w-3 h-3 text-white" />
          </div>
        ) : muted ? (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-destructive flex items-center justify-center">
            <MicOff className="w-3 h-3 text-white" />
          </div>
        ) : null}
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-[64px]">{label}</span>
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
  peer: { speaking: boolean; muted: boolean; deafened?: boolean }
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
    />
  )
}
