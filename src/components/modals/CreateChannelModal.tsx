import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Hash, Volume2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import { useUiStore } from '@/stores/uiStore'
import { toast } from 'sonner'
import { ChannelType } from '@/types'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

export default function CreateChannelModal() {
  const open = useUiStore((s) => s.createChannelOpen)
  const close = useUiStore((s) => s.closeCreateChannel)
  const parentId = useUiStore((s) => s.createChannelParentId)
  const serverId = useUiStore((s) => s.createChannelServerId)
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [channelType, setChannelType] = useState<0 | 1>(0)
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    if (!name.trim() || !serverId) return
    setLoading(true)
    try {
      const baseUrl = getApiBaseUrl()
      await axiosInstance.post(`${baseUrl}/guild/${serverId}/channel`, {
        name: name.trim(),
        type: channelType,
        ...(parentId ? { parent_id: BigInt(parentId) } : {}),
      })
      await queryClient.invalidateQueries({ queryKey: ['channels', serverId] })
      close()
      setName('')
      setChannelType(0)
    } catch {
      toast.error(t('modals.createChannelFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('modals.createChannel')}</DialogTitle>
          <DialogDescription className="sr-only">{t('modals.createChannel')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {/* Channel type */}
          <div className="space-y-2">
            <Label>{t('modals.channelType')}</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setChannelType(0)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded border text-sm transition-colors',
                  channelType === ChannelType.ChannelTypeGuild
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-foreground/30',
                )}
              >
                <Hash className="w-4 h-4" />
                {t('modals.textChannel')}
              </button>
              <button
                type="button"
                onClick={() => setChannelType(1)}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded border text-sm transition-colors',
                  channelType === ChannelType.ChannelTypeGuildVoice
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'border-border text-muted-foreground hover:border-foreground/30',
                )}
              >
                <Volume2 className="w-4 h-4" />
                {t('modals.voiceChannel')}
              </button>
            </div>
          </div>

          {/* Channel name */}
          <div className="space-y-2">
            <Label htmlFor="channel-name">{t('modals.channelName')}</Label>
            <Input
              id="channel-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={channelType === 0 ? t('modals.channelNamePlaceholderText') : t('modals.channelNamePlaceholderVoice')}
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()}>
            {t('modals.createChannel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
