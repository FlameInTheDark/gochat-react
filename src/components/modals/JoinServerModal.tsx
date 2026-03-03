import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useUiStore } from '@/stores/uiStore'
import { inviteApi } from '@/api/client'
import { useTranslation } from 'react-i18next'

// Extract invite code from a full URL or bare code
function extractCode(input: string): string {
  try {
    const url = new URL(input)
    const parts = url.pathname.split('/')
    return parts[parts.length - 1] ?? input
  } catch {
    return input.trim()
  }
}

export default function JoinServerModal() {
  const open = useUiStore((s) => s.joinServerOpen)
  const close = useUiStore((s) => s.closeJoinServer)
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleJoin() {
    const inviteCode = extractCode(code)
    if (!inviteCode) return
    setLoading(true)
    try {
      const res = await inviteApi.guildInvitesAcceptInviteCodePost({ inviteCode })
      const guild = res.data
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      close()
      setCode('')
      if (guild.id !== undefined) {
        navigate(`/app/${String(guild.id)}`)
      }
    } catch {
      toast.error(t('modals.joinServerFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('modals.joinServer')}</DialogTitle>
          <DialogDescription>
            {t('modals.joinServerDesc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="invite-code">{t('modals.inviteLinkOrCode')}</Label>
          <Input
            id="invite-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('modals.invitePlaceholder')}
            onKeyDown={(e) => e.key === 'Enter' && void handleJoin()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleJoin()} disabled={loading || !code.trim()}>
            {t('modals.join')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
