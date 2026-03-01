import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
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

  useEffect(() => {
    if (!code) return
    inviteApi
      .guildInvitesReceiveInviteCodeGet({ inviteCode: code })
      .then((r) => setPreview(r.data))
      .catch(() => setError('This invite is invalid or has expired.'))
  }, [code])

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
      setError('Failed to join the server. The invite may have expired.')
      setJoining(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm p-8 rounded-xl border border-border bg-card space-y-6 text-center">
        {error ? (
          <>
            <p className="text-destructive font-semibold">{error}</p>
            <button
              onClick={() => navigate('/app')}
              className="text-sm text-muted-foreground hover:text-foreground underline"
            >
              Go to app
            </button>
          </>
        ) : !preview ? (
          <div className="space-y-2">
            <div className="w-16 h-16 rounded-full bg-muted animate-pulse mx-auto" />
            <div className="h-4 bg-muted rounded animate-pulse" />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="w-16 h-16 rounded-full bg-primary/20 flex items-center justify-center mx-auto text-2xl font-bold text-primary">
                {(preview.guild?.name ?? '?').charAt(0).toUpperCase()}
              </div>
              <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                You've been invited to join
              </p>
              <h1 className="text-xl font-bold">{preview.guild?.name}</h1>
              {preview.members_count !== undefined && (
                <p className="text-sm text-muted-foreground">
                  {preview.members_count} member{preview.members_count !== 1 ? 's' : ''}
                </p>
              )}
            </div>
            <button
              onClick={() => void handleAccept()}
              disabled={joining}
              className="w-full py-2 px-4 rounded-md bg-primary text-primary-foreground font-semibold hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {joining ? 'Joining…' : 'Accept Invite'}
            </button>
          </>
        )}
      </div>
    </div>
  )
}
