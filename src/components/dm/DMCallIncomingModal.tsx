import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Phone, PhoneOff } from 'lucide-react'
import { userApi } from '@/api/client'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/authStore'
import { useDMCallStore } from '@/stores/dmCallStore'
import { dmCallApi } from '@/services/dmCallApi'
import { joinVoice } from '@/services/voiceService'

export default function DMCallIncomingModal() {
  const navigate = useNavigate()
  const currentUserId = String(useAuthStore((state) => state.user?.id ?? ''))
  const incomingChannelId = useDMCallStore((state) => state.incomingChannelId)
  const call = useDMCallStore((state) => incomingChannelId ? state.calls[incomingChannelId] : null)
  const setIncoming = useDMCallStore((state) => state.setIncoming)
  const markDismissed = useDMCallStore((state) => state.markDismissed)
  const upsertCall = useDMCallStore((state) => state.upsertCall)
  const [isBusy, setIsBusy] = useState(false)

  const callerId = call?.callerId ?? null
  const shouldShow = Boolean(
    incomingChannelId
      && call
      && !call.dismissed
      && callerId
      && callerId !== currentUserId
      && call.recipientId === currentUserId,
  )

  const { data: caller } = useQuery({
    queryKey: ['user', callerId],
    queryFn: async () => {
      if (!callerId) return null
      const res = await userApi.userUserIdGet({ userId: callerId })
      return res.data ?? null
    },
    enabled: shouldShow && !!callerId,
    staleTime: 5 * 60 * 1000,
  })

  const callerName = caller?.name ?? 'Unknown user'
  const avatarInitial = useMemo(() => callerName.charAt(0).toUpperCase(), [callerName])

  if (!shouldShow || !incomingChannelId || !call) return null

  async function acceptCall() {
    if (!incomingChannelId) return
    setIsBusy(true)
    try {
      const response = await dmCallApi.joinCall(incomingChannelId)
      upsertCall(response.call)
      await joinVoice(
        '@me',
        incomingChannelId,
        `@${callerName}`,
        response.sfuUrl,
        response.sfuToken,
        'Direct Messages',
        response.region,
        { privateCall: true },
      )
      setIncoming(null)
      navigate(`/app/@me/${incomingChannelId}`)
    } finally {
      setIsBusy(false)
    }
  }

  async function declineCall() {
    if (!incomingChannelId) return
    setIsBusy(true)
    try {
      await dmCallApi.declineCall(incomingChannelId)
      markDismissed(incomingChannelId)
    } finally {
      setIsBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4">
      <div className="w-full max-w-sm rounded-xl border border-border/70 bg-popover p-6 text-popover-foreground shadow-2xl">
        <div className="flex flex-col items-center text-center">
          <Avatar className="h-20 w-20 border-4 border-background shadow-lg">
            <AvatarImage src={caller?.avatar?.url} className="object-cover" />
            <AvatarFallback className="text-2xl">{avatarInitial}</AvatarFallback>
          </Avatar>
          <h2 className="mt-4 text-xl font-semibold">{callerName}</h2>
          <p className="mt-1 text-sm text-muted-foreground">Incoming voice call</p>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3">
          <Button
            variant="secondary"
            disabled={isBusy}
            onClick={() => void declineCall()}
            className="gap-2"
          >
            <PhoneOff className="h-4 w-4" />
            Decline
          </Button>
          <Button
            disabled={isBusy}
            onClick={() => void acceptCall()}
            className="gap-2 bg-emerald-600 text-white hover:bg-emerald-500"
          >
            <Phone className="h-4 w-4" />
            Accept
          </Button>
        </div>
      </div>
    </div>
  )
}
