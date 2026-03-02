import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Camera, LogOut, Trash2, AlertTriangle, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { useAuthStore } from '@/stores/authStore'
import { useUiStore } from '@/stores/uiStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { applyVoiceSettings } from '@/services/voiceService'
import { useNavigate } from 'react-router-dom'
import { userApi, uploadApi, axiosInstance } from '@/api/client'
import type { ModelUserSettingsData, DtoUser } from '@/client'
import { cn } from '@/lib/utils'
import ImageCropDialog from '@/components/modals/ImageCropDialog'
import MicTest from '@/components/voice/MicTest'
import OutputTest from '@/components/voice/OutputTest'

type Section = 'account' | 'appearance' | 'voice' | 'danger'

const NAV: { key: Section; label: string; danger?: boolean }[] = [
  { key: 'account', label: 'My Account' },
  { key: 'appearance', label: 'Appearance' },
  { key: 'voice', label: 'Voice & Video' },
  { key: 'danger', label: 'Danger Zone', danger: true },
]

/** Converts a KeyboardEvent.code like "KeyV" or "ShiftLeft" into a readable label. */
function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
  // Common modifiers
  const map: Record<string, string> = {
    ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt', AltRight: 'Right Alt',
    MetaLeft: 'Left Meta', MetaRight: 'Right Meta',
    Space: 'Space', Tab: 'Tab', CapsLock: 'Caps Lock',
    Backquote: '`', Minus: '-', Equal: '=',
    BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
  }
  return map[code] ?? code
}

function Toggle({ value, onToggle }: { value: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors shrink-0',
        value ? 'bg-green-500' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
          value && 'translate-x-5',
        )}
      />
    </button>
  )
}

