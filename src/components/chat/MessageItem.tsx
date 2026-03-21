import { useState, useRef, useEffect, useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Copy,
  Hash,
  MessageSquare,
  MoveRight,
  Pencil,
  Reply as ReplyIcon,
  RotateCcw,
  Spool,
  Trash2,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { messageApi, userApi, rolesApi, guildApi } from '@/api/client'
import { useMessageStore, type PendingMessageAttachmentDraft } from '@/stores/messageStore'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { useAppearanceStore, DEFAULT_FONT_SCALE } from '@/stores/appearanceStore'
import { snowflakeToTime, snowflakeToDate } from '@/lib/snowflake'
import { hasPermission, calculateEffectivePermissions, PermissionBits } from '@/lib/permissions'
import { getTopRoleColor } from '@/lib/memberColors'
import { cn } from '@/lib/utils'
import { parseMessageContent, parseInlineMessageContent, isEmojiOnlyMessage, type MentionResolver } from '@/lib/messageParser'
import { buildMessagePreviewText } from '@/lib/messagePreview'
import MessageAttachments from '@/components/chat/MessageAttachments'
import InviteEmbed from '@/components/chat/InviteEmbed'
import MessageEmbed from '@/components/chat/MessageEmbed'
import GifEmbed from '@/components/chat/GifEmbed'
import { extractGifUrls, isGifOnlyMessage } from '@/lib/gifUrls'
import { useGifStore } from '@/stores/gifStore'
import { subscribeChannel, unsubscribeChannel } from '@/services/wsService'
import type { DtoMessage, DtoMember, DtoGuild } from '@/types'
import { MessageChannelChannelIdGetDirectionEnum, type DtoRole } from '@/client'

/** Extract unique invite codes from a message string.
 *  Matches URLs of the form: http(s)://host/invite/CODE
 *  and also bare paths: /invite/CODE
 */
function extractInviteCodes(content: string): string[] {
  const codes: string[] = []
  const seen = new Set<string>()
  // Match full URLs containing /invite/<code>
  const urlRe = /https?:\/\/[^\s<>]+\/invite\/([A-Za-z0-9_-]+)/g
  let m: RegExpExecArray | null
  while ((m = urlRe.exec(content)) !== null) {
    const code = m[1]
    if (!seen.has(code)) { seen.add(code); codes.push(code) }
  }
  return codes
}

export interface MessageItemProps {
  message: DtoMessage
  isGrouped?: boolean
  resolver?: MentionResolver
  deliveryState?: 'sending' | 'failed'
  pendingAttachmentDrafts?: PendingMessageAttachmentDraft[]
  optimisticCreatedAt?: number
  onRetrySend?: () => void
  onDismiss?: () => void
  attachmentMaxWidth?: number
  threadPreview?: {
    name: string
    topic?: string | null
    previewMessage?: DtoMessage | null
    previewText: string
    onClick: () => void
  }
  threadBadge?: {
    label: string
    onClick?: () => void
  }
  threadAction?: {
    label: string
    onClick: () => void
  }
  replyAction?: {
    label: string
    onClick: () => void
  }
  hideContent?: boolean
  allowEdit?: boolean
  allowDelete?: boolean
  threadListAction?: {
    label: string
    onClick: () => void
  }
  onOpenReference?: (reference: { channelId: string; messageId: string }) => void
}

// Join message type constant
const JOIN_MESSAGE_TYPE = 2
const THREAD_CREATED_MESSAGE_TYPE = 3
const THREAD_INITIAL_MESSAGE_TYPE = 4
const MESSAGE_ITEM_QUERY_STALE_TIME = 5 * 60 * 1000
const MESSAGE_REFERENCE_QUERY_GC_TIME = 60 * 1000
const MESSAGE_REFERENCE_FETCH_LIMIT = 20

// Default English join messages (fallback)
const DEFAULT_JOIN_MESSAGES = [
  'has joined the party!',
  'just landed in the server!',
  'has arrived! Welcome aboard!',
  'joined the conversation. Say hi!',
  'has entered the building!',
  'is here! Time to celebrate!',
]

/**
 * Get a join message for a user based on their ID.
 * The same user will always get the same message.
 */
function getJoinMessage(userId: string | number | undefined, messages: string[]): string {
  if (!userId || messages.length === 0) return messages[0] ?? DEFAULT_JOIN_MESSAGES[0]
  // Use user ID to deterministically select a message
  const hash = String(userId).split('').reduce((acc, char) => acc + char.charCodeAt(0), 0)
  return messages[hash % messages.length]
}

export default function MessageItem({
  message,
  isGrouped = false,
  resolver,
  deliveryState,
  pendingAttachmentDrafts,
  optimisticCreatedAt,
  onRetrySend,
  onDismiss,
  attachmentMaxWidth,
  threadPreview,
  threadBadge,
  threadAction,
  replyAction,
  hideContent = false,
  allowEdit = true,
  allowDelete = true,
  threadListAction,
  onOpenReference,
}: MessageItemProps) {
  const { serverId } = useParams<{ serverId?: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openUserProfile = useUiStore((s) => s.openUserProfile)
  const fontScale = useAppearanceStore((s) => s.fontScale) || DEFAULT_FONT_SCALE

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [suppressEmbedsOpen, setSuppressEmbedsOpen] = useState(false)
  const [suppressEmbedsLoading, setSuppressEmbedsLoading] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Fetch roles and current user's member data for permission checking
  const { data: roles = [] } = useQuery<DtoRole[]>({
    queryKey: ['roles', serverId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: MESSAGE_ITEM_QUERY_STALE_TIME,
    refetchOnMount: false,
  })

  const { data: members = [] } = useQuery<DtoMember[]>({
    queryKey: ['members', serverId],
    queryFn: () => guildApi.guildGuildIdMembersGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: MESSAGE_ITEM_QUERY_STALE_TIME,
    refetchOnMount: false,
  })

  const authorRoleColor = useMemo(() => {
    if (!serverId || !message.author?.id) return undefined
    const member = members.find((m) => String(m.user?.id) === String(message.author!.id))
    return getTopRoleColor(member?.roles, roles)
  }, [members, roles, message.author, serverId])

  const previewAuthorRoleColor = useMemo(() => {
    if (!serverId || !threadPreview?.previewMessage?.author?.id) return undefined
    const member = members.find((m) =>
      String(m.user?.id) === String(threadPreview.previewMessage?.author?.id),
    )
    return getTopRoleColor(member?.roles, roles)
  }, [members, roles, serverId, threadPreview?.previewMessage?.author?.id])

  const referenceMessageId =
    message.type === 1 && message.reference != null
      ? String(message.reference)
      : null
  const referenceChannelId = referenceMessageId
    ? String(message.reference_channel_id ?? message.channel_id)
    : null
  const referencedMessageFromStore = useMessageStore((s) => {
    if (!referenceChannelId || !referenceMessageId) return null
    return (s.messages[referenceChannelId] ?? []).find(
      (candidate) => String(candidate.id) === referenceMessageId,
    ) ?? null
  })

  const { data: fetchedReferencedMessage, isFetched: isReferenceFetched } = useQuery<DtoMessage | null>({
    queryKey: ['message-reference', referenceChannelId, referenceMessageId],
    queryFn: async () => {
      if (!referenceChannelId || !referenceMessageId) return null
      const res = await messageApi.messageChannelChannelIdGet({
        channelId: referenceChannelId as unknown as number,
        from: referenceMessageId as unknown as number,
        direction: MessageChannelChannelIdGetDirectionEnum.Around,
        limit: MESSAGE_REFERENCE_FETCH_LIMIT,
      })
      return (res.data ?? []).find((candidate) => String(candidate.id) === referenceMessageId) ?? null
    },
    enabled: !!referenceChannelId && !!referenceMessageId && referencedMessageFromStore == null,
    staleTime: MESSAGE_ITEM_QUERY_STALE_TIME,
    gcTime: MESSAGE_REFERENCE_QUERY_GC_TIME,
    refetchOnMount: false,
  })

  const referencedMessage = referencedMessageFromStore ?? fetchedReferencedMessage ?? null
  const referencedAuthorRoleColor = useMemo(() => {
    if (!serverId || !referencedMessage?.author?.id) return undefined
    const member = members.find((m) =>
      String(m.user?.id) === String(referencedMessage.author?.id),
    )
    return getTopRoleColor(member?.roles, roles)
  }, [members, referencedMessage?.author?.id, roles, serverId])

  const { data: currentMember } = useQuery<DtoMember>({
    queryKey: ['member', serverId, 'me'],
    queryFn: () => userApi.userMeGuildsGuildIdMemberGet({ guildId: serverId! }).then((r) => r.data),
    enabled: !!serverId,
    staleTime: MESSAGE_ITEM_QUERY_STALE_TIME,
    refetchOnMount: false,
  })

  // Fetch guild to check if current user is owner
  const { data: guild } = useQuery<DtoGuild>({
    queryKey: ['guild', serverId],
    queryFn: () => guildApi.guildGuildIdGet({ guildId: serverId! }).then((r) => r.data!),
    enabled: !!serverId,
    staleTime: MESSAGE_ITEM_QUERY_STALE_TIME,
    refetchOnMount: false,
  })

  // Calculate effective permissions
  const userPermissions = currentMember && roles.length > 0
    ? calculateEffectivePermissions(currentMember, roles)
    : 0

  const removeMessage = useMessageStore((s) => s.removeMessage)
  const updateMessage = useMessageStore((s) => s.updateMessage)
  const currentUser = useAuthStore((s) => s.user)
  const contentHosts = useGifStore((s) => s.contentHosts)
  const authorName = message.author?.name ?? 'Unknown'
  const initials = authorName.charAt(0).toUpperCase()
  const channelId = String(message.channel_id)
  const hasRealMessageId = message.id != null
  const messageId = hasRealMessageId
    ? String(message.id)
    : `pending:${message.nonce ?? authorName}`
  const isOwn = currentUser?.id !== undefined && String(message.author?.id) === String(currentUser.id)
  const isPendingMessage = deliveryState != null
  const isInformationalMessage =
    message.type === JOIN_MESSAGE_TYPE ||
    message.type === THREAD_CREATED_MESSAGE_TYPE ||
    message.type === THREAD_INITIAL_MESSAGE_TYPE

  // Check if current user is the server owner
  const isOwner = currentUser && guild?.owner !== undefined && String(guild.owner) === String(currentUser.id)

  const canManageMessages = isOwner || hasPermission(userPermissions, PermissionBits.MANAGE_MESSAGES)
  const canEditMessage = hasRealMessageId && !isPendingMessage && !isInformationalMessage && isOwn && allowEdit
  const canDeleteMessage = hasRealMessageId && !isPendingMessage && allowDelete && (isOwn || canManageMessages)

  // Highlight messages that mention the current user (@id), @everyone, or @here
  const isMentioned = useMemo(() => {
    const content = message.content ?? ''
    const userId = currentUser?.id !== undefined ? String(currentUser.id) : ''
    if (!userId) return false
    return (
      content.includes(`<@${userId}>`) ||
      content.includes('@everyone') ||
      content.includes('@here')
    )
  }, [message.content, currentUser?.id])

  // Detect emoji-only messages for big rendering (max 9 emoji, no other text)
  const emojiOnly = isEmojiOnlyMessage(message.content ?? '')

  const gifUrls = useMemo(() => extractGifUrls(message.content ?? '', contentHosts), [message.content, contentHosts])
  const gifOnly = isGifOnlyMessage(message.content ?? '', gifUrls)

  // Filter out backend embeds for Tenor/Giphy URLs — we render those ourselves
  // via GifEmbed, so backend embeds for the same URLs would be duplicates.
  const backendEmbeds = useMemo(
    () => (message.embeds ?? []).filter((embed) => {
      const url = embed.url ?? ''
      // Always drop Tenor embeds — the service is being discontinued
      if (url.includes('tenor.com')) return false
      // Drop embeds for providers we render ourselves as GIFs
      if (gifUrls.length > 0 && (
        url.includes('giphy.com') ||
        url.includes('gifer.com') ||
        url.includes('imgur.com')
      )) return false
      // Drop embeds for content-host GIF URLs we render ourselves
      if (contentHosts.length > 0) {
        try {
          const host = new URL(url).hostname
          if (contentHosts.includes(host)) return false
        } catch {
          // not a valid URL — keep the embed
        }
      }
      return true
    }),
    [message.embeds, gifUrls, contentHosts],
  )

  // Use Snowflake ID to derive creation time (more reliable than updated_at for display)
  const createdAtDate = optimisticCreatedAt != null
    ? new Date(optimisticCreatedAt)
    : snowflakeToDate(message.id)
  const timestamp = optimisticCreatedAt != null
    ? createdAtDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : snowflakeToTime(message.id)
  const fullTimestamp = createdAtDate.toLocaleString()
  const isEdited = !!message.updated_at &&
    new Date(message.updated_at).getTime() - createdAtDate.getTime() > 5000

  function handleAuthorClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!message.author?.id) return
    openUserProfile(
      String(message.author.id),
      serverId ?? null,
      e.clientX,
      e.clientY,
      authorName,
    )
  }

  function handleReferencedAuthorClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (!referencedMessage?.author?.id) return
    openUserProfile(
      String(referencedMessage.author.id),
      serverId ?? null,
      e.clientX,
      e.clientY,
      referencedMessage.author.name ?? t('common.unknown'),
    )
  }

  function isThreadPreviewInteractiveTarget(target: EventTarget | null): boolean {
    return target instanceof HTMLElement &&
      target.closest('[data-message-interactive="true"]') != null
  }

  function handleReferencePreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!referenceChannelId || !referenceMessageId || !onOpenReference) return
    if (isThreadPreviewInteractiveTarget(e.target)) return
    onOpenReference({ channelId: referenceChannelId, messageId: referenceMessageId })
  }

  function handleReferencePreviewKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!referenceChannelId || !referenceMessageId || !onOpenReference) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onOpenReference({ channelId: referenceChannelId, messageId: referenceMessageId })
    }
  }

  function handleThreadPreviewClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!threadPreview || isThreadPreviewInteractiveTarget(e.target)) return
    threadPreview.onClick()
  }

  function handleThreadPreviewKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!threadPreview) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      threadPreview.onClick()
    }
  }

  function handleCopy() {
    void navigator.clipboard.writeText(message.content ?? '')
  }

  async function handleMessageUser() {
    if (!message.author?.id) return
    try {
      const res = await userApi.userMeFriendsUserIdGet({ userId: String(message.author.id) })
      const channel = res.data
      await queryClient.invalidateQueries({ queryKey: ['dm-channels'] })
      if (channel.id !== undefined) {
        navigate(`/app/@me/${String(channel.id)}`)
      }
    } catch {
      toast.error(t('memberList.dmFailed'))
    }
  }

  function startEdit() {
    setEditContent(message.content ?? '')
    setEditing(true)
  }

  useEffect(() => {
    if (editing) {
      textareaRef.current?.focus()
      const len = textareaRef.current?.value.length ?? 0
      textareaRef.current?.setSelectionRange(len, len)
    }
  }, [editing])

  async function handleEdit() {
    const trimmed = editContent.trim()
    if (!trimmed || trimmed === message.content) {
      setEditing(false)
      return
    }
    setEditLoading(true)
    try {
      const res = await messageApi.messageChannelChannelIdMessageIdPatch({
        channelId,
        messageId,
        request: { content: trimmed },
      })
      updateMessage(channelId, res.data)
      setEditing(false)
    } catch {
      toast.error(t('messageItem.editFailed'))
    } finally {
      setEditLoading(false)
    }
  }

  function handleEditKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleEdit()
    }
    if (e.key === 'Escape') {
      setEditing(false)
    }
  }

  async function handleDelete() {
    setDeleteLoading(true)
    try {
      await messageApi.messageChannelChannelIdMessageIdDelete({
        channelId,
        messageId,
      })
      removeMessage(channelId, messageId)
      setDeleteOpen(false)
    } catch {
      toast.error(t('messageItem.deleteFailed'))
    } finally {
      setDeleteLoading(false)
    }
  }

  async function handleSuppressEmbeds() {
    setSuppressEmbedsLoading(true)
    try {
      const res = await messageApi.messageChannelChannelIdMessageIdPatch({
        channelId,
        messageId,
        request: { embeds: [], flags: 4 },
      })
      updateMessage(channelId, res.data)
      setSuppressEmbedsOpen(false)
    } catch {
      toast.error(t('messageItem.editFailed'))
    } finally {
      setSuppressEmbedsLoading(false)
    }
  }

  // Check if this is a join message
  const isJoinMessage = message.type === JOIN_MESSAGE_TYPE
  const isThreadCreatedMessage = message.type === THREAD_CREATED_MESSAGE_TYPE
  const previewThreadId = threadPreview && message.thread_id != null
    ? String(message.thread_id)
    : null

  useEffect(() => {
    if (!previewThreadId) return
    subscribeChannel(previewThreadId)
    return () => {
      unsubscribeChannel(previewThreadId)
    }
  }, [previewThreadId])

  let joinMessages: string[] = DEFAULT_JOIN_MESSAGES
  if (isJoinMessage) {
    try {
      const translationResult = t('joinMessages', { returnObjects: true })
      joinMessages = Array.isArray(translationResult) ? translationResult : DEFAULT_JOIN_MESSAGES
    } catch {
      joinMessages = DEFAULT_JOIN_MESSAGES
    }
  }

  const threadLabel = threadPreview?.name ?? threadBadge?.label ?? message.thread?.name ?? message.content ?? t('threads.threadFallback')
  const replyPreviewText = referencedMessage
    ? buildMessagePreviewText(referencedMessage, {
        emptyText: t('messageItem.replyUnavailable'),
        embedsText: t('messageItem.replyEmbeds'),
        attachmentsText: (count) => t('messageItem.replyAttachments', { count }),
        maxLength: 128,
      })
    : !isReferenceFetched && referencedMessageFromStore == null
      ? t('common.loading')
      : t('messageItem.replyUnavailable')
  const replyPreviewAuthorName = referencedMessage?.author?.name?.trim() || t('common.unknown')
  const canOpenReference = !!referenceChannelId && !!referenceMessageId && !!onOpenReference
  const showReplyPreview = message.type === 1 && referenceMessageId != null
  const informationalContent = isJoinMessage ? (
    <>{getJoinMessage(message.author?.id, joinMessages)}</>
  ) : isThreadCreatedMessage ? (
    <>
      {t('threads.threadCreatedStarted')}{' '}
      {(threadPreview ?? threadAction) ? (
        <button
          type="button"
          onClick={() => {
            threadPreview?.onClick()
            if (!threadPreview) threadAction?.onClick()
          }}
          className="font-medium text-foreground hover:underline"
        >
          {threadLabel}
        </button>
      ) : (
        <span className="font-medium text-foreground">{threadLabel}</span>
      )}
      .{' '}
      {t('threads.threadCreatedSeeAll')}{' '}
      {threadListAction ? (
        <button
          type="button"
          onClick={threadListAction.onClick}
          className="font-medium text-foreground hover:underline"
        >
          {t('threads.threadCreatedThreadsLink')}
        </button>
      ) : (
        <span className="font-medium text-foreground">{t('threads.threadCreatedThreadsLink')}</span>
      )}
      .
    </>
  ) : null
  const useInlineInformationalLayout = informationalContent != null
  const informationalIcon = isJoinMessage ? (
    <MoveRight className="h-4 w-4 text-green-500" />
  ) : isThreadCreatedMessage ? (
    <Spool className="h-4 w-4 text-muted-foreground" />
  ) : null
  const deliveryStateContent = deliveryState === 'failed' ? (
    <div className="mt-2 inline-flex items-center gap-2 rounded-full bg-red-500/12 px-2.5 py-1 text-[11px] font-medium text-red-300">
      <AlertCircle className="h-3.5 w-3.5" />
      <span>{t('messageItem.failedToSend')}</span>
      {onRetrySend && (
        <button
          type="button"
          onClick={onRetrySend}
          className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-200 transition-colors hover:bg-red-500/25"
        >
          <RotateCcw className="h-3 w-3" />
          {t('messageItem.retrySend')}
        </button>
      )}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex items-center justify-center rounded-full p-0.5 text-red-300/70 transition-colors hover:bg-red-500/20 hover:text-red-200"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ) : null

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={cn(
            'flex items-start gap-3 rounded px-2 group',
            isGrouped ? 'py-0.5' : 'py-1',
            deliveryState === 'sending' && 'opacity-70',
            deliveryState === 'failed' && 'bg-red-500/8 hover:bg-red-500/12',
            deliveryState == null && 'hover:bg-accent/40',
            isMentioned && 'bg-yellow-500/10 hover:bg-yellow-500/15 border-l-2 border-yellow-500/60 pl-[6px]',
          )}>
            {isGrouped ? (
              /* Compact grouped row: no avatar — hover reveals timestamp in left gutter */
              <div className="w-9 shrink-0 flex items-center justify-end mt-0.5">
                <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity leading-none tabular-nums select-none">
                  {timestamp}
                </span>
              </div>
            ) : useInlineInformationalLayout ? (
              <div className="w-9 shrink-0 flex items-center justify-center mt-1">
                {informationalIcon}
              </div>
            ) : (
              /* Full row: clickable avatar */
              <button
                onClick={handleAuthorClick}
                className="shrink-0 mt-0.5 rounded-full focus:outline-none"
                tabIndex={-1}
              >
                <Avatar className="w-9 h-9">
                  <AvatarImage src={message.author?.avatar?.url} alt={authorName} className="object-cover" />
                  <AvatarFallback className="text-sm">{initials}</AvatarFallback>
                </Avatar>
              </button>
            )}

            <div className="min-w-0 flex-1">
              {!isGrouped && !useInlineInformationalLayout && (
                <div className="flex items-baseline gap-2">
                  {/* Clickable author name */}
                  <button
                    onClick={handleAuthorClick}
                    className="font-semibold text-sm hover:underline focus:outline-none"
                    style={authorRoleColor ? { color: authorRoleColor } : undefined}
                  >
                    {authorName}
                  </button>
                  <span
                    className="text-xs text-muted-foreground tabular-nums"
                    title={fullTimestamp}
                  >
                    {timestamp}
                  </span>
                  {isEdited && (
                    <span className="text-xs text-muted-foreground">{t('messageItem.edited')}</span>
                  )}
                </div>
              )}

              {editing ? (
                <div className="mt-1 space-y-1">
                  <Textarea
                    ref={textareaRef}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    onKeyDown={handleEditKeyDown}
                    rows={2}
                    className="resize-none text-sm"
                    disabled={editLoading}
                  />
                  <p className="text-xs text-muted-foreground">
                    {t('messageItem.enterTo')}
                    <button
                      type="button"
                      onClick={() => void handleEdit()}
                      disabled={editLoading}
                      className="text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50 cursor-pointer"
                    >
                      {t('messageItem.save')}
                    </button>
                    {t('messageItem.escTo')}
                    <button
                      type="button"
                      onClick={() => setEditing(false)}
                      disabled={editLoading}
                      className="text-primary underline underline-offset-2 hover:opacity-80 disabled:opacity-50 cursor-pointer"
                    >
                      {t('messageItem.cancel')}
                    </button>
                  </p>
                </div>
              ) : (
                <>
                  {showReplyPreview && (
                    <div
                      role={canOpenReference ? 'button' : undefined}
                      tabIndex={canOpenReference ? 0 : undefined}
                      onClick={handleReferencePreviewClick}
                      onKeyDown={handleReferencePreviewKeyDown}
                      className={cn(
                        'mb-1.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground',
                        canOpenReference && 'cursor-pointer',
                      )}
                    >
                      <ReplyIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      {referencedMessage?.author && (
                        <Avatar className="h-4 w-4 shrink-0">
                          <AvatarImage
                            src={referencedMessage.author.avatar?.url}
                            alt={referencedMessage.author.name ?? 'User'}
                            className="object-cover"
                          />
                          <AvatarFallback className="text-[9px]">
                            {(referencedMessage.author.name ?? '?').charAt(0).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <div className="flex min-w-0 items-center gap-1.5">
                        {referencedMessage?.author?.name && (
                          <button
                            type="button"
                            onClick={handleReferencedAuthorClick}
                            data-message-interactive="true"
                            className="shrink-0 font-medium hover:underline"
                            style={referencedAuthorRoleColor ? { color: referencedAuthorRoleColor } : { color: 'var(--foreground)' }}
                          >
                            {replyPreviewAuthorName}
                          </button>
                        )}
                        <div className="min-w-0 line-clamp-1 break-words">
                          {parseInlineMessageContent(replyPreviewText, resolver, `reply-preview-${messageId}`)}
                        </div>
                      </div>
                    </div>
                  )}
                  {useInlineInformationalLayout && (
                    <div className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 gap-y-1 text-sm leading-relaxed text-muted-foreground">
                      <button
                        onClick={handleAuthorClick}
                        className="font-semibold hover:underline focus:outline-none"
                        style={authorRoleColor ? { color: authorRoleColor } : { color: 'var(--foreground)' }}
                      >
                        {authorName}
                      </button>
                      <span>{informationalContent}</span>
                      <span
                        className="text-xs text-muted-foreground tabular-nums"
                        title={fullTimestamp}
                      >
                        {timestamp}
                      </span>
                      {isEdited && (
                        <span className="text-xs text-muted-foreground">{t('messageItem.edited')}</span>
                      )}
                    </div>
                  )}
                  {/* Parsed message content with inline markdown */}
                  {!informationalContent && !hideContent && message.content && !gifOnly && (
                    <div
                      className={cn(
                        'break-words whitespace-pre-wrap',
                        emojiOnly ? 'leading-none py-1' : 'text-sm leading-relaxed',
                      )}
                      style={{ fontSize: emojiOnly ? '2.5rem' : `${fontScale}rem` }}
                    >
                      {parseMessageContent(message.content, resolver)}
                    </div>
                  )}
                  {/* Tenor / Giphy GIF embeds */}
                  {gifUrls.map((g) => (
                    <GifEmbed key={g.url} gifUrl={g} gifOnly={gifOnly} />
                  ))}
                  {/* Attachments */}
                  <MessageAttachments
                    attachments={message.attachments}
                    pendingAttachments={pendingAttachmentDrafts}
                    maxWidth={attachmentMaxWidth}
                  />
                  {/* Message embeds (rich, video, image, link, article, gifv) */}
                  {backendEmbeds.length > 0 && (
                    <div className="relative group/embeds w-fit">
                      {backendEmbeds.map((embed, i) => (
                        <MessageEmbed key={i} embed={embed} />
                      ))}
                      {isOwn && (
                        <button
                          type="button"
                          onClick={() => setSuppressEmbedsOpen(true)}
                          className="absolute -top-2 -right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-muted border border-border text-muted-foreground opacity-0 group-hover/embeds:opacity-100 transition-opacity hover:bg-destructive hover:text-destructive-foreground hover:border-destructive"
                          aria-label="Remove embeds"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  )}
                  {/* Invite embeds */}
                  {message.content && extractInviteCodes(message.content).map((code) => (
                    <InviteEmbed key={code} code={code} />
                  ))}
                  {!informationalContent && threadPreview && (
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={handleThreadPreviewClick}
                      onKeyDown={handleThreadPreviewKeyDown}
                      className="mt-2 inline-flex w-fit max-w-[min(100%,42rem)] min-w-0 cursor-pointer flex-col overflow-hidden rounded-md border border-border/80 bg-muted/30 transition-colors hover:bg-muted/40 focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <div className="flex max-w-full min-w-0 items-center gap-2 border-b border-border/60 px-3 py-2">
                        <Spool className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 truncate text-sm font-semibold text-foreground">
                          {threadPreview.name}
                        </span>
                        {threadPreview.topic && (
                          <span className="min-w-0 truncate text-xs text-muted-foreground">
                            - {threadPreview.topic}
                          </span>
                        )}
                      </div>

                      <div className="flex max-w-full min-w-0 items-start gap-2 px-3 py-2">
                        {threadPreview.previewMessage?.author && (
                          <Avatar className="mt-0.5 h-6 w-6 shrink-0">
                            <AvatarImage
                              src={threadPreview.previewMessage.author.avatar?.url}
                              alt={threadPreview.previewMessage.author.name ?? 'User'}
                              className="object-cover"
                            />
                            <AvatarFallback className="text-[10px]">
                              {(threadPreview.previewMessage.author.name ?? '?').charAt(0).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                        )}
                        <div className="max-w-full min-w-0">
                          {threadPreview.previewMessage?.author?.name && (
                            <div
                              className="truncate text-xs font-medium text-foreground"
                              style={previewAuthorRoleColor ? { color: previewAuthorRoleColor } : undefined}
                            >
                              {threadPreview.previewMessage.author.name}
                            </div>
                          )}
                          <div className="mt-0.5 truncate text-xs leading-relaxed text-muted-foreground">
                            {parseMessageContent(threadPreview.previewText, resolver)}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {!informationalContent && threadBadge && (
                    threadBadge.onClick ? (
                      <button
                        type="button"
                        onClick={threadBadge.onClick}
                        className="mt-2 inline-flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        <Spool className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="truncate">{threadBadge.label}</span>
                      </button>
                    ) : (
                      <span className="mt-2 inline-flex items-center gap-2 rounded-md border border-dashed border-border bg-muted/20 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                        <Spool className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="truncate">{threadBadge.label}</span>
                      </span>
                    )
                  )}
                  {deliveryStateContent}
                </>
              )}
            </div>
          </div>
        </ContextMenuTrigger>

        <ContextMenuContent>
          <ContextMenuItem onClick={handleCopy} className="gap-2">
            <Copy className="w-4 h-4" />
            {t('messageItem.copyText')}
          </ContextMenuItem>
          {replyAction && (
            <ContextMenuItem onClick={replyAction.onClick} className="gap-2">
              <ReplyIcon className="w-4 h-4" />
              {replyAction.label}
            </ContextMenuItem>
          )}
          {hasRealMessageId && (
            <ContextMenuItem
              onClick={() => { void navigator.clipboard.writeText(messageId) }}
              className="gap-2"
            >
              <Hash className="w-4 h-4" />
              {t('messageItem.copyMessageId')}
            </ContextMenuItem>
          )}
          {threadAction && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={threadAction.onClick} className="gap-2">
                <Spool className="w-4 h-4" />
                {threadAction.label}
              </ContextMenuItem>
            </>
          )}
          {canEditMessage && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={startEdit} className="gap-2">
                <Pencil className="w-4 h-4" />
                {t('messageItem.editMessage')}
              </ContextMenuItem>
            </>
          )}
          {!isOwn && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => void handleMessageUser()} className="gap-2">
                <MessageSquare className="w-4 h-4" />
                {t('messageItem.messageUser')}
              </ContextMenuItem>
            </>
          )}
          {canDeleteMessage && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {t('messageItem.deleteMessage')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={suppressEmbedsOpen} onOpenChange={(o) => !o && setSuppressEmbedsOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('messageItem.suppressEmbedsTitle')}</DialogTitle>
            <DialogDescription>
              {t('messageItem.suppressEmbedsDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSuppressEmbedsOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleSuppressEmbeds()} disabled={suppressEmbedsLoading}>
              {t('messageItem.suppressEmbedsConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(o) => !o && setDeleteOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('messageItem.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('messageItem.deleteDesc')}
            </DialogDescription>
          </DialogHeader>
          {message.content && (
            <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground italic break-all overflow-hidden min-w-0">
              {message.content.length > 200
                ? message.content.slice(0, 200) + '…'
                : message.content}
            </blockquote>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleteLoading}>
              {t('messageItem.deleteMessage')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
