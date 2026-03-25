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
import { getApiBaseUrl } from '@/lib/connectionConfig'

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
      .catch(() => {
      })
      .finally(() => {
        setCheckingAuth(false)
      })
  }, [token, setUser])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      const res = await authApi.authLoginPost({
        request: { email, password },
      })
      const { token, refresh_token } = res.data
      if (token) {
        setToken(token)
        if (refresh_token) setRefreshToken(refresh_token)
        const next = searchParams.get('next')
        navigate(next ?? '/app')
      }
    } catch {
      setError(t('auth.invalidCredentials'))
    } finally {
      setLoading(false)
    }
  }

  if (checkingAuth) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <div className="w-10 h-10 rounded-full border-2 border-primary border-t-transparent animate-spin" />
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
