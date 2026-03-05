import { useState, useRef, useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQueryClient, useQuery } from '@tanstack/react-query'
import { Trash2, Pencil, Copy, MessageSquare, Hash } from 'lucide-react'
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
import { useMessageStore } from '@/stores/messageStore'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { useAppearanceStore, DEFAULT_FONT_SCALE } from '@/stores/appearanceStore'
import { snowflakeToTime, snowflakeToDate } from '@/lib/snowflake'
import { hasPermission, calculateEffectivePermissions, PermissionBits } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { parseMessageContent, extractYouTubeEmbeds, type MentionResolver } from '@/lib/messageParser'
import MessageAttachments from '@/components/chat/MessageAttachments'
import InviteEmbed from '@/components/chat/InviteEmbed'
import YoutubeEmbed from '@/components/chat/YoutubeEmbed'
import type { DtoMessage, DtoMember, DtoGuild } from '@/types'
import type { DtoRole } from '@/client'

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

interface Props {
  message: DtoMessage
  isGrouped?: boolean
  resolver?: MentionResolver
}

// Join message type constant
const JOIN_MESSAGE_TYPE = 2

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

export default function MessageItem({ message, isGrouped = false, resolver }: Props) {
  const { serverId } = useParams<{ serverId?: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const openUserProfile = useUiStore((s) => s.openUserProfile)
  const fontScale = useAppearanceStore((s) => s.fontScale) ?? DEFAULT_FONT_SCALE

  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteLoading, setDeleteLoading] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [editLoading, setEditLoading] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Fetch roles and current user's member data for permission checking
  const { data: roles = [] } = useQuery<DtoRole[]>({
    queryKey: ['roles', serverId],
    queryFn: () => rolesApi.guildGuildIdRolesGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
  })

  const { data: currentMember } = useQuery<DtoMember>({
    queryKey: ['member', serverId, 'me'],
    queryFn: () => userApi.userMeGuildsGuildIdMemberGet({ guildId: serverId! }).then((r) => r.data),
    enabled: !!serverId,
  })

  // Fetch guild to check if current user is owner
  const { data: guild } = useQuery<DtoGuild>({
    queryKey: ['guild', serverId],
    queryFn: () => guildApi.guildGuildIdGet({ guildId: serverId! }).then((r) => r.data!),
    enabled: !!serverId,
  })

  // Calculate effective permissions
  const userPermissions = currentMember && roles.length > 0
    ? calculateEffectivePermissions(currentMember, roles)
    : 0

  const removeMessage = useMessageStore((s) => s.removeMessage)
  const updateMessage = useMessageStore((s) => s.updateMessage)
  const currentUser = useAuthStore((s) => s.user)

  // Check if current user is the server owner
  const isOwner = currentUser && guild?.owner !== undefined && String(guild.owner) === String(currentUser.id)

  const canManageMessages = isOwner || hasPermission(userPermissions, PermissionBits.MANAGE_MESSAGES)

  const authorName = message.author?.name ?? 'Unknown'
  const initials = authorName.charAt(0).toUpperCase()
  const channelId = String(message.channel_id)
  const messageId = String(message.id)
  const isOwn = currentUser?.id !== undefined && String(message.author?.id) === String(currentUser.id)

  // Use Snowflake ID to derive creation time (more reliable than updated_at for display)
  const timestamp = snowflakeToTime(message.id)
  const fullTimestamp = snowflakeToDate(message.id).toLocaleString()

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

  // Check if this is a join message
  const isJoinMessage = message.type === JOIN_MESSAGE_TYPE

  // Render join message differently
  if (isJoinMessage) {
    // Get translated join messages - ensure it's a valid array
    let joinMessages: string[]
    try {
      const translationResult = t('joinMessages', { returnObjects: true })
      joinMessages = Array.isArray(translationResult) ? translationResult : DEFAULT_JOIN_MESSAGES
    } catch {
      joinMessages = DEFAULT_JOIN_MESSAGES
    }

    return (
      <div className="flex items-center justify-center py-2 px-4">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button
            onClick={handleAuthorClick}
            className="font-medium text-foreground hover:underline cursor-pointer"
          >
            {authorName}
          </button>
          <span>{getJoinMessage(message.author?.id, joinMessages)}</span>
          <span className="text-xs" title={fullTimestamp}>
            {timestamp}
          </span>
        </div>
      </div>
    )
  }

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div className={cn(
            'flex items-start gap-3 px-2 rounded hover:bg-accent/40 group',
            isGrouped ? 'py-0.5' : 'py-1',
          )}>
            {isGrouped ? (
              /* Compact grouped row: no avatar — hover reveals timestamp in left gutter */
              <div className="w-9 shrink-0 flex items-center justify-end mt-0.5">
                <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity leading-none tabular-nums select-none">
                  {timestamp}
                </span>
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
              {!isGrouped && (
                <div className="flex items-baseline gap-2">
                  {/* Clickable author name */}
                  <button
                    onClick={handleAuthorClick}
                    className="font-semibold text-sm hover:underline focus:outline-none"
                  >
                    {authorName}
                  </button>
                  <span
                    className="text-xs text-muted-foreground tabular-nums"
                    title={fullTimestamp}
                  >
                    {timestamp}
                  </span>
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
                  {/* Parsed message content with inline markdown */}
                  {message.content && (
                    <div 
                      className="text-sm break-words whitespace-pre-wrap leading-relaxed"
                      style={{ fontSize: `${fontScale}rem` }}
                    >
                      {parseMessageContent(message.content, resolver)}
                    </div>
                  )}
                  {/* Attachments */}
                  <MessageAttachments attachments={message.attachments} />
                  {/* YouTube embeds — one per unique video ID found in the message */}
                  {message.content && extractYouTubeEmbeds(message.content).map(({ videoId, url }) => (
                    <YoutubeEmbed key={videoId} videoId={videoId} url={url} />
                  ))}
                  {/* Invite embeds */}
                  {message.content && extractInviteCodes(message.content).map((code) => (
                    <InviteEmbed key={code} code={code} />
                  ))}
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
          <ContextMenuItem
            onClick={() => { void navigator.clipboard.writeText(messageId) }}
            className="gap-2"
          >
            <Hash className="w-4 h-4" />
            {t('messageItem.copyMessageId')}
          </ContextMenuItem>
          {isOwn ? (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={startEdit} className="gap-2">
                <Pencil className="w-4 h-4" />
                {t('messageItem.editMessage')}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => setDeleteOpen(true)}
                className="text-destructive focus:text-destructive gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {t('messageItem.deleteMessage')}
              </ContextMenuItem>
            </>
          ) : (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onClick={() => void handleMessageUser()} className="gap-2">
                <MessageSquare className="w-4 h-4" />
                {t('messageItem.messageUser')}
              </ContextMenuItem>
              {canManageMessages && (
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
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>

      <Dialog open={deleteOpen} onOpenChange={(o) => !o && setDeleteOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('messageItem.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('messageItem.deleteDesc')}
            </DialogDescription>
          </DialogHeader>
          {message.content && (
            <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground italic">
              {message.content}
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
