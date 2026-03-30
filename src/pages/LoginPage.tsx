import { useState, useEffect } from 'react'
import { useNavigate, useSearchParams, Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { authApi, axiosInstance } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import { useTranslation } from 'react-i18next'
import type { DtoUser } from '@/types'
import type { AuthLoginChallengeResponse } from '@/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'

// ---- 2FA second-step view ----

type TwoFaMethod = 'totp' | 'recovery_code' | 'email'

function TwoFaStep({
  challenge,
  onSuccess,
  onBack,
}: {
  challenge: AuthLoginChallengeResponse
  onSuccess: (token: string, refreshToken?: string) => void
  onBack: () => void
}) {
  const { t } = useTranslation()

  const availableMethods: TwoFaMethod[] = (() => {
    const m = challenge.methods ?? []
    const has = (k: string) => m.length === 0 || m.includes(k)
    return (['totp', 'recovery_code', 'email'] as TwoFaMethod[]).filter((v) => has(v))
  })()

  const [method, setMethod] = useState<TwoFaMethod>(availableMethods[0] ?? 'totp')
  const [code, setCode] = useState('')
  const [emailSent, setEmailSent] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      let token: string | undefined
      let refreshToken: string | undefined

      if (method === 'totp') {
        const res = await authApi.authLogin2faTotpPost({ request: { challenge_id: challenge.challenge_id, code } })
        token = res.data.token
        refreshToken = res.data.refresh_token
      } else if (method === 'recovery_code') {
        const res = await authApi.authLogin2faRecoveryCodePost({ request: { challenge_id: challenge.challenge_id, code } })
        token = res.data.token
        refreshToken = res.data.refresh_token
      } else {
        const res = await authApi.authLogin2faEmailVerifyPost({ request: { challenge_id: challenge.challenge_id, code } })
        token = res.data.token
        refreshToken = res.data.refresh_token
      }

      if (token) onSuccess(token, refreshToken)
      else setError(t('auth.twoFaVerificationFailed'))
    } catch {
      setError(t('auth.twoFaInvalidCode'))
    } finally {
      setLoading(false)
    }
  }

  async function handleSendEmail() {
    setError(null)
    setLoading(true)
    try {
      await authApi.authLogin2faEmailStartPost({ request: { challenge_id: challenge.challenge_id } })
      setEmailSent(true)
    } catch {
      setError(t('auth.twoFaSendFailed'))
    } finally {
      setLoading(false)
    }
  }

  const methodLabels: Record<TwoFaMethod, string> = {
    totp: t('auth.twoFaMethodTotp'),
    recovery_code: t('auth.twoFaMethodRecovery'),
    email: t('auth.twoFaMethodEmail'),
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
      <div className="space-y-1">
        <h1 className="text-center text-2xl font-bold">{t('auth.twoFaTitle')}</h1>
        <p className="text-center text-sm text-muted-foreground">{t('auth.twoFaSubtitle')}</p>
      </div>

      {availableMethods.length > 1 && (
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {availableMethods.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMethod(m); setCode(''); setError(null); setEmailSent(false) }}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                method === m ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {methodLabels[m]}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={(e) => { void handleSubmit(e) }} className="space-y-4">
        {method === 'totp' && (
          <div className="space-y-2">
            <Label htmlFor="2fa-totp-code">{t('auth.twoFaAuthCodeLabel')}</Label>
            <Input
              id="2fa-totp-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="font-mono text-center text-xl tracking-[0.5em]"
              maxLength={6}
              autoComplete="one-time-code"
              autoFocus
            />
          </div>
        )}

        {method === 'recovery_code' && (
          <div className="space-y-2">
            <Label htmlFor="2fa-recovery-code">{t('auth.twoFaRecoveryCodeLabel')}</Label>
            <Input
              id="2fa-recovery-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="xxxxxxxx-xxxx"
              className="font-mono"
              autoFocus
            />
          </div>
        )}

        {method === 'email' && (
          <div className="space-y-3">
            {!emailSent ? (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => void handleSendEmail()}
                disabled={loading}
              >
                {loading ? t('auth.twoFaSending') : t('auth.twoFaSendEmail')}
              </Button>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground text-center">{t('auth.twoFaEmailSentNote')}</p>
                <Label htmlFor="2fa-email-code">{t('auth.twoFaEmailCodeLabel')}</Label>
                <Input
                  id="2fa-email-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder={t('auth.twoFaEmailPlaceholder')}
                  className="font-mono"
                  autoFocus
                />
              </div>
            )}
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        {(method !== 'email' || emailSent) && (
          <Button type="submit" className="w-full" disabled={loading || !code}>
            {loading ? t('auth.twoFaVerifying') : t('auth.twoFaVerify')}
          </Button>
        )}
      </form>

      <button
        type="button"
        onClick={onBack}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors"
      >
        {t('auth.twoFaBack')}
      </button>
    </div>
  )
}

// ---- Main login page ----

export default function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const token = useAuthStore((s) => s.token)
  const setToken = useAuthStore((s) => s.setToken)
  const setRefreshToken = useAuthStore((s) => s.setRefreshToken)
  const setUser = useAuthStore((s) => s.setUser)
  const user = useAuthStore((s) => s.user)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [checkingAuth, setCheckingAuth] = useState(true)
  const [challenge, setChallenge] = useState<AuthLoginChallengeResponse | null>(null)
  const { t } = useTranslation()

  useEffect(() => {
    document.title = 'Sign In — GoChat'
  }, [])

  useEffect(() => {
    if (!token) {
      setCheckingAuth(false)
      return
    }

    const baseUrl = getApiBaseUrl()
    axiosInstance
      .get<DtoUser>(`${baseUrl}/user/me`)
      .then((res) => {
        setUser(res.data)
      })
      .catch(() => {})
      .finally(() => {
        setCheckingAuth(false)
      })
  }, [token, setUser])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.authLoginPost({ request: { email, password } })
      // On 202 the server returns AuthLoginChallengeResponse instead of AuthLoginResponse
      const data = res.data as typeof res.data & Partial<AuthLoginChallengeResponse>
      if (data.challenge_id) {
        setChallenge({ challenge_id: data.challenge_id, expires_at: data.expires_at, methods: data.methods })
      } else if (res.data.token) {
        setToken(res.data.token)
        if (res.data.refresh_token) setRefreshToken(res.data.refresh_token)
        const next = searchParams.get('next')
        navigate(next ?? '/app')
      }
    } catch {
      setError(t('auth.invalidCredentials'))
    } finally {
      setLoading(false)
    }
  }

  function handleTwoFaSuccess(newToken: string, newRefreshToken?: string) {
    setToken(newToken)
    if (newRefreshToken) setRefreshToken(newRefreshToken)
    const next = searchParams.get('next')
    navigate(next ?? '/app')
  }

  if (checkingAuth) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
      </div>
    )
  }

  if (challenge) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <TwoFaStep
          challenge={challenge}
          onSuccess={handleTwoFaSuccess}
          onBack={() => { setChallenge(null); setPassword('') }}
        />
      </div>
    )
  }

  const isLoggedIn = !!user

  return (
    <div className="flex flex-1 w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        {isLoggedIn ? (
          <>
            <div className="flex flex-col items-center space-y-4">
              <Avatar className="size-20">
                <AvatarImage src={user.avatar?.url} alt={user.name ?? ''} className="object-cover" />
                <AvatarFallback className="text-2xl">{user.name?.charAt(0).toUpperCase() ?? 'U'}</AvatarFallback>
              </Avatar>
              <div className="text-center">
                <h2 className="text-xl font-semibold">{user.name}</h2>
                <p className="text-sm text-muted-foreground">{t('auth.welcomeBack')}</p>
              </div>
            </div>
            <Button onClick={() => navigate('/app')} className="w-full">
              {t('auth.openApp')}
            </Button>
            <Button variant="outline" onClick={() => useAuthStore.getState().logout()} className="w-full">
              {t('auth.switchAccount')}
            </Button>
          </>
        ) : (
          <>
            <h1 className="text-center text-2xl font-bold">{t('auth.signInTitle')}</h1>
            <form onSubmit={(e) => { void handleSubmit(e) }} className="space-y-4">
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
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? t('auth.signingIn') : t('auth.signIn')}
              </Button>
            </form>
            <p className="text-center text-sm text-muted-foreground">
              <Link to="/forgot-password" className="underline">
                {t('auth.forgotPassword')}
              </Link>
            </p>
            <p className="text-center text-sm text-muted-foreground">
              {t('auth.noAccount')}{' '}
              <Link to="/register" className="underline">
                {t('auth.register')}
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  )
}
