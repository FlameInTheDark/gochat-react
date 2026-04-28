import { describe, expect, it } from 'vitest'
import type { ModelDevices } from '@/client'
import { devicesFromVoiceSettings, voiceSettingsFromDevices } from '@/lib/voiceSettings'
import type { VoiceSettings } from '@/stores/voiceStore'

describe('voiceSettings', () => {
  it('restores all persisted media settings without replacing zero values', () => {
    const restored = voiceSettingsFromDevices({
      audio_input_device: 'mic-1',
      audio_output_device: 'speaker-1',
      audio_input_level: 0,
      audio_output_level: 0,
      auto_gain_control: false,
      echo_cancellation: false,
      noise_suppression: false,
      audio_input_threshold: -42,
      video_device: 'camera-1',
      denoiser_type: 'rnnoise',
      input_mode: 'push_to_talk',
      push_to_talk_key: 'KeyV',
    } as ModelDevices)

    expect(restored).toEqual({
      audioInputDevice: 'mic-1',
      audioOutputDevice: 'speaker-1',
      audioInputLevel: 0,
      audioOutputLevel: 0,
      autoGainControl: false,
      echoCancellation: false,
      noiseSuppression: false,
      inputMode: 'push_to_talk',
      voiceActivityThreshold: -42,
      pushToTalkKey: 'KeyV',
      videoInputDevice: 'camera-1',
      denoiserType: 'rnnoise',
    })
  })

  it('serializes voice settings into the backend devices shape', () => {
    const settings: VoiceSettings = {
      audioInputDevice: 'mic-1',
      audioOutputDevice: 'speaker-1',
      audioInputLevel: 80,
      audioOutputLevel: 90,
      autoGainControl: true,
      echoCancellation: false,
      noiseSuppression: true,
      inputMode: 'push_to_talk',
      voiceActivityThreshold: -55,
      pushToTalkKey: 'KeyV',
      videoInputDevice: 'camera-1',
      denoiserType: 'speex',
    }

    expect(devicesFromVoiceSettings(settings)).toEqual({
      audio_input_device: 'mic-1',
      audio_output_device: 'speaker-1',
      audio_input_level: 80,
      audio_output_level: 90,
      auto_gain_control: true,
      echo_cancellation: false,
      noise_suppression: true,
      input_mode: 'push_to_talk',
      audio_input_threshold: -55,
      push_to_talk_key: 'KeyV',
      video_device: 'camera-1',
      denoiser_type: 'speex',
    })
  })
})
