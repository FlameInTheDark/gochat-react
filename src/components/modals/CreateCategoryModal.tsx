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
import { toast } from 'sonner'

export default function CreateCategoryModal() {
  const open = useUiStore((s) => s.createCategoryOpen)
  const close = useUiStore((s) => s.closeCreateCategory)
  const serverId = useUiStore((s) => s.createCategoryServerId)
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleCreate() {
    if (!name.trim() || !serverId) return
    setLoading(true)
    try {
      await guildApi.guildGuildIdCategoryPost({
        guildId: serverId!,
        request: { name: name.trim() },
      })
      await queryClient.invalidateQueries({ queryKey: ['channels', serverId] })
      close()
      setName('')
    } catch {
      toast.error('Failed to create category')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a Category</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="category-name">Category Name</Label>
          <Input
            id="category-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="TEXT CHANNELS"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={loading || !name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