export default function AppSettingsModal() {
  const open = useUiStore((s) => s.appSettingsOpen)
  const close = useUiStore((s) => s.closeAppSettings)
  const user = useAuthStore((s) => s.user)
  const setUser = useAuthStore((s) => s.setUser)
  const logout = useAuthStore((s) => s.logout)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const [section, setSection] = useState<Section>('account')

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [cropDialogOpen, setCropDialogOpen] = useState(false)
  const [cropImageDataUrl, setCropImageDataUrl] = useState('')

  // My Account
  const [name, setName] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)

  // Appearance
  const [fontScale, setFontScale] = useState(1.0)
  const [chatSpacing, setChatSpacing] = useState(16)
  const [savingAppearance, setSavingAppearance] = useState(false)

  // Voice & Video
  const [audioInputDevice, setAudioInputDevice] = useState('')
  const [audioOutputDevice, setAudioOutputDevice] = useState('')
  const [inputLevel, setInputLevel] = useState(100)
  const [outputLevel, setOutputLevel] = useState(100)
  const [autoGainControl, setAutoGainControl] = useState(true)
  const [echoCancellation, setEchoCancellation] = useState(true)
  const [noiseSuppression, setNoiseSuppression] = useState(true)
  const [inputMode, setInputMode] = useState<'voice_activity' | 'push_to_talk'>('voice_activity')
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(50)
  const [pushToTalkKey, setPushToTalkKey] = useState('')
  const [isRecordingPTTKey, setIsRecordingPTTKey] = useState(false)
  const [savingVoice, setSavingVoice] = useState(false)
  const [voiceDirty, setVoiceDirty] = useState(false)
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([])
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([])


  // Load saved settings
  const { data: settingsData } = useQuery({
    queryKey: ['user-settings'],
    queryFn: () => userApi.userMeSettingsGet({}).then((r) => r.data?.settings),
    enabled: open,
    staleTime: 60_000,
  })

  // Init account form when modal opens
  useEffect(() => {
    if (open) {
      setName(user?.name ?? '')
      setSection('account')
    }
  }, [open, user?.name])

  // Init appearance from loaded settings
  useEffect(() => {
    if (settingsData?.appearance) {
      setFontScale(settingsData.appearance.chat_font_scale ?? 1.0)
      setChatSpacing(settingsData.appearance.chat_spacing ?? 16)
    }
  }, [settingsData])

  // Init voice from loaded settings
  useEffect(() => {
    if (settingsData?.devices) {
      const d = settingsData.devices
      setAudioInputDevice(d.audio_input_device ?? '')
      setAudioOutputDevice(d.audio_output_device ?? '')
      setInputLevel(d.audio_input_level ?? 100)
      setOutputLevel(d.audio_output_level ?? 100)
      setAutoGainControl(d.auto_gain_control ?? true)
      setEchoCancellation(d.echo_cancellation ?? true)
      setNoiseSuppression(d.noise_suppression ?? true)
    }
    if (settingsData?.devices) {
      const d = settingsData.devices as Record<string, unknown>
      if (d.input_mode === 'push_to_talk') setInputMode('push_to_talk')
      else setInputMode('voice_activity')
      if (typeof d.voice_activity_threshold === 'number') setVoiceActivityThreshold(d.voice_activity_threshold)
      if (typeof d.push_to_talk_key === 'string') setPushToTalkKey(d.push_to_talk_key)
    }
    setVoiceDirty(false)
  }, [settingsData])

  // Enumerate audio devices when switching to Voice section
  useEffect(() => {
    if (section !== 'voice') return
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setAudioInputDevices(devices.filter((d) => d.kind === 'audioinput'))
        setAudioOutputDevices(devices.filter((d) => d.kind === 'audiooutput'))
      })
      .catch(() => {})
  }, [section])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, close])

  // Mark voice dirty on any change
  const markVoiceDirty = useCallback(() => setVoiceDirty(true), [])

  // PTT key recording handler
  useEffect(() => {
    if (!isRecordingPTTKey) return
    const handler = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setPushToTalkKey(e.code)
      setIsRecordingPTTKey(false)
      setVoiceDirty(true)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isRecordingPTTKey])

  if (!open) return null

  const initials = (user?.name ?? '?').charAt(0).toUpperCase()
  const nameChanged = name.trim() !== '' && name.trim() !== user?.name

  async function patchSettings(update: Partial<ModelUserSettingsData>) {
    const merged: ModelUserSettingsData = { ...(settingsData ?? {}), ...update }
    await userApi.userMeSettingsPost({ request: merged })
    await queryClient.invalidateQueries({ queryKey: ['user-settings'] })
  }

  // Step 1 — file picker opens → read as data URL → show crop dialog
  function handleAvatarFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = '' // allow re-selecting the same file
    const reader = new FileReader()
    reader.onload = () => {
      setCropImageDataUrl(reader.result as string)
      setCropDialogOpen(true)
    }
    reader.readAsDataURL(file)
  }

  // Step 2 — crop confirmed → upload cropped JPEG blob
  async function handleAvatarCropConfirmed(blob: Blob) {
    setCropDialogOpen(false)
    setUploadingAvatar(true)
    try {
      const baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'
      // 1. Create the avatar placeholder (always send as JPEG after crop)
      const placeholder = await userApi.userMeAvatarPost({
        request: { content_type: 'image/jpeg', file_size: blob.size },
      })
      const avatarId = String(placeholder.data.id)
      const userId   = String(placeholder.data.user_id)
      // 2. Upload the cropped binary
      await uploadApi.uploadAvatarsUserIdAvatarIdPost({
        userId,
        avatarId,
        file: blob as unknown as number[],
      })
      // 3. Refresh user data so the new avatar shows immediately
      const meRes = await axiosInstance.get<DtoUser>(`${baseUrl}/user/me`)
      setUser(meRes.data)
      toast.success('Avatar updated!')
    } catch {
      toast.error('Failed to upload avatar')
    } finally {
      setUploadingAvatar(false)
    }
  }

  async function handleSaveAccount() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === user?.name) return
    setSavingAccount(true)
    try {
      await userApi.userMePatch({ request: { name: trimmed } })
      if (user) setUser({ ...user, name: trimmed })
      toast.success('Profile updated')
    } catch {
      toast.error('Failed to update profile')
    } finally {
      setSavingAccount(false)
    }
  }

  async function handleSaveAppearance() {
    setSavingAppearance(true)
    try {
      await patchSettings({ appearance: { chat_font_scale: fontScale, chat_spacing: chatSpacing } })
      toast.success('Appearance saved')
    } catch {
      toast.error('Failed to save appearance')
    } finally {
      setSavingAppearance(false)
    }
  }

  function handleLogout() {
    close()
    logout()
    navigate('/')
  }

  async function handleSaveVoice() {
    setSavingVoice(true)
    try {
      await patchSettings({
        devices: {
          audio_input_device: audioInputDevice || undefined,
          audio_output_device: audioOutputDevice || undefined,
          audio_input_level: inputLevel,
          audio_output_level: outputLevel,
          auto_gain_control: autoGainControl,
          echo_cancellation: echoCancellation,
          noise_suppression: noiseSuppression,
          // Extended voice settings (stored in devices blob)
          input_mode: inputMode,
          voice_activity_threshold: voiceActivityThreshold,
          push_to_talk_key: pushToTalkKey,
        } as Record<string, unknown>,
      })
      useVoiceStore.getState().setSettings({
        audioInputDevice,
        audioOutputDevice,
        audioInputLevel: inputLevel,
        audioOutputLevel: outputLevel,
        autoGainControl,
        echoCancellation,
        noiseSuppression,
        inputMode,
        voiceActivityThreshold,
        pushToTalkKey,
      })
      applyVoiceSettings()
      setVoiceDirty(false)
      toast.success('Voice settings saved')
    } catch {
      toast.error('Failed to save voice settings')
    } finally {
      setSavingVoice(false)
    }
  }

  function handleResetVoiceDefaults() {
    setAudioInputDevice('')
    setAudioOutputDevice('')
    setInputLevel(100)
    setOutputLevel(100)
    setAutoGainControl(true)
    setEchoCancellation(true)
    setNoiseSuppression(true)
    setInputMode('voice_activity')
    setVoiceActivityThreshold(50)
    setPushToTalkKey('')
    setVoiceDirty(true)
  }

  const selectClass =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <>
    <div className="fixed inset-0 z-50 flex bg-background/80 backdrop-blur-sm">
      <div className="flex w-full h-full overflow-hidden">

        {/* ── Left sidebar ── */}
        <div className="flex flex-1 justify-end bg-sidebar border-r border-sidebar-border">
          <div className="w-52 py-16 px-3 shrink-0">
            <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1">
              User Settings
            </p>
            <div className="space-y-0.5">
              {NAV.map((s, i) => (
                <>
                  {/* Separator before Danger Zone */}
                  {s.danger && i > 0 && (
                    <div key={`sep-${s.key}`} className="my-2 h-px bg-border mx-3" />
                  )}
                  <button
                    key={s.key}
                    onClick={() => setSection(s.key)}
                    className={cn(
                      'w-full text-left px-3 py-1.5 rounded text-sm transition-colors',
                      s.danger
                        ? section === s.key
                          ? 'bg-destructive/20 text-destructive'
                          : 'text-destructive/70 hover:text-destructive hover:bg-destructive/10'
                        : section === s.key
                          ? 'bg-accent text-foreground'
                          : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
                    )}
                  >
                    {s.label}
                  </button>
                </>
              ))}
            </div>
          </div>
        </div>

        {/* ── Content ── */}
        <div className="flex flex-1 min-w-0">
          <div className="flex-1 max-w-2xl py-16 px-10 overflow-y-auto">

            {/* My Account */}
            {section === 'account' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold">My Account</h2>

                <div className="flex items-center gap-4 p-4 rounded-lg bg-accent/30">
                  {/* Clickable avatar with camera overlay */}
                  <div
                    className="relative shrink-0 group cursor-pointer"
                    onClick={() => !uploadingAvatar && avatarInputRef.current?.click()}
                    title="Change avatar"
                  >
                    <Avatar className="w-16 h-16 text-2xl">
                      <AvatarImage src={user?.avatar?.url} alt={user?.name ?? ''} className="object-cover" />
                      <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-bold">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    {/* Hover overlay */}
                    {!uploadingAvatar && (
                      <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                        <Camera className="w-5 h-5 text-white" />
                      </div>
                    )}
                    {/* Upload spinner */}
                    {uploadingAvatar && (
                      <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                  </div>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={handleAvatarFileSelected}
                  />
                  <div>
                    <p className="font-semibold text-lg">{user?.name}</p>
                    {user?.discriminator && (
                      <p className="text-sm text-muted-foreground">#{user.discriminator}</p>
                    )}
                  </div>
                </div>

                <Separator />

                <div className="space-y-2">
                  <Label htmlFor="settings-username">Username</Label>
                  <div className="flex gap-2">
                    <Input
                      id="settings-username"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveAccount() }}
                      placeholder="Username"
                      className="flex-1"
                    />
                    <Button onClick={() => void handleSaveAccount()} disabled={savingAccount || !nameChanged}>
                      Save
                    </Button>
                  </div>
                </div>

                {user?.discriminator && (
                  <div className="space-y-2">
                    <Label>Discriminator</Label>
                    <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                      #{user.discriminator}
                    </p>
                  </div>
                )}

                <Separator />

                <div className="space-y-2">
                  <Label>User ID</Label>
                  <div className="flex gap-2 items-center">
                    <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md flex-1 font-mono truncate">
                      {String(user?.id ?? '')}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard.writeText(String(user?.id ?? ''))
                        toast.success('Copied!')
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Appearance */}
            {section === 'appearance' && (
              <div className="space-y-8">
                <h2 className="text-xl font-bold">Appearance</h2>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Chat Font Scale</Label>
                    <span className="text-sm font-medium tabular-nums">{Math.round(fontScale * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0.75} max={1.5} step={0.05}
                    value={fontScale}
                    onChange={(e) => setFontScale(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground select-none">
                    <span>75%</span><span>100%</span><span>150%</span>
                  </div>
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Message Spacing</Label>
                    <span className="text-sm font-medium tabular-nums">{chatSpacing}px</span>
                  </div>
                  <input
                    type="range" min={0} max={32} step={4}
                    value={chatSpacing}
                    onChange={(e) => setChatSpacing(Number(e.target.value))}
                    className="w-full accent-primary"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground select-none">
                    <span>Compact</span><span>Comfortable</span><span>Spacious</span>
                  </div>
                </div>

                <Separator />

                {/* Live preview */}
                <div className="space-y-2">
                  <Label>Preview</Label>
                  <div
                    className="rounded-lg border border-border bg-background p-4"
                    style={{ display: 'flex', flexDirection: 'column', gap: `${chatSpacing}px` }}
                  >
                    {(['Hello there! 👋', 'Hey! How are you doing?', 'Pretty good, thanks!'] as const).map((msg, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <div className="w-8 h-8 rounded-full bg-primary/80 flex items-center justify-center text-primary-foreground text-xs font-bold shrink-0 select-none">
                          {['A', 'B', 'A'][i]}
                        </div>
                        <div>
                          <span className="font-semibold text-sm mr-2">{['Alice', 'Bob', 'Alice'][i]}</span>
                          <span className="text-xs text-muted-foreground">Today at 12:0{i}</span>
                          <p style={{ fontSize: `${fontScale}rem` }} className="mt-0.5 leading-snug">{msg}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button onClick={() => void handleSaveAppearance()} disabled={savingAppearance}>
                    {savingAppearance ? 'Saving…' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            )}

            {/* Voice & Video */}
            {section === 'voice' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold">Voice & Video</h2>

                {/* ── Input Device ── */}
                <div className="space-y-2">
                  <Label htmlFor="audio-input">Input Device</Label>
                  <select
                    id="audio-input"
                    value={audioInputDevice}
                    onChange={(e) => { setAudioInputDevice(e.target.value); markVoiceDirty() }}
                    className={selectClass}
                  >
                    <option value="">Default</option>
                    {audioInputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Input Volume</Label>
                    <span className="text-sm font-medium tabular-nums">{inputLevel}%</span>
                  </div>
                  <input
                    type="range" min={0} max={200} step={5}
                    value={inputLevel}
                    onChange={(e) => { setInputLevel(Number(e.target.value)); markVoiceDirty() }}
                    className="w-full accent-primary"
                  />
                </div>

                <Separator />

                {/* ── Output Device ── */}
                <div className="space-y-2">
                  <Label htmlFor="audio-output">Output Device</Label>
                  <select
                    id="audio-output"
                    value={audioOutputDevice}
                    onChange={(e) => { setAudioOutputDevice(e.target.value); markVoiceDirty() }}
                    className={selectClass}
                  >
                    <option value="">Default</option>
                    {audioOutputDevices.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.label || `Speaker (${d.deviceId.slice(0, 8)}…)`}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Output Volume</Label>
                    <span className="text-sm font-medium tabular-nums">{outputLevel}%</span>
                  </div>
                  <input
                    type="range" min={0} max={200} step={5}
                    value={outputLevel}
                    onChange={(e) => { setOutputLevel(Number(e.target.value)); markVoiceDirty() }}
                    className="w-full accent-primary"
                  />
                </div>

                {/* ── Output Test ── */}
                <OutputTest
                  outputDeviceId={audioOutputDevice}
                  outputLevel={outputLevel}
                />

                <Separator />

                {/* ── Mic Test ── */}
                <MicTest
                  inputDeviceId={audioInputDevice}
                  inputLevel={inputLevel}
                  autoGainControl={autoGainControl}
                  echoCancellation={echoCancellation}
                  noiseSuppression={noiseSuppression}
                  outputDeviceId={audioOutputDevice}
                  outputLevel={outputLevel}
                />

                <Separator />

                {/* ── Input Mode ── */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Input Mode
                  </p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => { setInputMode('voice_activity'); markVoiceDirty() }}
                      className={cn(
                        'flex-1 px-4 py-2.5 rounded-md border text-sm font-medium transition-colors',
                        inputMode === 'voice_activity'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground',
                      )}
                    >
                      Voice Activity
                    </button>
                    <button
                      type="button"
                      onClick={() => { setInputMode('push_to_talk'); markVoiceDirty() }}
                      className={cn(
                        'flex-1 px-4 py-2.5 rounded-md border text-sm font-medium transition-colors',
                        inputMode === 'push_to_talk'
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground',
                      )}
                    >
                      Push to Talk
                    </button>
                  </div>

                  {inputMode === 'voice_activity' && (
                    <div className="space-y-2 pt-1">
                      <div className="flex items-center justify-between">
                        <Label className="text-sm text-muted-foreground">Sensitivity Threshold</Label>
                        <span className="text-sm font-medium tabular-nums">{voiceActivityThreshold}%</span>
                      </div>
                      <input
                        type="range" min={0} max={100} step={1}
                        value={voiceActivityThreshold}
                        onChange={(e) => { setVoiceActivityThreshold(Number(e.target.value)); markVoiceDirty() }}
                        className="w-full accent-primary"
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground select-none">
                        <span>Sensitive</span>
                        <span>Aggressive</span>
                      </div>
                    </div>
                  )}

                  {inputMode === 'push_to_talk' && (
                    <div className="space-y-2 pt-1">
                      <Label className="text-sm text-muted-foreground">Shortcut</Label>
                      <div className="flex gap-2 items-center">
                        <button
                          type="button"
                          onClick={() => setIsRecordingPTTKey(true)}
                          className={cn(
                            'flex-1 px-3 py-2 rounded-md border text-sm text-left transition-colors',
                            isRecordingPTTKey
                              ? 'border-primary bg-primary/10 text-primary animate-pulse'
                              : 'border-border bg-background text-foreground hover:border-muted-foreground',
                          )}
                        >
                          {isRecordingPTTKey
                            ? 'Press any key…'
                            : pushToTalkKey
                              ? formatKeyCode(pushToTalkKey)
                              : 'Click to set key'}
                        </button>
                        {pushToTalkKey && !isRecordingPTTKey && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => { setPushToTalkKey(''); markVoiceDirty() }}
                            className="text-muted-foreground"
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                <Separator />

                {/* ── Audio Processing Toggles ── */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                    Audio Processing
                  </p>
                  <div className="space-y-1">
                    {[
                      { label: 'Echo Cancellation', desc: 'Removes echo from your microphone output', value: echoCancellation, onToggle: () => { setEchoCancellation((v) => !v); markVoiceDirty() } },
                      { label: 'Noise Suppression', desc: 'Filters out background noise like fans and keyboards', value: noiseSuppression, onToggle: () => { setNoiseSuppression((v) => !v); markVoiceDirty() } },
                      { label: 'Auto Gain Control', desc: 'Automatically adjusts input volume', value: autoGainControl, onToggle: () => { setAutoGainControl((v) => !v); markVoiceDirty() } },
                    ].map(({ label, desc, value, onToggle }) => (
                      <div key={label} className="flex items-center justify-between py-2.5 gap-4">
                        <div className="min-w-0">
                          <p className="text-sm">{label}</p>
                          <p className="text-xs text-muted-foreground">{desc}</p>
                        </div>
                        <Toggle value={value} onToggle={onToggle} />
                      </div>
                    ))}
                  </div>
                </div>

                {/* ── Action Buttons ── */}
                <div className="flex items-center justify-between pt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleResetVoiceDefaults}
                    className="gap-2 text-muted-foreground"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset to Defaults
                  </Button>
                  <Button onClick={() => void handleSaveVoice()} disabled={savingVoice || !voiceDirty}>
                    {savingVoice ? 'Saving…' : 'Save Changes'}
                  </Button>
                </div>
              </div>
            )}

            {/* Danger Zone */}
            {section === 'danger' && (
              <div className="space-y-6">
                <h2 className="text-xl font-bold flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5 text-destructive" />
                  Danger Zone
                </h2>
                <p className="text-sm text-muted-foreground">
                  These actions are irreversible. Please proceed with caution.
                </p>

                {/* Log Out */}
                <div className="rounded-lg border border-border p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-sm">Log Out</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Sign out of your account on this device.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 gap-2"
                    onClick={handleLogout}
                  >
                    <LogOut className="w-4 h-4" />
                    Log Out
                  </Button>
                </div>

                {/* Delete Account */}
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-center justify-between gap-4">
                  <div>
                    <p className="font-medium text-sm text-destructive">Delete Account</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Permanently delete your account and all associated data. This cannot be undone.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    className="shrink-0 gap-2"
                    disabled
                    title="Account deletion is not yet available"
                  >
                    <Trash2 className="w-4 h-4" />
                    Delete
                  </Button>
                </div>
              </div>
            )}

          </div>

          {/* Close button */}
          <div className="pt-16 pr-6 shrink-0">
            <button
              onClick={close}
              className="w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

      </div>
    </div>

    {/* Avatar crop dialog — rendered above the settings modal */}
    <ImageCropDialog
      open={cropDialogOpen}
      imageDataUrl={cropImageDataUrl}
      onCancel={() => setCropDialogOpen(false)}
      onCrop={(blob) => void handleAvatarCropConfirmed(blob)}
    />
    </>
  )
}
