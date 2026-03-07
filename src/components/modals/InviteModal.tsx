import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUiStore } from '@/stores/uiStore'
import { inviteApi, axiosInstance } from '@/api/client'
import type { DtoGuildInvite } from '@/client'
import { useTranslation } from 'react-i18next'

function getInviteUrl(code: string) {
  return `${location.origin}/invite/${code}`
}

export default function InviteModal() {
  const open = useUiStore((s) => s.inviteModalOpen)
  const close = useUiStore((s) => s.closeInviteModal)
  const serverId = useUiStore((s) => s.inviteModalServerId)
  const queryClient = useQueryClient()
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)

  const { data: invites = [] } = useQuery({
    queryKey: ['invites', serverId],
    queryFn: () =>
      inviteApi
        .guildInvitesGuildIdGet({ guildId: serverId! })
        .then((r) => r.data ?? []),
    enabled: !!serverId && open,
  })

  async function createInvite() {
    if (!serverId) return
    setCreating(true)
    try {
      // 100 years in seconds; pre-serialize with JSON.stringify to avoid
      // json-bigint mishandling numbers > 2^31 as BigInt candidates
      const NEVER_EXPIRES_SEC = 100 * 365 * 24 * 60 * 60
      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'
      await axiosInstance.post(
        `${baseUrl}/guild/invites/${serverId}`,
        JSON.stringify({ expires_in_sec: NEVER_EXPIRES_SEC }),
        { headers: { 'Content-Type': 'application/json' } },
      )
      await queryClient.invalidateQueries({ queryKey: ['invites', serverId] })
    } catch {
      toast.error(t('modals.createInviteFailed'))
    } finally {
      setCreating(false)
    }
  }

  async function deleteInvite(invite: DtoGuildInvite) {
    if (!serverId || !invite.id) return
    try {
      await inviteApi.guildInvitesGuildIdInviteIdDelete({
        guildId: serverId,
        inviteId: String(invite.id),
      })
      await queryClient.invalidateQueries({ queryKey: ['invites', serverId] })
    } catch {
      toast.error(t('modals.deleteInviteFailed'))
    }
  }

  function copyInvite(code: string) {
    void navigator.clipboard.writeText(getInviteUrl(code))
    toast.success(t('modals.inviteCopied'))
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('modals.invitePeople')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {invites.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">
              {t('modals.noActiveInvites')}
            </p>
          ) : (
            <div className="space-y-2">
              {invites.map((invite) => (
                <div key={String(invite.id)} className="flex items-center gap-2">
                  <Input
                    readOnly
                    value={invite.code ? getInviteUrl(invite.code) : ''}
                    className="flex-1 font-mono text-xs"
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => invite.code && copyInvite(invite.code)}
                    title={t('modals.copyLink')}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void deleteInvite(invite)}
                    title={t('modals.deleteInvite')}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <Button
            onClick={() => void createInvite()}
            disabled={creating}
            className="w-full"
            variant="outline"
          >
            <Plus className="w-4 h-4 mr-2" />
            {t('modals.createNewInvite')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
