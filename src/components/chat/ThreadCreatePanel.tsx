import { useState } from 'react'
import { ArrowLeft, Spool } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { DtoMessage } from '@/types'
import MessageInput from '@/components/chat/MessageInput'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

interface Props {
  parentChannelId: string
  sourceMessage: DtoMessage
  onBack: () => void
  onCreateThread: (payload: {
    name?: string
    content: string
    attachmentIds: number[]
    nonce: string
    sourceMessageId: string
  }) => Promise<void>
}

export default function ThreadCreatePanel({
  parentChannelId,
  sourceMessage,
  onBack,
  onCreateThread,
}: Props) {
  const { t } = useTranslation()
  const [threadName, setThreadName] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  async function handleSend({
    content,
    attachmentIds,
    nonce,
  }: {
    content: string
    attachmentIds: number[]
    nonce: string
  }) {
    setIsCreating(true)
    try {
      await onCreateThread({
        name: threadName.trim() || undefined,
        content,
        attachmentIds,
        nonce,
        sourceMessageId: String(sourceMessage.id),
      })
    } finally {
      setIsCreating(false)
    }
  }

  return (
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
        <Input
          value={threadName}
          onChange={(e) => setThreadName(e.target.value)}
          placeholder={t('threads.threadNamePlaceholder')}
          className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          maxLength={256}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-4 py-3 border-b border-sidebar-border shrink-0 space-y-2">
          <p className="text-sm text-foreground">{t('threads.composeDescription')}</p>
          {(sourceMessage.content ?? '').trim() && (
            <blockquote className="border-l-2 border-muted pl-3 text-sm text-muted-foreground break-words">
              {sourceMessage.content}
            </blockquote>
          )}
        </div>

        <div className="flex-1 min-h-0" />

        <MessageInput
          channelId={parentChannelId}
          channelName={threadName.trim() || t('threads.threadFallback')}
          uploadChannelId={parentChannelId}
          typingChannelId={null}
          onSendMessage={handleSend}
          sendFailedMessage={t('threads.createFailed')}
          disabled={isCreating}
        />
      </div>
    </div>
  )
}
