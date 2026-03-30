import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'
import { useTranslation } from 'react-i18next'
import { CircleCheck } from 'lucide-react'

export default function ConfirmPage() {
  const { userId, token } = useParams<{ userId: string; token: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()

  const [name, setName] = useState('')
  const [discriminator, setDiscriminator] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  const passwordMismatch = confirmPassword.length > 0 && password !== confirmPassword

  if (!userId || !token) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <p className="text-destructive">{t('auth.confirmInvalidLink')}</p>
      </div>
    )
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (passwordMismatch) return
    setError(null)
    setLoading(true)
    const base = getApiBaseUrl()
    try {
      await axiosInstance.post(`${base}/auth/confirmation`, {
        id: BigInt(userId!),
        token,
        name: name.trim(),
        discriminator: discriminator.trim(),
        password,
      })
      setSuccess(true)
      setTimeout(() => navigate('/'), 2000)
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status
        if (status === 409) {
          setError(t('auth.confirmUsernameTaken'))
        } else if (status === 401) {
          setError(t('auth.confirmLinkExpired'))
        } else if (status === 400) {
          setError(t('auth.confirmInvalidRequest'))
        } else {
          setError(t('auth.confirmFailed'))
        }
      } else {
        setError(t('auth.confirmFailed'))
      }
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <div className="text-center space-y-4">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-green-500/10 flex items-center justify-center">
              <CircleCheck className="w-8 h-8 text-green-500" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="text-lg font-semibold">{t('auth.confirmSuccessTitle')}</p>
            <p className="text-sm text-muted-foreground">{t('auth.confirmSuccessDesc')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-center text-2xl font-bold">{t('auth.confirmTitle')}</h1>
        <form onSubmit={(e) => { void handleSubmit(e) }} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">{t('auth.confirmDisplayName')}</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="discriminator">{t('auth.confirmUsername')}</Label>
            <Input
              id="discriminator"
              value={discriminator}
              onChange={(e) => setDiscriminator(e.target.value)}
              pattern="[a-z0-9\-_.]+"
              title={t('auth.confirmUsernameHint')}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">{t('auth.confirmPasswordLabel')}</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">{t('auth.confirmConfirmPasswordLabel')}</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={passwordMismatch ? 'border-destructive' : ''}
              required
            />
            {passwordMismatch && (
              <p className="text-xs text-destructive">{t('auth.passwordMismatch')}</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || passwordMismatch || !name || !discriminator || !password || !confirmPassword}
          >
            {loading ? t('auth.confirmSubmitting') : t('auth.confirmSubmit')}
          </Button>
        </form>
      </div>
    </div>
  )
}
