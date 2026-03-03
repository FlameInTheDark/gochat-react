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
import { useTranslation } from 'react-i18next'

interface Props {
  onConfirm: (target: { type: 'channel' | 'message'; id: string }) => Promise<void>
}

export default function DeleteConfirmModal({ onConfirm }: Props) {
  const target = useUiStore((s) => s.deleteTarget)
  const setDeleteTarget = useUiStore((s) => s.setDeleteTarget)
  const { t } = useTranslation()

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
            {target?.type === 'channel' ? t('modals.deleteChannelTitle') : t('modals.deleteMessageTitle')}
          </DialogTitle>
          <DialogDescription>{t('modals.deleteWarning')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={handleConfirm}>
            {t('common.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
