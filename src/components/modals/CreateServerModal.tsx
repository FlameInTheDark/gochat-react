import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { guildApi } from '@/api/client'
import { useUiStore } from '@/stores/uiStore'
import { useTranslation } from 'react-i18next'

export default function CreateServerModal() {
  const open = useUiStore((s) => s.createServerOpen)
  const close = useUiStore((s) => s.closeCreateServer)
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    if (!name.trim()) return
    setLoading(true)
    try {
      await guildApi.guildPost({ request: { name: name.trim() } })
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      close()
      setName('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('modals.createServer')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="server-name">{t('modals.serverName')}</Label>
          <Input
            id="server-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('modals.serverNamePlaceholder')}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()}>
            {t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
