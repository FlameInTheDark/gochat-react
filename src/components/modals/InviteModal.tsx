import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, Plus, Trash2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'
import { inviteApi, axiosInstance } from '@/api/client'
import type { DtoGuildInvite } from '@/client'
import { useTranslation } from 'react-i18next'
import { getApiBaseUrl, getInviteUrl } from '@/lib/connectionConfig'

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000

export default function InviteModal() {
  const open = useUiStore((s) => s.inviteModalOpen)
  const close = useUiStore((s) => s.closeInviteModal)
  const serverId = useUiStore((s) => s.inviteModalServerId)
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  function formatExpiry(expiresAt?: string): string {
    const date = expiresAt ? new Date(expiresAt) : null
    const isNever = !date || isNaN(date.getTime()) || date > new Date(Date.now() + ONE_YEAR_MS)
    if (isNever) return t('serverSettings.inviteNeverExpires')
    return date!.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }
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
      const ONE_DAY_SEC = 24 * 60 * 60
      const baseUrl = getApiBaseUrl()
      await axiosInstance.post(
        `${baseUrl}/guild/invites/${serverId}`,
        JSON.stringify({ expires_in_sec: ONE_DAY_SEC }),
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
                <div
                  key={String(invite.id)}
                  className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <span className="font-mono font-medium flex-1 truncate">
                    {invite.code ?? '—'}
                  </span>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {formatExpiry(invite.expires_at)}
                  </span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0"
                        onClick={() => invite.code && copyInvite(invite.code)}
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('modals.copyLink')}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 shrink-0 text-destructive hover:text-destructive"
                        onClick={() => void deleteInvite(invite)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">{t('modals.deleteInvite')}</TooltipContent>
                  </Tooltip>
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
