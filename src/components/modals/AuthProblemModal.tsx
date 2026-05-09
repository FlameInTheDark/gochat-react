import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAuthProblemStore } from '@/stores/authProblemStore'
import { refreshAuthToken } from '@/lib/authRefresh'

interface AuthProblemModalProps {
  onLogout: () => void
}

export default function AuthProblemModal({ onLogout }: AuthProblemModalProps) {
  const { t } = useTranslation()
  const isOpen = useAuthProblemStore((s) => s.isOpen)
  const isRetrying = useAuthProblemStore((s) => s.isRetrying)
  const kind = useAuthProblemStore((s) => s.kind)
  const close = useAuthProblemStore((s) => s.close)
  const setRetrying = useAuthProblemStore((s) => s.setRetrying)

  async function handleRetry() {
    setRetrying(true)
    try {
      await refreshAuthToken({ openModalOnFailure: true })
      window.dispatchEvent(new CustomEvent('auth:refresh-restored'))
    } catch {
      // refreshAuthToken keeps the modal open with the latest failure state.
    } finally {
      setRetrying(false)
    }
  }

  function handleLogout() {
    close()
    onLogout()
  }

  return (
    <Dialog open={isOpen}>
      <DialogContent showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t('auth.sessionProblemTitle')}</DialogTitle>
          <DialogDescription>
            {kind === 'invalid'
              ? t('auth.sessionInvalidDesc')
              : t('auth.sessionTransientDesc')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={handleLogout} disabled={isRetrying}>
            {t('auth.sessionLogout')}
          </Button>
          <Button onClick={() => void handleRetry()} disabled={isRetrying}>
            {isRetrying ? t('auth.sessionRetrying') : t('auth.sessionRetry')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
