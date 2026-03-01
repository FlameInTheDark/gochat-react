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
      toast.error('Invalid or expired invite link')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Join a Server</DialogTitle>
          <DialogDescription>
            Enter an invite link or code to join an existing server.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="invite-code">Invite Link or Code</Label>
          <Input
            id="invite-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="https://…/invite/ABC123 or ABC123"
            onKeyDown={(e) => e.key === 'Enter' && void handleJoin()}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={() => void handleJoin()} disabled={loading || !code.trim()}>
            Join Server
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
