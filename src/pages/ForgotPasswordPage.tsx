import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/api/client'
import { useTranslation } from 'react-i18next'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const { t } = useTranslation()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await authApi.authRecoveryPost({ request: { email } })
      setSent(true)
    } catch {
      setError(t('auth.recoveryFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-1 w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        {sent ? (
          <>
            <h1 className="text-center text-2xl font-bold">{t('auth.checkEmailTitle')}</h1>
            <p className="text-center text-sm text-muted-foreground">{t('auth.checkEmailDesc')}</p>
            <Link to="/" className="block w-full">
              <Button variant="outline" className="w-full">{t('auth.backToSignIn')}</Button>
            </Link>
          </>
        ) : (
          <>
            <div className="space-y-1">
              <h1 className="text-center text-2xl font-bold">{t('auth.forgotPasswordTitle')}</h1>
              <p className="text-center text-sm text-muted-foreground">{t('auth.forgotPasswordDesc')}</p>
            </div>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email')}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t('auth.sendingReset') : t('auth.sendResetLink')}
              </Button>
            </form>
            <p className="text-center text-sm text-muted-foreground">
              <Link to="/" className="underline">{t('auth.backToSignIn')}</Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
