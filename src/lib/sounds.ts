/**
 * Notification sound utility using the Web Audio API.
 * Generates a short pleasant "ping" without requiring an external audio asset.
 */

let audioCtx: AudioContext | null = null

export function playMentionSound(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }

    // Resume context if suspended (browser autoplay policy)
    if (audioCtx.state === 'suspended') {
      void audioCtx.resume()
    }

    const oscillator = audioCtx.createOscillator()
    const gain = audioCtx.createGain()

    oscillator.connect(gain)
    gain.connect(audioCtx.destination)

    // 880 Hz "A5" — a bright, pleasant notification tone
    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(880, audioCtx.currentTime)
    // Slight frequency drop for a soft ping feel
    oscillator.frequency.exponentialRampToValueAtTime(660, audioCtx.currentTime + 0.25)

    gain.gain.setValueAtTime(0, audioCtx.currentTime)
    gain.gain.linearRampToValueAtTime(0.25, audioCtx.currentTime + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.35)

    oscillator.start(audioCtx.currentTime)
    oscillator.stop(audioCtx.currentTime + 0.35)
  } catch {
    // Non-critical — ignore audio errors (e.g. unsupported browser)
  }
}
