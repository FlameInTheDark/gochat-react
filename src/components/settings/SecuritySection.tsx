import { useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import {
  ShieldCheck, ShieldOff, Eye, EyeOff, Copy,
  AlertTriangle, RefreshCw, KeyRound,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { authApi } from '@/api/client'
import { useAuthStore } from '@/stores/authStore'
import type { AuthTOTPSetupResponse } from '@/client'

// ---- Password input with show/hide toggle ----

function PasswordInput({
  id, value, onChange, placeholder,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative">
      <Input
        id={id}
        type={show ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="pr-10"
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setShow((s) => !s)}
        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
      >
        {show ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  )
}

// ---- Code type toggle + code input ----

function TwoFaCodeInput({
  codeType, setCodeType, code, setCode,
}: {
  codeType: 'totp' | 'recovery_code'
  setCodeType: (t: 'totp' | 'recovery_code') => void
  code: string
  setCode: (c: string) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="space-y-2">
      <Label>{t('settings.secVerificationCode')}</Label>
      <div className="flex gap-2">
        {(['totp', 'recovery_code'] as const).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => setCodeType(type)}
            className={`text-xs px-2 py-1 rounded border transition-colors ${
              codeType === type
                ? 'border-primary text-primary bg-primary/10'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {type === 'totp' ? t('settings.secCodeTypeAuthenticator') : t('settings.secCodeTypeRecovery')}
          </button>
        ))}
      </div>
      <Input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder={codeType === 'totp' ? t('settings.secCodePlaceholderTotp') : t('settings.secCodePlaceholderRecovery')}
        className="font-mono"
        autoComplete="one-time-code"
      />
    </div>
  )
}

// ---- Recovery codes display ----

function RecoveryCodesDisplay({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
        <p className="text-sm font-semibold text-amber-400 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" /> {t('settings.secRecoverySaveTitle')}
        </p>
        <p className="text-xs text-muted-foreground mt-1">{t('settings.secRecoverySaveDesc')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2 font-mono text-sm bg-muted rounded-lg p-4">
        {codes.map((c) => (
          <span key={c} className="select-all tracking-wide">{c}</span>
        ))}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void navigator.clipboard.writeText(codes.join('\n'))
          toast.success(t('settings.secCopied'))
        }}
        className="gap-2"
      >
        <Copy className="w-4 h-4" /> {t('settings.secCopyAll')}
      </Button>
      <Button onClick={onDone} className="w-full">{t('settings.secRecoveryDoneBtn')}</Button>
    </div>
  )
}

// ---- Change Password section ----

function ChangePasswordSection({ twoFaEnabled }: { twoFaEnabled: boolean }) {
  const { t } = useTranslation()
  const setToken = useAuthStore((s) => s.setToken)
  const setRefreshToken = useAuthStore((s) => s.setRefreshToken)
  const [currentPw, setCurrentPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [confirmPw, setConfirmPw] = useState('')
  const [codeType, setCodeType] = useState<'totp' | 'recovery_code'>('totp')
  const [code, setCode] = useState('')
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (newPw !== confirmPw) { toast.error(t('settings.secPasswordMismatch')); return }
    if (newPw.length < 8) { toast.error(t('settings.secPasswordTooShort')); return }
    setSaving(true)
    try {
      const res = await authApi.authPasswordChangePost({
        request: {
          current_password: currentPw,
          new_password: newPw,
          ...(twoFaEnabled ? { code_type: codeType, code } : {}),
        },
      })
      if (res.data.token) setToken(res.data.token)
      if (res.data.refresh_token) setRefreshToken(res.data.refresh_token)
      toast.success(t('settings.secPasswordChanged'))
      setCurrentPw(''); setNewPw(''); setConfirmPw(''); setCode('')
    } catch {
      toast.error(t('settings.secPasswordChangeFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e) }} className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {t('settings.secChangePasswordTitle')}
      </h3>
      <div className="space-y-2">
        <Label htmlFor="cp-current">{t('settings.secCurrentPassword')}</Label>
        <PasswordInput id="cp-current" value={currentPw} onChange={setCurrentPw} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cp-new">{t('settings.secNewPassword')}</Label>
        <PasswordInput id="cp-new" value={newPw} onChange={setNewPw} placeholder={t('settings.secNewPasswordPlaceholder')} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="cp-confirm">{t('settings.secConfirmPassword')}</Label>
        <PasswordInput id="cp-confirm" value={confirmPw} onChange={setConfirmPw} />
      </div>
      {twoFaEnabled && (
        <TwoFaCodeInput codeType={codeType} setCodeType={setCodeType} code={code} setCode={setCode} />
      )}
      <Button type="submit" disabled={saving || !currentPw || !newPw || !confirmPw}>
        {saving ? t('settings.secSaving') : t('settings.secChangePasswordBtn')}
      </Button>
    </form>
  )
}

// ---- TOTP setup wizard ----

type SetupStep = 'password' | 'scanning' | 'confirming'

function TotpSetupWizard({
  onDone, onCancel,
}: {
  onDone: (codes: string[], token?: string, refreshToken?: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [step, setStep] = useState<SetupStep>('password')
  const [password, setPassword] = useState('')
  const [setupData, setSetupData] = useState<AuthTOTPSetupResponse | null>(null)
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)
  const [showManualKey, setShowManualKey] = useState(false)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    if (step === 'scanning' && setupData?.otpauth_uri && canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, setupData.otpauth_uri, { width: 200, margin: 2 })
    }
  }, [step, setupData])

  async function handleSetup() {
    setLoading(true)
    try {
      const res = await authApi.auth2faTotpSetupPost({ request: { current_password: password } })
      setSetupData(res.data)
      setStep('scanning')
    } catch {
      toast.error(t('settings.secTotpWrongPassword'))
    } finally {
      setLoading(false)
    }
  }

  async function handleConfirm() {
    if (!setupData?.setup_id) return
    setLoading(true)
    try {
      const res = await authApi.auth2faTotpConfirmPost({ request: { setup_id: setupData.setup_id, code } })
      onDone(res.data.recovery_codes ?? [], res.data.token, res.data.refresh_token)
    } catch {
      toast.error(t('settings.secTotpInvalidCode'))
    } finally {
      setLoading(false)
    }
  }

  if (step === 'password') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.secTotpPasswordDesc')}</p>
        <div className="space-y-2">
          <Label htmlFor="totp-setup-pw">{t('settings.secCurrentPassword')}</Label>
          <PasswordInput id="totp-setup-pw" value={password} onChange={setPassword} />
        </div>
        <div className="flex gap-2">
          <Button onClick={() => void handleSetup()} disabled={loading || !password}>
            {loading ? t('settings.secTotpVerifying') : t('settings.secTotpContinue')}
          </Button>
          <Button variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
        </div>
      </div>
    )
  }

  if (step === 'scanning') {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t('settings.secTotpScanDesc')}</p>
        <div className="flex justify-center bg-white rounded-lg p-3 border border-border w-fit mx-auto">
          <canvas ref={canvasRef} className="rounded" />
        </div>
        <div>
          <button
            type="button"
            onClick={() => setShowManualKey((s) => !s)}
            className="text-xs text-muted-foreground underline"
          >
            {showManualKey ? t('settings.secTotpHideManualKey') : t('settings.secTotpShowManualKey')}
          </button>
          {showManualKey && setupData?.manual_key && (
            <div className="mt-2 flex items-center gap-2 bg-muted rounded p-2">
              <code className="text-xs font-mono select-all break-all flex-1">{setupData.manual_key}</code>
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(setupData.manual_key ?? ''); toast.success(t('settings.secCopied')) }}
                className="text-muted-foreground hover:text-foreground shrink-0"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
        <Button onClick={() => setStep('confirming')} className="w-full">{t('settings.secTotpScannedBtn')}</Button>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('settings.secTotpConfirmDesc')}</p>
      <div className="space-y-2">
        <Label htmlFor="totp-verify-code">{t('settings.secTotpAuthCodeLabel')}</Label>
        <Input
          id="totp-verify-code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
          placeholder="000000"
          className="font-mono text-center text-xl tracking-[0.5em]"
          maxLength={6}
          autoComplete="one-time-code"
          autoFocus
        />
      </div>
      <div className="flex gap-2">
        <Button onClick={() => void handleConfirm()} disabled={loading || code.length !== 6}>
          {loading ? t('settings.secTotpVerifying') : t('settings.secTotpEnableBtn')}
        </Button>
        <Button variant="outline" onClick={() => setStep('scanning')}>{t('common.back')}</Button>
      </div>
    </div>
  )
}

// ---- Generic 2FA action form ----

function TwoFaActionForm({
  title, description, submitLabel, destructive, onSubmit, onCancel,
}: {
  title: string
  description: string
  submitLabel: string
  destructive?: boolean
  onSubmit: (password: string, code: string, codeType: 'totp' | 'recovery_code') => Promise<void>
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [password, setPassword] = useState('')
  const [codeType, setCodeType] = useState<'totp' | 'recovery_code'>('totp')
  const [code, setCode] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit(password, code, codeType)
    } finally {
      setLoading(false)
    }
  }

  return (
    <form onSubmit={(e) => { void handleSubmit(e) }} className="rounded-lg border border-border p-4 space-y-4">
      <div>
        <p className="font-medium text-sm">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="space-y-2">
        <Label>{t('settings.secCurrentPassword')}</Label>
        <PasswordInput id="tfa-action-pw" value={password} onChange={setPassword} />
      </div>
      <TwoFaCodeInput codeType={codeType} setCodeType={setCodeType} code={code} setCode={setCode} />
      <div className="flex gap-2">
        <Button type="submit" variant={destructive ? 'destructive' : 'default'} disabled={loading || !password || !code}>
          {loading ? t('settings.secProcessing') : submitLabel}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button>
      </div>
    </form>
  )
}

// ---- Main SecuritySection ----

type TotpWizardState = 'idle' | 'setup' | 'codes'
type ActionState = 'idle' | 'disable' | 'regen' | 'regenCodes'

export default function SecuritySection() {
  const { t } = useTranslation()
  const setToken = useAuthStore((s) => s.setToken)
  const setRefreshToken = useAuthStore((s) => s.setRefreshToken)
  const queryClient = useQueryClient()

  const { data: twoFaStatus, isLoading: statusLoading } = useQuery({
    queryKey: ['2fa-status'],
    queryFn: () => authApi.auth2faGet().then((r) => r.data),
    staleTime: 30_000,
  })

  const [totpWizard, setTotpWizard] = useState<TotpWizardState>('idle')
  const [wizardCodes, setWizardCodes] = useState<string[]>([])
  const [actionState, setActionState] = useState<ActionState>('idle')
  const [regenCodes, setRegenCodes] = useState<string[]>([])

  const twoFaEnabled = twoFaStatus?.enabled ?? false

  function handleTotpEnabled(codes: string[], token?: string, refreshToken?: string) {
    if (token) setToken(token)
    if (refreshToken) setRefreshToken(refreshToken)
    setWizardCodes(codes)
    setTotpWizard('codes')
    void queryClient.invalidateQueries({ queryKey: ['2fa-status'] })
  }

  async function handleDisable(password: string, code: string, codeType: 'totp' | 'recovery_code') {
    try {
      const res = await authApi.auth2faDelete({ request: { current_password: password, code, code_type: codeType } })
      if (res.data.token) setToken(res.data.token)
      if (res.data.refresh_token) setRefreshToken(res.data.refresh_token)
      toast.success(t('settings.secDisabledSuccess'))
      setActionState('idle')
      void queryClient.invalidateQueries({ queryKey: ['2fa-status'] })
    } catch {
      toast.error(t('settings.secInvalidCredentials'))
    }
  }

  async function handleRegen(password: string, code: string, codeType: 'totp' | 'recovery_code') {
    try {
      const res = await authApi.auth2faRecoveryCodesRegeneratePost({ request: { current_password: password, code, code_type: codeType } })
      if (res.data.token) setToken(res.data.token)
      if (res.data.refresh_token) setRefreshToken(res.data.refresh_token)
      setRegenCodes(res.data.recovery_codes ?? [])
      setActionState('regenCodes')
      void queryClient.invalidateQueries({ queryKey: ['2fa-status'] })
    } catch {
      toast.error(t('settings.secInvalidCredentials'))
    }
  }

  return (
    <div className="space-y-8">
      <h2 className="text-xl font-bold flex items-center gap-2">
        <KeyRound className="w-5 h-5" />
        {t('settings.security')}
      </h2>

      <ChangePasswordSection twoFaEnabled={twoFaEnabled} />

      <Separator />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {t('settings.sec2faTitle')}
          </h3>
          {!statusLoading && (
            twoFaEnabled ? (
              <span className="flex items-center gap-1.5 text-xs text-green-400 font-medium">
                <ShieldCheck className="w-3.5 h-3.5" /> {t('settings.sec2faEnabled')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ShieldOff className="w-3.5 h-3.5" /> {t('settings.sec2faDisabled')}
              </span>
            )
          )}
        </div>

        {statusLoading && <p className="text-sm text-muted-foreground">{t('app.loading')}</p>}

        {!statusLoading && !twoFaEnabled && totpWizard === 'idle' && (
          <div className="rounded-lg border border-border p-4 space-y-3">
            <p className="text-sm text-muted-foreground">{t('settings.sec2faEnableDesc')}</p>
            <Button onClick={() => setTotpWizard('setup')} className="gap-2">
              <ShieldCheck className="w-4 h-4" /> {t('settings.sec2faEnableBtn')}
            </Button>
          </div>
        )}

        {!statusLoading && !twoFaEnabled && totpWizard === 'setup' && (
          <div className="rounded-lg border border-border p-4">
            <TotpSetupWizard onDone={handleTotpEnabled} onCancel={() => setTotpWizard('idle')} />
          </div>
        )}

        {totpWizard === 'codes' && (
          <RecoveryCodesDisplay codes={wizardCodes} onDone={() => setTotpWizard('idle')} />
        )}

        {!statusLoading && twoFaEnabled && totpWizard === 'idle' && actionState === 'idle' && (
          <div className="space-y-3">
            <div className="rounded-lg border border-border p-4 space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">{t('settings.sec2faMethod')}</span>
                <span className="font-medium capitalize">{twoFaStatus?.factor_type ?? 'totp'}</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">{t('settings.sec2faRecoveryCodesRemaining')}</span>
                <span className={`font-medium flex items-center gap-1 ${(twoFaStatus?.recovery_codes_remaining ?? 10) <= 2 ? 'text-amber-400' : ''}`}>
                  {twoFaStatus?.recovery_codes_remaining ?? '—'}
                  {(twoFaStatus?.recovery_codes_remaining ?? 10) <= 2 && <AlertTriangle className="w-3.5 h-3.5" />}
                </span>
              </div>
            </div>
            <div className="flex gap-2 flex-wrap">
              <Button variant="outline" size="sm" onClick={() => setActionState('regen')} className="gap-2">
                <RefreshCw className="w-3.5 h-3.5" /> {t('settings.sec2faRegenBtn')}
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setActionState('disable')} className="gap-2">
                <ShieldOff className="w-3.5 h-3.5" /> {t('settings.sec2faDisableBtn')}
              </Button>
            </div>
          </div>
        )}

        {!statusLoading && twoFaEnabled && actionState === 'disable' && (
          <TwoFaActionForm
            title={t('settings.secDisableTitle')}
            description={t('settings.secDisableDesc')}
            submitLabel={t('settings.secDisableSubmit')}
            destructive
            onSubmit={handleDisable}
            onCancel={() => setActionState('idle')}
          />
        )}

        {!statusLoading && twoFaEnabled && actionState === 'regen' && (
          <TwoFaActionForm
            title={t('settings.secRegenTitle')}
            description={t('settings.secRegenDesc')}
            submitLabel={t('settings.secRegenSubmit')}
            onSubmit={handleRegen}
            onCancel={() => setActionState('idle')}
          />
        )}

        {actionState === 'regenCodes' && (
          <RecoveryCodesDisplay codes={regenCodes} onDone={() => setActionState('idle')} />
        )}
      </div>
    </div>
  )
}
