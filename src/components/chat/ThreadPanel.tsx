import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Pencil, Spool, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { guildApi } from '@/api/client'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import type { MentionResolver } from '@/lib/messageParser'
import type { JumpRequest } from '@/lib/messageJump'
import type { DtoChannel, DtoMessage } from '@/types'
import ChatAttachmentDropZone from '@/components/chat/ChatAttachmentDropZone'
import MessageInput, { type MessageInputHandle } from '@/components/chat/MessageInput'
import MessageList from '@/components/chat/MessageList'
import TypingIndicator from '@/components/chat/TypingIndicator'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useQueryClient } from '@tanstack/react-query'
import { activateChannel, deactivateChannel } from '@/services/wsService'
import { useTranslation } from 'react-i18next'

interface Props {
  serverId: string
  thread: DtoChannel
  canManageThread: boolean
  canSendMessages: boolean
  highlightRequest?: JumpRequest | null
  onHighlightHandled?: (requestKey: string) => void
  resolver?: MentionResolver
  onOpenReferencedMessage?: (channelId: string, messageId: string) => void
  onBack: () => void
  onDeleted: () => void
}

export default function ThreadPanel({
  serverId,
  thread,
  canManageThread,
  canSendMessages,
  highlightRequest,
  onHighlightHandled,
  resolver,
  onOpenReferencedMessage,
  onBack,
  onDeleted,
}: Props) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const threadId = String(thread.id)
  const parentChannelId = thread.parent_id != null ? String(thread.parent_id) : null
  const [editOpen, setEditOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [name, setName] = useState(thread.name ?? '')
  const [topic, setTopic] = useState(thread.topic ?? '')
  const [closed, setClosed] = useState(!!thread.closed)
  const [replyTarget, setReplyTarget] = useState<DtoMessage | null>(null)
  const messageInputRef = useRef<MessageInputHandle | null>(null)

  useEffect(() => {
    setName(thread.name ?? '')
    setTopic(thread.topic ?? '')
    setClosed(!!thread.closed)
    setReplyTarget(null)
  }, [thread.closed, thread.name, thread.topic])

  useEffect(() => {
    activateChannel(threadId)
    return () => {
      deactivateChannel(threadId)
    }
  }, [threadId])

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
    threadId,
    highlightRequest,
    thread.last_message_id != null ? String(thread.last_message_id) : undefined,
  )

  async function refreshThreadData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['channels', serverId] }),
      parentChannelId
        ? queryClient.invalidateQueries({ queryKey: ['channel-threads', serverId, parentChannelId] })
        : Promise.resolve(),
      queryClient.invalidateQueries({ queryKey: ['thread-channel', serverId, threadId] }),
      queryClient.invalidateQueries({ queryKey: ['thread-preview', threadId] }),
    ])
  }

  async function handleSave() {
    setSaving(true)
    try {
      await guildApi.guildGuildIdChannelChannelIdPatch({
        guildId: serverId,
        channelId: threadId,
        req: {
          name: name.trim() || thread.name,
          topic: topic.trim(),
          closed,
        },
      })
      await refreshThreadData()
      setEditOpen(false)
    } catch {
      toast.error(t('threads.updateFailed'))
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await guildApi.guildGuildIdChannelChannelIdDelete({
        guildId: serverId,
        channelId: threadId,
      })
      await refreshThreadData()
      setDeleteOpen(false)
      onDeleted()
    } catch {
      toast.error(t('threads.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  const composerDisabled = thread.closed || !canSendMessages
  const composerDisabledReason = thread.closed
    ? t('threads.closedComposer')
    : t('threads.noSendPermission')

  return (
    <>
      <div className="flex flex-col h-full min-h-0">
        <div className="h-12 border-b border-sidebar-border flex items-center gap-2 px-3 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={t('threads.backToList')}
          >
            <ArrowLeft className="w-4 h-4" />
          </Button>
          <Spool className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-semibold">
            {thread.name ?? threadId}
          </span>

          {canManageThread && (
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setEditOpen(true)}
                aria-label={t('threads.editThread')}
              >
                <Pencil className="w-4 h-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setDeleteOpen(true)}
                aria-label={t('threads.deleteThread')}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>

        {thread.topic && (
          <div className="border-b border-sidebar-border px-4 py-2 text-xs text-muted-foreground shrink-0">
            {thread.topic}
          </div>
        )}

        <ChatAttachmentDropZone
          className="flex-1 min-h-0"
          disabled={composerDisabled}
          onFileDrop={(files) => {
            messageInputRef.current?.addFiles(files)
            messageInputRef.current?.focusEditor()
          }}
        >
          <MessageList
            key={threadId}
            rows={rows}
            mode={mode}
            isLoadingInitial={isLoadingInitial}
            jumpTargetRowKey={jumpTargetRowKey}
            focusTargetRowKey={focusTargetRowKey}
            highlightRequest={highlightRequest}
            onHighlightHandled={onHighlightHandled}
            channelName={thread.name}
            resolver={resolver}
            onLoadGap={loadGap}
            onJumpToPresent={jumpToPresent}
            onAckLatest={ackLatest}
            getMessageProps={(message) => ({
              replyAction: message.id != null && (message.type === 0 || message.type === 1)
                ? {
                    label: t('messageItem.reply'),
                    onClick: () => setReplyTarget(message),
                  }
                : undefined,
              onOpenReference: onOpenReferencedMessage
                ? ({ channelId, messageId }) => onOpenReferencedMessage(channelId, messageId)
                : undefined,
              allowEdit: !thread.closed && message.type !== 2 && message.type !== 3 && message.type !== 4,
              allowDelete: !thread.closed,
            })}
          />
          <TypingIndicator channelId={threadId} serverId={serverId} />
          <MessageInput
            ref={messageInputRef}
            channelId={threadId}
            channelName={thread.name ?? threadId}
            disabled={composerDisabled}
            disabledReason={composerDisabled ? composerDisabledReason : undefined}
            resolver={resolver}
            replyTo={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
          />
        </ChatAttachmentDropZone>
      </div>

      <Dialog open={editOpen} onOpenChange={(open) => !open && setEditOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('threads.editTitle')}</DialogTitle>
            <DialogDescription>{t('threads.editDescription')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('threads.threadName')}</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('threads.threadNamePlaceholder')}
                maxLength={256}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('threads.topic')}</label>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder={t('threads.topicPlaceholder')}
                rows={3}
              />
            </div>
            <Button
              type="button"
              variant={closed ? 'secondary' : 'outline'}
              onClick={() => setClosed((value) => !value)}
            >
              {closed ? t('threads.reopenThread') : t('threads.closeThread')}
            </Button>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => void handleSave()} disabled={saving}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={(open) => !open && setDeleteOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('threads.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {t('threads.deleteDescription', { name: thread.name ?? threadId })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
