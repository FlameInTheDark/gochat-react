import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import axios from 'axios'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { axiosInstance } from '@/api/client'
import { getApiBaseUrl } from '@/lib/connectionConfig'

export default function ConfirmPage() {
  const { userId, token } = useParams<{ userId: string; token: string }>()
  const navigate = useNavigate()

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
        <p className="text-destructive">Invalid confirmation link.</p>
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
          setError('That username is already taken. Please choose another.')
        } else if (status === 401) {
          setError('Invalid or expired confirmation link.')
        } else if (status === 400) {
          const detail = (err.response?.data as { message?: string } | undefined)?.message
          setError(detail ? `Confirmation failed: ${detail}` : 'Invalid request. Check your input.')
        } else {
          setError('Confirmation failed. Please try again.')
        }
      } else {
        setError('Confirmation failed. Please try again.')
      }
    } finally {
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="flex flex-1 w-full items-center justify-center bg-background">
        <div className="text-center space-y-2">
          <p className="text-green-500 font-medium">Account confirmed successfully!</p>
          <p className="text-sm text-muted-foreground">Redirecting to login…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 w-full items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-6 rounded-lg border bg-card p-8 shadow-sm">
        <h1 className="text-center text-2xl font-bold">Complete your account</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Display name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="discriminator">Username</Label>
            <Input
              id="discriminator"
              value={discriminator}
              onChange={(e) => setDiscriminator(e.target.value)}
              pattern="[a-z0-9\-_.]+"
              title="Lowercase letters, numbers, hyphens, underscores and dots only"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
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
            <Label htmlFor="confirm-password">Confirm password</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className={passwordMismatch ? 'border-destructive' : ''}
              required
            />
            {passwordMismatch && (
              <p className="text-xs text-destructive">Passwords do not match.</p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || passwordMismatch || !name || !discriminator || !password || !confirmPassword}
          >
            {loading ? 'Confirming…' : 'Confirm account'}
          </Button>
        </form>
      </div>
    </div>
  )
}
