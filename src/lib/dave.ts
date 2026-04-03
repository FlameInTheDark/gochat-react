import {
  loadGoDave,
  type GoDaveSession,
  type SessionState,
  type SigningKeyPair,
} from '@flameinthedark/go-dave'
import wasmExecURL from '@flameinthedark/go-dave/wasm_exec.js?url'
import wasmURL from '@flameinthedark/go-dave/go-dave.wasm?url'

const GoDave = await loadGoDave({
  url: wasmURL,
  wasmExecUrl: wasmExecURL,
})

function isExitedRuntimeError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Go program has already exited')
}

const EMPTY_SESSION_STATE: SessionState = {
  protocolVersion: 0,
  userId: '',
  channelId: '',
  epoch: null,
  ownLeafIndex: null,
  ciphersuite: 0,
  status: 0,
  ready: false,
  voicePrivacyCode: '',
  userIds: [],
}

export type Codec = number
export type MediaType = number
export type ProposalsOperationType = number
export type SessionStatus = number

export interface CommitWelcome {
  commit: Uint8Array | null
  welcome: Uint8Array | null
}

export const Codec = Object.freeze({ ...GoDave.Codec })
export const MediaType = Object.freeze({ ...GoDave.MediaType })
export const ProposalsOperationType = Object.freeze({ ...GoDave.ProposalsOperationType })
export const SessionStatus = Object.freeze({ ...GoDave.SessionStatus })

export class DAVESession {
  #session: GoDaveSession
  #disposed = false

  #safeState(): SessionState {
    if (this.#disposed) {
      return EMPTY_SESSION_STATE
    }
    try {
      return this.#session.getState()
    } catch (error) {
      if (isExitedRuntimeError(error)) {
        this.#disposed = true
        return EMPTY_SESSION_STATE
      }
      throw error
    }
  }

  #safeVoid(fn: () => void): void {
    if (this.#disposed) {
      return
    }
    try {
      fn()
    } catch (error) {
      if (isExitedRuntimeError(error)) {
        this.#disposed = true
        return
      }
      throw error
    }
  }

  constructor(protocolVersion: number, userId: string, channelId: string, keyPair?: SigningKeyPair | null) {
    this.#session = GoDave.createSession(protocolVersion, userId, channelId, keyPair)
  }

  get ready(): boolean {
    return this.#safeState().ready
  }

  get status(): SessionStatus {
    return this.#safeState().status
  }

  get voicePrivacyCode(): string {
    return this.#safeState().voicePrivacyCode
  }

  dispose(): void {
    this.#safeVoid(() => this.#session.dispose())
    this.#disposed = true
  }

  reset(): void {
    this.#safeVoid(() => this.#session.reset())
  }

  setPassthroughMode(enabled: boolean, transitionExpiry?: number): void {
    this.#safeVoid(() => this.#session.setPassthroughMode(enabled, transitionExpiry))
  }

  setExternalSender(data: Uint8Array | ArrayBuffer): void {
    this.#session.setExternalSender(data)
  }

  getSerializedKeyPackage(): Uint8Array {
    return this.#session.getSerializedKeyPackage()
  }

  processProposals(
    operationType: ProposalsOperationType,
    payload: Uint8Array | ArrayBuffer,
    recognizedUserIds?: string[] | null,
  ): CommitWelcome {
    return this.#session.processProposals(operationType, payload, recognizedUserIds)
  }

  processCommit(commit: Uint8Array | ArrayBuffer): void {
    this.#session.processCommit(commit)
  }

  processWelcome(welcome: Uint8Array | ArrayBuffer): void {
    this.#session.processWelcome(welcome)
  }

  encrypt(mediaType: MediaType, codec: Codec, frame: Uint8Array | ArrayBuffer): Uint8Array | null {
    return this.#session.encrypt(mediaType, codec, frame)
  }

  encryptOpus(frame: Uint8Array | ArrayBuffer): Uint8Array | null {
    return this.#session.encryptOpus(frame)
  }

  decrypt(userId: string, mediaType: MediaType, frame: Uint8Array | ArrayBuffer): Uint8Array | null {
    return this.#session.decrypt(userId, mediaType, frame)
  }

  canPassthrough(userId: string): boolean {
    return this.#session.canPassthrough(userId)
  }
}
