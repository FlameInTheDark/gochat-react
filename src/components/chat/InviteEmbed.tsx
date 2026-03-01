import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { inviteApi } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'

interface Props {
  code: string
}

export default function InviteEmbed({ code }: Props) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const token = useAuthStore((s) => s.token)
  const [joining, setJoining] = useState(false)
  const [joined, setJoined] = useState(false)

  const { data: preview, isLoading, isError } = useQuery({
    queryKey: ['invite-preview', code],
    queryFn: async () => {
      const res = await inviteApi.guildInvitesReceiveInviteCodeGet({ inviteCode: code })
      return res.data
    },
    staleTime: 1000 * 60 * 5, // cache for 5 minutes
    retry: false,
  })

  async function handleJoin() {
    if (!token) {
      navigate(`/?invite=${code}`)
      return
    }
    setJoining(true)
    try {
      const res = await inviteApi.guildInvitesAcceptInviteCodePost({ inviteCode: code })
      const guild = res.data
      await queryClient.invalidateQueries({ queryKey: ['guilds'] })
      setJoined(true)
      if (guild.id !== undefined) {
        navigate(`/app/${String(guild.id)}`)
      }
    } catch {
      toast.error('Failed to join the server. The invite may have expired.')
    } finally {
      setJoining(false)
    }
  }

  // Skeleton while loading
  if (isLoading) {
    return (
      <div className="mt-2 max-w-sm rounded-md border border-border bg-card/60 p-3 flex items-center gap-3 animate-pulse">
        <div className="w-10 h-10 rounded-full bg-muted shrink-0" />
        <div className="flex-1 space-y-1.5 min-w-0">
          <div className="h-3 bg-muted rounded w-2/3" />
          <div className="h-3.5 bg-muted rounded w-1/2" />
          <div className="h-2.5 bg-muted rounded w-1/3" />
        </div>
        <div className="w-20 h-8 bg-muted rounded shrink-0" />
      </div>
    )
  }

  // Invalid / expired invite
  if (isError || !preview) {
    return (
      <div className="mt-2 max-w-sm rounded-md border border-border bg-card/60 p-3">
        <p className="text-xs text-muted-foreground italic">
          This invite is invalid or has expired.
        </p>
      </div>
    )
  }

  const guildName = preview.guild?.name ?? 'Unknown Server'
  const iconUrl = preview.guild?.icon?.url
  const initials = guildName.charAt(0).toUpperCase()
  const memberCount = preview.members_count

  return (
    <div className="mt-2 max-w-sm rounded-md border border-border bg-card/80 p-3 flex items-center gap-3">
      {/* Server icon */}
      <Avatar className="w-10 h-10 rounded-xl shrink-0">
        <AvatarImage src={iconUrl} alt={guildName} className="object-cover" />
        <AvatarFallback className="rounded-xl text-sm font-bold bg-primary/20 text-primary">
          {initials}
        </AvatarFallback>
      </Avatar>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wide leading-none mb-0.5">
          You've been invited to join a server
        </p>
        <p className="text-sm font-semibold truncate leading-tight">{guildName}</p>
        {memberCount !== undefined && (
          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
            <UserRound className="w-3 h-3" />
            {memberCount.toLocaleString()} member{memberCount !== 1 ? 's' : ''}
          </p>
        )}
      </div>

      {/* Join button */}
      <Button
        size="sm"
        variant={joined ? 'outline' : 'default'}
        onClick={() => void handleJoin()}
        disabled={joining || joined}
        className="shrink-0"
      >
        {joining ? 'Joining…' : joined ? 'Joined!' : 'Join'}
      </Button>
    </div>
  )
}
