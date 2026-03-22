import { useState, useEffect, useRef, useCallback } from 'react'
import { X, Camera, LogOut, Trash2, AlertTriangle, RotateCcw, Globe, ChevronLeft, ChevronRight } from 'lucide-react'
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
import { useAppearanceStore, DEFAULT_CHAT_SPACING, DEFAULT_FONT_SCALE } from '@/stores/appearanceStore'
import { applyVoiceSettings } from '@/services/voiceService'
import { buildDenoiserNode, destroyDenoiserNode, effectiveDenoiserType, effectiveNoiseSuppression, type DenoiserNode } from '@/services/denoiserService'
import { useNavigate } from 'react-router-dom'
import { userApi, uploadApi, axiosInstance } from '@/api/client'
import type { ModelUserSettingsData, DtoUser } from '@/client'
import { cn } from '@/lib/utils'
import ImageCropDialog from '@/components/modals/ImageCropDialog'
import MicTest from '@/components/voice/MicTest'
import OutputTest from '@/components/voice/OutputTest'
import VadSlider from '@/components/voice/VadSlider'
import { useTranslation } from 'react-i18next'
import i18n, { SUPPORTED_LANGUAGES } from '@/i18n'
import { useClientMode } from '@/hooks/useClientMode'
import ProfileCardBody, { userColor } from '@/components/layout/ProfileCardBody'
import { getApiBaseUrl } from '@/lib/connectionConfig'

type Section = 'account' | 'appearance' | 'voice' | 'language' | 'danger'

function numToHex(n: number | undefined | null, fallback: string): string {
  if (n == null) return fallback
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0')
}

