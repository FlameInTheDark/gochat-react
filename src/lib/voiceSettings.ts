import type { ModelDevices } from '@/client'
import type { VoiceSettings } from '@/stores/voiceStore'

type PersistedInputMode = VoiceSettings['inputMode']
type PersistedDenoiserType = VoiceSettings['denoiserType']

export type PersistedVoiceDevices = ModelDevices & {
  input_mode?: PersistedInputMode
  push_to_talk_key?: string
}

function normalizeDenoiserType(value: unknown): PersistedDenoiserType {
  return value === 'rnnoise' || value === 'speex' ? value : 'default'
}

function normalizeInputMode(value: unknown): PersistedInputMode {
  return value === 'push_to_talk' ? 'push_to_talk' : 'voice_activity'
}

export function voiceSettingsFromDevices(devices: ModelDevices | null | undefined): Partial<VoiceSettings> | null {
  if (!devices) return null

  const persisted = devices as PersistedVoiceDevices
  return {
    audioInputDevice: persisted.audio_input_device ?? '',
    audioOutputDevice: persisted.audio_output_device ?? '',
    audioInputLevel: persisted.audio_input_level ?? 100,
    audioOutputLevel: persisted.audio_output_level ?? 100,
    autoGainControl: persisted.auto_gain_control ?? true,
    echoCancellation: persisted.echo_cancellation ?? true,
    noiseSuppression: persisted.noise_suppression ?? true,
    inputMode: normalizeInputMode(persisted.input_mode),
    voiceActivityThreshold: persisted.audio_input_threshold ?? -60,
    pushToTalkKey: persisted.push_to_talk_key ?? '',
    videoInputDevice: persisted.video_device ?? '',
    denoiserType: normalizeDenoiserType(persisted.denoiser_type),
  }
}

export function devicesFromVoiceSettings(settings: VoiceSettings): PersistedVoiceDevices {
  return {
    audio_input_device: settings.audioInputDevice || undefined,
    audio_output_device: settings.audioOutputDevice || undefined,
    audio_input_level: settings.audioInputLevel,
    audio_output_level: settings.audioOutputLevel,
    auto_gain_control: settings.autoGainControl,
    echo_cancellation: settings.echoCancellation,
    noise_suppression: settings.noiseSuppression,
    input_mode: settings.inputMode,
    audio_input_threshold: settings.voiceActivityThreshold,
    push_to_talk_key: settings.pushToTalkKey || undefined,
    video_device: settings.videoInputDevice || undefined,
    denoiser_type: settings.denoiserType,
  }
}
