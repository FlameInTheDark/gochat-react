import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useUiStore } from '@/stores/uiStore'

interface Props {
  onConfirm: (target: { type: 'channel' | 'message'; id: string }) => Promise<void>
}

export default function DeleteConfirmModal({ onConfirm }: Props) {
  const target = useUiStore((s) => s.deleteTarget)
  const setDeleteTarget = useUiStore((s) => s.setDeleteTarget)

  function close() {
    setDeleteTarget(null)
  }

  async function handleConfirm() {
    if (!target) return
    await onConfirm(target)
    close()
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Delete {target?.type === 'channel' ? 'Channel' : 'Message'}?
          </DialogTitle>
          <DialogDescription>This action cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