function hexToNum(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

const DEFAULT_BANNER_COLOR = '#5865f2'
const DEFAULT_PANEL_COLOR = '#2b2d31'

/** Converts a KeyboardEvent.code like "KeyV" or "ShiftLeft" into a readable label. */
function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6)
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
  const { t } = useTranslation()

  const [section, setSection] = useState<Section>('account')
  const isMobile = useClientMode() === 'mobile'
  const [mobileShowNav, setMobileShowNav] = useState(true)

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [uploadingAvatar, setUploadingAvatar] = useState(false)
  const [cropDialogOpen, setCropDialogOpen] = useState(false)
  const [cropImageDataUrl, setCropImageDataUrl] = useState('')
  const [localAvatarUrl, setLocalAvatarUrl] = useState<string | null>(null)

  // My Account
  const [name, setName] = useState('')
  const [savingAccount, setSavingAccount] = useState(false)

  // Profile customization — null means "no custom colour" (matches natural panel defaults)
  const [bio, setBio] = useState('')
  const [bannerColor, setBannerColor] = useState<string | null>(null)
  const [panelColor, setPanelColor] = useState<string | null>(null)
  const [savingProfile, setSavingProfile] = useState(false)

  // Appearance
  const [fontScale, setFontScale] = useState(DEFAULT_FONT_SCALE)
  const [chatSpacing, setChatSpacing] = useState(DEFAULT_CHAT_SPACING)
  const [savingAppearance, setSavingAppearance] = useState(false)

  // Voice & Video
  const [audioInputDevice, setAudioInputDevice] = useState('')
  const [audioOutputDevice, setAudioOutputDevice] = useState('')
  const [inputLevel, setInputLevel] = useState(100)
  const [outputLevel, setOutputLevel] = useState(100)
  const [autoGainControl, setAutoGainControl] = useState(true)
  const [echoCancellation, setEchoCancellation] = useState(true)
  const [noiseSuppression, setNoiseSuppression] = useState(true)
  const [denoiserType, setDenoiserType] = useState<'default' | 'rnnoise' | 'speex'>('default')
  const [inputMode, setInputMode] = useState<'voice_activity' | 'push_to_talk'>('voice_activity')
  const [voiceActivityThreshold, setVoiceActivityThreshold] = useState(-60)
  const [pushToTalkKey, setPushToTalkKey] = useState('')
  const [isRecordingPTTKey, setIsRecordingPTTKey] = useState(false)
  const [savingVoice, setSavingVoice] = useState(false)
  const [voiceDirty, setVoiceDirty] = useState(false)
  const [audioInputDevices, setAudioInputDevices] = useState<MediaDeviceInfo[]>([])
  const [audioOutputDevices, setAudioOutputDevices] = useState<MediaDeviceInfo[]>([])
  const [videoInputDevice, setVideoInputDevice] = useState('')
  const [videoDevices, setVideoDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraPreviewStream, setCameraPreviewStream] = useState<MediaStream | null>(null)
  const cameraPreviewRef = useRef<HTMLVideoElement>(null)

  // VAD sensitivity live meter
  const [vadMicVolume, setVadMicVolume] = useState(0)     // 0–1 normalised RMS
  const vadMicStreamRef    = useRef<MediaStream | null>(null)
  const vadMicCtxRef       = useRef<AudioContext | null>(null)
  const vadMicRafRef       = useRef<number | null>(null)
  const vadDenoiserRef     = useRef<DenoiserNode | null>(null)

  // Language
  const [selectedLanguage, setSelectedLanguage] = useState(i18n.language ?? 'en')
  const [savingLanguage, setSavingLanguage] = useState(false)

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
      setBio(user?.bio ?? '')
      // 0 and undefined/null both mean "no custom colour" — use null so the
      // preview shows the same natural defaults as the real member panel
      setBannerColor(user?.banner_color ? numToHex(user.banner_color, DEFAULT_BANNER_COLOR) : null)
      setPanelColor(user?.panel_color ? numToHex(user.panel_color, DEFAULT_PANEL_COLOR) : null)
      setSection('account')
    }
  }, [open, user?.name, user?.bio, user?.banner_color, user?.panel_color])

  const { setFontScale: setAppearenceFontScale, setChatSpacing: setAppearanceChatSpacing } = useAppearanceStore()

  // Init appearance from loaded settings
  useEffect(() => {
    if (settingsData?.appearance) {
      const fontScale = settingsData.appearance.chat_font_scale || DEFAULT_FONT_SCALE
      const chatSpacing = settingsData.appearance.chat_spacing ?? DEFAULT_CHAT_SPACING
      setFontScale(fontScale)
      setChatSpacing(chatSpacing)
      setAppearenceFontScale(fontScale)
      setAppearanceChatSpacing(chatSpacing)
    }
  }, [settingsData, setAppearenceFontScale, setAppearanceChatSpacing])

  // Init language from loaded settings
  useEffect(() => {
    if (settingsData?.language) {
      setSelectedLanguage(settingsData.language)
    } else {
      setSelectedLanguage(i18n.language ?? 'en')
    }
  }, [settingsData])

  // Init voice from loaded settings
  useEffect(() => {
    if (settingsData?.devices) {
      const d = settingsData.devices
      setAudioInputDevice(d.audio_input_device ?? '')
      setAudioOutputDevice(d.audio_output_device ?? '')
      setInputLevel(d.audio_input_level || 100)
      setOutputLevel(d.audio_output_level || 100)
      setAutoGainControl(d.auto_gain_control ?? true)
      setEchoCancellation(d.echo_cancellation ?? true)
      setNoiseSuppression(d.noise_suppression ?? true)
    }
    if (settingsData?.devices) {
      const d = settingsData.devices
      if (d.video_device) setVideoInputDevice(d.video_device)
      const dt = d.denoiser_type
      if (dt === 'rnnoise' || dt === 'speex') setDenoiserType(dt)
      else setDenoiserType('default')
      // Fields not yet in ModelDevices schema — cast needed
      const dx = d as Record<string, unknown>
      if (dx.input_mode === 'push_to_talk') setInputMode('push_to_talk')
      else setInputMode('voice_activity')
      if (typeof dx.audio_input_threshold === 'number') setVoiceActivityThreshold(dx.audio_input_threshold || -60)
      if (typeof dx.push_to_talk_key === 'string') setPushToTalkKey(dx.push_to_talk_key)
    }
    setVoiceDirty(false)
  }, [settingsData])

  // Enumerate audio/video devices when switching to Voice section
  useEffect(() => {
    if (section !== 'voice') return
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setAudioInputDevices(devices.filter((d) => d.kind === 'audioinput'))
        setAudioOutputDevices(devices.filter((d) => d.kind === 'audiooutput'))
        setVideoDevices(devices.filter((d) => d.kind === 'videoinput'))
      })
      .catch(() => { })
  }, [section])

  // Stop camera preview when leaving voice section or closing modal
  useEffect(() => {
    if (!open || section !== 'voice') {
      setCameraPreviewStream((prev) => {
        if (prev) { prev.getTracks().forEach(t => t.stop()) }
        return null
      })
    }
  }, [open, section])

  // Attach camera preview stream to video element
  useEffect(() => {
    if (cameraPreviewRef.current && cameraPreviewStream) {
      cameraPreviewRef.current.srcObject = cameraPreviewStream
    }
  }, [cameraPreviewStream])

  // Live VAD sensitivity meter — runs a mic stream while the voice activity section is visible
  useEffect(() => {
    const shouldRun = open && section === 'voice' && inputMode === 'voice_activity'

    function stopMeter() {
      if (vadMicRafRef.current !== null) {
        cancelAnimationFrame(vadMicRafRef.current)
        vadMicRafRef.current = null
      }
      destroyDenoiserNode(vadDenoiserRef.current)
      vadDenoiserRef.current = null
      if (vadMicStreamRef.current) {
        for (const t of vadMicStreamRef.current.getTracks()) t.stop()
        vadMicStreamRef.current = null
      }
      if (vadMicCtxRef.current && vadMicCtxRef.current.state !== 'closed') {
        void vadMicCtxRef.current.close()
        vadMicCtxRef.current = null
      }
      setVadMicVolume(0)
    }

    if (!shouldRun) { stopMeter(); return }

    let cancelled = false
    const setup = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: audioInputDevice ? { exact: audioInputDevice } : undefined,
            autoGainControl,
            echoCancellation,
            noiseSuppression: effectiveNoiseSuppression(denoiserType, noiseSuppression),
          },
          video: false,
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        vadMicStreamRef.current = stream
        const ctx = new AudioContext()
        vadMicCtxRef.current = ctx
        const source = ctx.createMediaStreamSource(stream)

        // Apply denoiser so the meter shows the same level that the VAD engine sees during a call
        destroyDenoiserNode(vadDenoiserRef.current)
        vadDenoiserRef.current = await buildDenoiserNode(effectiveDenoiserType(denoiserType, noiseSuppression), ctx, source)
        const postDenoise: AudioNode = vadDenoiserRef.current ?? source

        const analyser = ctx.createAnalyser()
        analyser.fftSize = 2048
        postDenoise.connect(analyser)
        const floatData = new Float32Array(analyser.fftSize)
        const loop = () => {
          if (!vadMicCtxRef.current) return
          analyser.getFloatTimeDomainData(floatData)
          let sum = 0
          for (let i = 0; i < floatData.length; i++) sum += floatData[i] * floatData[i]
          const rms = Math.sqrt(sum / floatData.length)
          // Linear dBFS → 0–1 fill: same scale as the VAD engine and marker
          const db = Math.max(20 * Math.log10(Math.max(rms, 1e-8)), -100)
          setVadMicVolume(Math.max(0, (db + 100) / 100))
          vadMicRafRef.current = requestAnimationFrame(loop)
        }
        loop()
      } catch { /* permission denied or device unavailable — no meter */ }
    }
    void setup()

    return () => {
      cancelled = true
      stopMeter()
    }
  }, [open, section, inputMode, audioInputDevice, autoGainControl, echoCancellation, noiseSuppression, denoiserType])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, close])

  // Reset mobile nav panel on open
  useEffect(() => { if (open) setMobileShowNav(true) }, [open])

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
  const savedBannerColor = user?.banner_color ? numToHex(user.banner_color, DEFAULT_BANNER_COLOR) : null
  const savedPanelColor = user?.panel_color ? numToHex(user.panel_color, DEFAULT_PANEL_COLOR) : null
  const profileDirty =
    bio !== (user?.bio ?? '') ||
    bannerColor !== savedBannerColor ||
    panelColor !== savedPanelColor

  const NAV: { key: Section; label: string; danger?: boolean }[] = [
    { key: 'account', label: t('settings.myAccount') },
    { key: 'appearance', label: t('settings.appearance') },
    { key: 'voice', label: t('settings.voiceVideo') },
    { key: 'language', label: t('settings.language') },
    { key: 'danger', label: t('settings.dangerZone'), danger: true },
  ]

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
    // Optimistically show the cropped image immediately
    const optimisticUrl = URL.createObjectURL(blob)
    setLocalAvatarUrl(optimisticUrl)
    setUploadingAvatar(true)
    try {
      const baseUrl = getApiBaseUrl()
      const placeholder = await userApi.userMeAvatarPost({
        request: { content_type: 'image/jpeg', file_size: blob.size },
      })
      const avatarId = String(placeholder.data.id)
      const userId = String(placeholder.data.user_id)
      await uploadApi.uploadAvatarsUserIdAvatarIdPost({
        userId,
        avatarId,
        file: blob as unknown as number[],
      })
      const meRes = await axiosInstance.get<DtoUser>(`${baseUrl}/user/me`)
      setUser(meRes.data)
      toast.success(t('settings.avatarUpdated'))
    } catch {
      toast.error(t('settings.avatarFailed'))
    } finally {
      setUploadingAvatar(false)
      URL.revokeObjectURL(optimisticUrl)
      setLocalAvatarUrl(null)
    }
  }

  async function handleSaveAccount() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === user?.name) return
    setSavingAccount(true)
    try {
      await userApi.userMePatch({ request: { name: trimmed } })
      if (user) setUser({ ...user, name: trimmed })
      toast.success(t('settings.profileUpdated'))
    } catch {
      toast.error(t('settings.profileFailed'))
    } finally {
      setSavingAccount(false)
    }
  }

  async function handleSaveProfile() {
    setSavingProfile(true)
    try {
      const patch = {
        bio: bio.trim() || undefined,
        // 0 signals "clear custom colour" to the backend (Go zero value = not set)
        banner_color: bannerColor !== null ? hexToNum(bannerColor) : 0,
        panel_color: panelColor !== null ? hexToNum(panelColor) : 0,
      }
      await userApi.userMePatch({ request: patch })
      if (user) setUser({
        ...user,
        bio: bio.trim() || undefined,
        banner_color: bannerColor !== null ? hexToNum(bannerColor) : undefined,
        panel_color: panelColor !== null ? hexToNum(panelColor) : undefined,
      })
      toast.success(t('settings.profileUpdated'))
    } catch {
      toast.error(t('settings.profileFailed'))
    } finally {
      setSavingProfile(false)
    }
  }

  async function handleSaveAppearance() {
    setSavingAppearance(true)
    try {
      await patchSettings({ appearance: { chat_font_scale: fontScale, chat_spacing: chatSpacing } })
      setAppearenceFontScale(fontScale)
      setAppearanceChatSpacing(chatSpacing)
      toast.success(t('settings.appearanceSaved'))
    } catch {
      toast.error(t('settings.appearanceFailed'))
    } finally {
      setSavingAppearance(false)
    }
  }

  function handleLogout() {
    close()
    logout()
    navigate('/')
  }

  async function startCameraPreview() {
    try {
      const videoConstraint: MediaTrackConstraints | boolean = videoInputDevice
        ? { deviceId: { exact: videoInputDevice } }
        : true
      const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraint, audio: false })
      setCameraPreviewStream(stream)
    } catch {
      toast.error(t('settings.voiceFailed'))
    }
  }

  function stopCameraPreview() {
    setCameraPreviewStream((prev) => {
      if (prev) { prev.getTracks().forEach(t => t.stop()) }
      return null
    })
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
          input_mode: inputMode,
          audio_input_threshold: voiceActivityThreshold,
          push_to_talk_key: pushToTalkKey,
          video_device: videoInputDevice || undefined,
          denoiser_type: denoiserType,
        },
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
        videoInputDevice,
        denoiserType,
      })
      applyVoiceSettings()
      setVoiceDirty(false)
      toast.success(t('settings.voiceSaved'))
    } catch {
      toast.error(t('settings.voiceFailed'))
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
    setDenoiserType('default')
    setInputMode('voice_activity')
    setVoiceActivityThreshold(-60)
    setPushToTalkKey('')
    setVideoInputDevice('')
    setVoiceDirty(true)
  }

  async function handleSaveLanguage(code: string) {
    setSelectedLanguage(code)
    void i18n.changeLanguage(code)
    setSavingLanguage(true)
    try {
      await patchSettings({ language: code })
      toast.success(t('settings.languageSaved'))
    } catch {
      toast.error(t('settings.languageFailed'))
    } finally {
      setSavingLanguage(false)
    }
  }

  const selectClass =
    'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <>
      <div className="fixed inset-0 z-50 flex bg-background/80 backdrop-blur-sm">
        <div className={cn('flex w-full h-full overflow-hidden', isMobile && 'flex-col')}>

          {/* ── Mobile header ── */}
          {isMobile && (
            <div className="h-12 flex items-center px-3 border-b border-sidebar-border shrink-0 bg-sidebar">
              {!mobileShowNav && (
                <button
                  onClick={() => setMobileShowNav(true)}
                  className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors mr-1"
                >
                  <ChevronLeft className="w-5 h-5" />
                </button>
              )}
              <span className="font-semibold text-sm flex-1">
                {mobileShowNav ? t('settings.userSettings') : (NAV.find((n) => n.key === section)?.label ?? '')}
              </span>
              <button
                onClick={close}
                className="w-8 h-8 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* ── Left sidebar ── */}
          <div className={cn(
            'bg-sidebar',
            isMobile
              ? mobileShowNav ? 'flex flex-col flex-1 min-h-0 overflow-y-auto' : 'hidden'
              : 'flex flex-1 justify-end border-r border-sidebar-border',
          )}>
            <div className={cn('shrink-0', isMobile ? 'w-full py-4 px-3' : 'w-52 py-16 px-3')}>
              <p className="px-3 py-1 text-xs font-semibold uppercase text-muted-foreground tracking-wider mb-1">
                {t('settings.userSettings')}
              </p>
              <div className="space-y-0.5">
                {NAV.map((s, i) => (
                  <div key={s.key}>
                    {/* Separator before Danger Zone */}
                    {s.danger && i > 0 && (
                      <div className="my-2 h-px bg-border mx-3" />
                    )}
                    <button
                      onClick={() => { setSection(s.key); if (isMobile) setMobileShowNav(false) }}
                      className={cn(
                        'w-full text-left px-3 rounded text-sm transition-colors flex items-center justify-between',
                        isMobile ? 'py-3' : 'py-1.5',
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
                      {isMobile && <ChevronRight className="w-4 h-4 shrink-0" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Content ── */}
          <div className={cn(
            'flex flex-1 min-w-0',
            isMobile && (mobileShowNav ? 'hidden' : 'flex'),
          )}>
            <div className={cn('flex-1 max-w-2xl overflow-y-auto', isMobile ? 'py-4 px-4' : 'py-16 px-10')}>

              {/* My Account */}
              {section === 'account' && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold">{t('settings.myAccount')}</h2>

                  <div className="flex items-center gap-4 p-4 rounded-lg bg-accent/30">
                    {/* Clickable avatar with camera overlay */}
                    <div
                      className="relative shrink-0 group cursor-pointer"
                      onClick={() => !uploadingAvatar && avatarInputRef.current?.click()}
                      title={t('settings.changeAvatar')}
                    >
                      <Avatar className="w-16 h-16 text-2xl">
                        <AvatarImage src={localAvatarUrl ?? user?.avatar?.url} alt={user?.name ?? ''} className="object-cover" />
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
                    <Label htmlFor="settings-username">{t('settings.username')}</Label>
                    <div className="flex gap-2">
                      <Input
                        id="settings-username"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveAccount() }}
                        placeholder={t('settings.username')}
                        className="flex-1"
                      />
                      <Button onClick={() => void handleSaveAccount()} disabled={savingAccount || !nameChanged}>
                        {t('settings.save')}
                      </Button>
                    </div>
                  </div>

                  {user?.discriminator && (
                    <div className="space-y-2">
                      <Label>{t('settings.discriminator')}</Label>
                      <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md">
                        #{user.discriminator}
                      </p>
                    </div>
                  )}

                  <Separator />

                  <div className="space-y-2">
                    <Label>{t('settings.userId')}</Label>
                    <div className="flex gap-2 items-center">
                      <p className="text-sm text-muted-foreground bg-muted px-3 py-2 rounded-md flex-1 font-mono truncate">
                        {String(user?.id ?? '')}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          void navigator.clipboard.writeText(String(user?.id ?? ''))
                          toast.success(t('settings.copy'))
                        }}
                      >
                        {t('common.copy')}
                      </Button>
                    </div>
                  </div>

                  <Separator />

                  {/* Profile customization */}
                  <div className="space-y-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                      {t('settings.profileCustomization')}
                    </h3>

                    <div className="flex gap-6">
                      {/* Left: form fields */}
                      <div className="flex-1 space-y-4 min-w-0">
                        <div className="space-y-2">
                          <Label htmlFor="settings-bio">{t('settings.bio')}</Label>
                          <textarea
                            id="settings-bio"
                            value={bio}
                            onChange={(e) => setBio(e.target.value)}
                            placeholder={t('settings.bioPlaceholder')}
                            rows={3}
                            maxLength={190}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                          />
                        </div>

                        <div className="space-y-2">
                          <Label>{t('settings.bannerColor')}</Label>
                          <div className="flex items-center gap-3">
                            <input
                              type="color"
                              value={bannerColor ?? DEFAULT_BANNER_COLOR}
                              onChange={(e) => setBannerColor(e.target.value)}
                              className="w-10 h-9 rounded cursor-pointer border border-input bg-background p-0.5"
                            />
                            {bannerColor !== null ? (
                              <>
                                <span className="text-sm font-mono text-muted-foreground">{bannerColor.toUpperCase()}</span>
                                <button
                                  onClick={() => setBannerColor(null)}
                                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  {t('settings.resetToDefaults')}
                                </button>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground italic">Default</span>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <Label>{t('settings.panelColor')}</Label>
                          <div className="flex items-center gap-3">
                            <input
                              type="color"
                              value={panelColor ?? DEFAULT_PANEL_COLOR}
                              onChange={(e) => setPanelColor(e.target.value)}
                              className="w-10 h-9 rounded cursor-pointer border border-input bg-background p-0.5"
                            />
                            {panelColor !== null ? (
                              <>
                                <span className="text-sm font-mono text-muted-foreground">{panelColor.toUpperCase()}</span>
                                <button
                                  onClick={() => setPanelColor(null)}
                                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                                >
                                  {t('settings.resetToDefaults')}
                                </button>
                              </>
                            ) : (
                              <span className="text-xs text-muted-foreground italic">Default</span>
                            )}
                          </div>
                        </div>

                        <Button
                          onClick={() => void handleSaveProfile()}
                          disabled={savingProfile || !profileDirty}
                        >
                          {savingProfile ? t('settings.saving') : t('settings.save')}
                        </Button>
                      </div>

                      {/* Right: live profile panel preview */}
                      <div className="space-y-2 shrink-0">
                        <Label>{t('settings.profilePreview')}</Label>
                        <div
                          className={cn('w-52 rounded-lg overflow-hidden shadow-lg border border-border', !panelColor && 'bg-popover')}
                          style={panelColor ? { backgroundColor: panelColor } : undefined}
                        >
                          <ProfileCardBody
                            userId={String(user?.id ?? '')}
                            displayName={user?.name ?? initials}
                            discriminator={user?.discriminator}
                            avatarUrl={user?.avatar?.url}
                            bio={bio}
                            panelColor={panelColor}
                            bannerColor={bannerColor}
                            accent={userColor(String(user?.id ?? 'default'))}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Appearance */}
              {section === 'appearance' && (
                <div className="space-y-8">
                  <h2 className="text-xl font-bold">{t('settings.appearance')}</h2>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t('settings.chatFontScale')}</Label>
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
                      <Label>{t('settings.messageSpacing')}</Label>
                      <span className="text-sm font-medium tabular-nums">{chatSpacing}px</span>
                    </div>
                    <input
                      type="range" min={0} max={32} step={4}
                      value={chatSpacing}
                      onChange={(e) => setChatSpacing(Number(e.target.value))}
                      className="w-full accent-primary"
                    />
                    <div className="flex justify-between text-xs text-muted-foreground select-none">
                      <span>{t('settings.compact')}</span>
                      <span>{t('settings.comfortable')}</span>
                      <span>{t('settings.spacious')}</span>
                    </div>
                  </div>

                  <Separator />

                  {/* Live preview */}
                  <div className="space-y-2">
                    <Label>{t('settings.preview')}</Label>
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
                      {savingAppearance ? t('settings.saving') : t('settings.saveChanges')}
                    </Button>
                  </div>
                </div>
              )}

              {/* Voice & Video */}
              {section === 'voice' && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold">{t('settings.voiceVideo')}</h2>

                  {/* ── Input Device ── */}
                  <div className="space-y-2">
                    <Label htmlFor="audio-input">{t('settings.inputDevice')}</Label>
                    <select
                      id="audio-input"
                      value={audioInputDevice}
                      onChange={(e) => { setAudioInputDevice(e.target.value); markVoiceDirty() }}
                      className={selectClass}
                    >
                      <option value="">{t('settings.defaultDevice')}</option>
                      {audioInputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Microphone (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t('settings.inputVolume')}</Label>
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
                    <Label htmlFor="audio-output">{t('settings.outputDevice')}</Label>
                    <select
                      id="audio-output"
                      value={audioOutputDevice}
                      onChange={(e) => { setAudioOutputDevice(e.target.value); markVoiceDirty() }}
                      className={selectClass}
                    >
                      <option value="">{t('settings.defaultDevice')}</option>
                      {audioOutputDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Speaker (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>{t('settings.outputVolume')}</Label>
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

                  {/* ── Camera Device ── */}
                  <div className="space-y-2">
                    <Label htmlFor="video-input">{t('settings.videoDevice')}</Label>
                    <select
                      id="video-input"
                      value={videoInputDevice}
                      onChange={(e) => { setVideoInputDevice(e.target.value); markVoiceDirty(); stopCameraPreview() }}
                      className={selectClass}
                    >
                      <option value="">{t('settings.defaultDevice')}</option>
                      {videoDevices.map((d) => (
                        <option key={d.deviceId} value={d.deviceId}>
                          {d.label || `Camera (${d.deviceId.slice(0, 8)}…)`}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* ── Camera Preview ── */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>{t('settings.cameraPreview')}</Label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          if (cameraPreviewStream) {
                            stopCameraPreview()
                          } else {
                            void startCameraPreview()
                          }
                        }}
                      >
                        {cameraPreviewStream ? t('settings.stopPreview') : t('settings.testCamera')}
                      </Button>
                    </div>
                    {cameraPreviewStream ? (
                      <video
                        ref={cameraPreviewRef}
                        autoPlay
                        muted
                        playsInline
                        className="w-full aspect-video rounded-lg bg-black object-cover"
                      />
                    ) : (
                      <div className="w-full aspect-video rounded-lg bg-muted flex items-center justify-center">
                        <p className="text-xs text-muted-foreground">{t('voicePanel.cameraOff')}</p>
                      </div>
                    )}
                  </div>

                  <Separator />

                  {/* ── Mic Test ── */}
                  <MicTest
                    inputDeviceId={audioInputDevice}
                    inputLevel={inputLevel}
                    autoGainControl={autoGainControl}
                    echoCancellation={echoCancellation}
                    noiseSuppression={noiseSuppression}
                    denoiserType={denoiserType}
                    outputDeviceId={audioOutputDevice}
                    outputLevel={outputLevel}
                    inputMode={inputMode}
                    voiceActivityThreshold={voiceActivityThreshold}
                  />

                  <Separator />

                  {/* ── Input Mode ── */}
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                      {t('settings.inputMode')}
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
                        {t('settings.voiceActivity')}
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
                        {t('settings.pushToTalk')}
                      </button>
                    </div>

                    {inputMode === 'voice_activity' && (
                      <div className="space-y-2 pt-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-sm text-muted-foreground">{t('settings.sensitivityThreshold')}</Label>
                          <span className="text-sm font-medium tabular-nums">{voiceActivityThreshold} dBFS</span>
                        </div>

                        <VadSlider
                          value={voiceActivityThreshold}
                          onChange={(v) => { setVoiceActivityThreshold(v); markVoiceDirty() }}
                          vadVolume={vadMicVolume}
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground select-none">
                          <span>{t('settings.sensitive')}</span>
                          <span>{t('settings.aggressive')}</span>
                        </div>
                      </div>
                    )}

                    {inputMode === 'push_to_talk' && (
                      <div className="space-y-2 pt-1">
                        <Label className="text-sm text-muted-foreground">{t('settings.shortcut')}</Label>
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
                              ? t('settings.pressAnyKey')
                              : pushToTalkKey
                                ? formatKeyCode(pushToTalkKey)
                                : t('settings.clickToSetKey')}
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
                      {t('settings.audioProcessing')}
                    </p>
                    <div className="space-y-1">
                      {[
                        { label: t('settings.echoCancellation'), desc: t('settings.echoCancellationDesc'), value: echoCancellation, onToggle: () => { setEchoCancellation((v) => !v); markVoiceDirty() } },
                        { label: t('settings.autoGainControl'), desc: t('settings.autoGainControlDesc'), value: autoGainControl, onToggle: () => { setAutoGainControl((v) => !v); markVoiceDirty() } },
                      ].map(({ label, desc, value, onToggle }) => (
                        <div key={label} className="flex items-center justify-between py-2.5 gap-4">
                          <div className="min-w-0">
                            <p className="text-sm">{label}</p>
                            <p className="text-xs text-muted-foreground">{desc}</p>
                          </div>
                          <Toggle value={value} onToggle={onToggle} />
                        </div>
                      ))}

                      {/* Noise Suppression mode selector */}
                      <div className="py-2.5">
                        <p className="text-sm mb-1">{t('settings.noiseSuppression')}</p>
                        <p className="text-xs text-muted-foreground mb-2">{t('settings.noiseSuppressionDesc')}</p>
                        <div className="flex gap-2 flex-wrap">
                          {([
                            { value: 'default', label: t('settings.denoiserDefault') },
                            { value: 'rnnoise', label: t('settings.denoiserRnnoise') },
                            { value: 'speex',   label: t('settings.denoiserSpeex')   },
                          ] as const).map((opt) => (
                            <button
                              key={opt.value}
                              type="button"
                              onClick={() => { setDenoiserType(opt.value); markVoiceDirty() }}
                              className={cn(
                                'px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
                                denoiserType === opt.value
                                  ? 'bg-primary text-primary-foreground border-primary'
                                  : 'border-input bg-background hover:bg-accent hover:text-accent-foreground',
                              )}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                        {/* Global enable/disable toggle — always visible */}
                        <div className="flex items-center justify-between mt-3 py-1 gap-4">
                          <div className="min-w-0">
                            <p className="text-xs text-muted-foreground">{t('settings.noiseSuppressionEnabled')}</p>
                          </div>
                          <Toggle
                            value={noiseSuppression}
                            onToggle={() => { setNoiseSuppression((v) => !v); markVoiceDirty() }}
                          />
                        </div>
                      </div>
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
                      {t('settings.resetToDefaults')}
                    </Button>
                    <Button onClick={() => void handleSaveVoice()} disabled={savingVoice || !voiceDirty}>
                      {savingVoice ? t('settings.saving') : t('settings.saveChanges')}
                    </Button>
                  </div>
                </div>
              )}

              {/* Language */}
              {section === 'language' && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <Globe className="w-5 h-5" />
                    {t('settings.language')}
                  </h2>

                  <div className="space-y-3">
                    <div>
                      <Label>{t('settings.selectLanguage')}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">{t('settings.selectLanguageDesc')}</p>
                    </div>

                    <div className="space-y-2">
                      {SUPPORTED_LANGUAGES.map((lang) => (
                        <button
                          key={lang.code}
                          type="button"
                          onClick={() => { if (!savingLanguage) void handleSaveLanguage(lang.code) }}
                          className={cn(
                            'w-full flex items-center gap-3 px-4 py-3 rounded-lg border text-sm font-medium transition-colors',
                            selectedLanguage === lang.code
                              ? 'border-primary bg-primary/10 text-foreground'
                              : 'border-border bg-background text-muted-foreground hover:text-foreground hover:border-muted-foreground hover:bg-accent/50',
                          )}
                        >
                          <Globe className="w-4 h-4 shrink-0" />
                          <span className="flex-1 text-left">{lang.nativeName}</span>
                          {selectedLanguage === lang.code && (
                            <span className="text-xs text-primary font-normal">✓</span>
                          )}
                        </button>
                      ))}
                    </div>

                    {savingLanguage && (
                      <p className="text-xs text-muted-foreground">{t('settings.saving')}</p>
                    )}
                  </div>
                </div>
              )}

              {/* Danger Zone */}
              {section === 'danger' && (
                <div className="space-y-6">
                  <h2 className="text-xl font-bold flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-destructive" />
                    {t('settings.dangerZone')}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.dangerDesc')}
                  </p>

                  {/* Log Out */}
                  <div className="rounded-lg border border-border p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm">{t('settings.logOut')}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('settings.logOutDesc')}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0 gap-2"
                      onClick={handleLogout}
                    >
                      <LogOut className="w-4 h-4" />
                      {t('settings.logOut')}
                    </Button>
                  </div>

                  {/* Delete Account */}
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-center justify-between gap-4">
                    <div>
                      <p className="font-medium text-sm text-destructive">{t('settings.deleteAccount')}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {t('settings.deleteAccountDesc')}
                      </p>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="shrink-0 gap-2"
                      disabled
                      title={t('settings.deleteAccount')}
                    >
                      <Trash2 className="w-4 h-4" />
                      {t('settings.delete')}
                    </Button>
                  </div>
                </div>
              )}

            </div>

            {/* Close button — desktop only */}
            {!isMobile && (
              <div className="pt-16 pr-6 shrink-0">
                <button
                  onClick={close}
                  className="w-9 h-9 rounded-full border border-border flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
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
