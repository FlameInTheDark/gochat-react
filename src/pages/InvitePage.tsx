import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { inviteApi } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import type { DtoInvitePreview } from '@/client'

export default function InvitePage() {
  const { code } = useParams<{ code: string }>()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const [preview, setPreview] = useState<DtoInvitePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [joining, setJoining] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    if (!code || !token) return
    inviteApi
      .guildInvitesReceiveInviteCodeGet({ inviteCode: code })
      .then((r) => setPreview(r.data))
      .catch(() => setError(t('invitePage.invalidInvite')))
  }, [code, token])

  async function handleAccept() {
    if (!code) return
    if (!token) {
      navigate(`/?invite=${code}`)
      return
    }
    setJoining(true)
    try {
      const res = await inviteApi.guildInvitesAcceptInviteCodePost({ inviteCode: code })
      const guild = res.data
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      navigate(guild.id !== undefined ? `/app/${String(guild.id)}` : '/app')
    } catch {
      setError(t('invitePage.joinFailed'))
      setJoining(false)
    }
  }

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="w-full max-w-sm p-8 rounded-xl border border-border bg-card space-y-6 text-center">
        {error ? (
          <>
            <p className="text-destructive font-semibold">{error}</p>
            <button
              onClick={() => navigate('/app')}
              className="text-sm text-muted-foreground hover:text-foreground underline"
            >
              {t('invitePage.goToApp')}
            </button>
          </>
        ) : !token ? (
          <>
            <p className="text-base font-semibold">{t('invitePage.loginRequired')}</p>
            <button
              onClick={() => navigate(`/?next=/invite/${code}`)}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors"
            >
              {t('invitePage.signIn')}
            </button>
            <button
              onClick={() => navigate(`/register?next=/invite/${code}`)}
              className="w-full py-2 px-4 rounded-md border border-border font-semibold hover:bg-muted transition-colors text-sm"
            >
              {t('invitePage.createAccount')}
            </button>
          </>
        ) : !preview ? (
          <div className="space-y-2">
            <div className="w-16 h-16 squircle bg-muted animate-pulse mx-auto" />
            <div className="h-4 bg-muted rounded animate-pulse" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="w-16 h-16 squircle bg-primary/20 flex items-center justify-center mx-auto text-2xl font-bold text-primary overflow-hidden">
                {preview.guild?.icon?.url
                  ? <img src={preview.guild.icon.url} alt={preview.guild.name ?? ''} className="w-full h-full object-cover" />
                  : (preview.guild?.name ?? '?').charAt(0).toUpperCase()
                }
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                {t('invitePage.youveBeenInvited')}
              </p>
              <h1 className="text-xl font-bold">{preview.guild?.name}</h1>
              {preview.members_count !== undefined && (
                <p className="text-sm text-muted-foreground">
                  {t('invitePage.membersCount', { count: preview.members_count })}
                </p>
              )}
            </div>
            <button
              onClick={() => void handleAccept()}
              disabled={joining}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {joining ? t('invitePage.joining') : t('invitePage.acceptInvite')}
            </button>
            <button
              onClick={() => navigate('/app')}
              className="w-full py-2 px-4 rounded-md border border-border font-semibold hover:bg-muted transition-colors text-sm"
            >
              {t('invitePage.returnToApp')}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
