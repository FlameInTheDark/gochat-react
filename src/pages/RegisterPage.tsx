import { useState, useEffect } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { authApi } from '@/api/client'
import { useTranslation } from 'react-i18next'

export default function RegisterPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { t } = useTranslation()

  useEffect(() => {
    document.title = 'Create Account — GoChat'
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await authApi.authRegistrationPost({
        request: { email },
      })
      navigate('/')
    } catch {
      setError(t('auth.registrationFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-1 w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-center text-2xl font-bold">{t('auth.createAccountTitle')}</h1>
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
            {loading ? t('auth.creatingAccount') : t('auth.register')}
          </Button>
        </form>
        <p className="text-center text-sm text-muted-foreground">
          {t('auth.alreadyHaveAccount')}{' '}
          <Link to="/" className="underline">
            {t('auth.signIn')}
          </Link>
        </p>
      </div>
    </div>
  )
}
