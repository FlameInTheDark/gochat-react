import { Codec, MediaType, type SigningKeyPair } from '@/lib/dave'

export type DaveMode = 'passthrough' | 'pending_upgrade' | 'pending_downgrade'
export type DaveSessionTarget = 'active' | 'pending' | 'all'

type RTCRtpScriptTransformCtor = new (
  worker: Worker,
  options?: unknown,
  transfer?: Transferable[],
) => unknown

type SenderWithEncodedStreams = RTCRtpSender & {
  createEncodedStreams?: unknown
  transform?: unknown
}

type ReceiverWithEncodedStreams = RTCRtpReceiver & {
  createEncodedStreams?: unknown
  transform?: unknown
}

interface TransformOptions {
  transformId: string
  direction: 'sender' | 'receiver'
  mediaType: MediaType
  userId?: string
}

type WorkerCommand =
  | {
    type: 'set-state'
    enabled: boolean
    required: boolean
    mode: DaveMode
    protocolVersion: 0 | 1
    negotiatedVideoCodec: Codec
    label: string
  }
  | {
    type: 'create-session'
    target: Exclude<DaveSessionTarget, 'all'>
    protocolVersion: number
    userId: string
    channelId: string
    keyPair: SigningKeyPair
  }
  | {
    type: 'dispose-session'
    target: DaveSessionTarget
  }
  | {
    type: 'set-passthrough'
    target: Exclude<DaveSessionTarget, 'all'>
    enabled: boolean
    transitionExpiry?: number
  }
  | {
    type: 'set-external-sender'
    target: Exclude<DaveSessionTarget, 'all'>
    payload: Uint8Array
  }
  | {
    type: 'process-proposals'
    target: Exclude<DaveSessionTarget, 'all'>
    operationType: number
    payload: Uint8Array
    recognizedUserIds?: string[]
  }
  | {
    type: 'process-commit'
    target: Exclude<DaveSessionTarget, 'all'>
    payload: Uint8Array
  }
  | {
    type: 'process-welcome'
    target: Exclude<DaveSessionTarget, 'all'>
    payload: Uint8Array
  }
  | {
    type: 'promote-pending-session'
  }
  | {
    type: 'update-transform'
    transformId: string
    userId?: string
  }

function getScriptTransformCtor(): RTCRtpScriptTransformCtor | null {
  const ctor = (window as typeof window & { RTCRtpScriptTransform?: RTCRtpScriptTransformCtor }).RTCRtpScriptTransform
  return typeof ctor === 'function' ? ctor : null
}

export function supportsDirectEncodedTransforms(): boolean {
  try {
    const senderProto = RTCRtpSender.prototype as SenderWithEncodedStreams
    const receiverProto = RTCRtpReceiver.prototype as ReceiverWithEncodedStreams
    return typeof senderProto.createEncodedStreams === 'function' &&
      typeof receiverProto.createEncodedStreams === 'function'
  } catch {
    return false
  }
}

export function supportsScriptEncodedTransforms(): boolean {
  try {
    if (!getScriptTransformCtor()) {
      return false
    }
    const senderProto = RTCRtpSender.prototype as SenderWithEncodedStreams
    const receiverProto = RTCRtpReceiver.prototype as ReceiverWithEncodedStreams
    return 'transform' in senderProto && 'transform' in receiverProto
  } catch {
    return false
  }
}

export function supportsAnyEncodedTransforms(): boolean {
  return supportsDirectEncodedTransforms() || supportsScriptEncodedTransforms()
}

let nextTransformId = 1

export class DaveScriptTransformRuntime {
  readonly #label: string
  readonly #worker: Worker
  readonly #ctor: RTCRtpScriptTransformCtor
  readonly #senderIds = new WeakMap<RTCRtpSender, string>()
  readonly #receiverIds = new WeakMap<RTCRtpReceiver, string>()

  constructor(label: string) {
    const ctor = getScriptTransformCtor()
    if (!ctor) {
      throw new Error('RTCRtpScriptTransform is unavailable')
    }

    this.#label = label
    this.#ctor = ctor
    this.#worker = new Worker(
      new URL('../workers/daveTransformWorker.ts', import.meta.url),
      { type: 'module' },
    )
  }

  #post(command: WorkerCommand) {
    this.#worker.postMessage(command)
  }

  setState(params: {
    enabled: boolean
    required: boolean
    mode: DaveMode
    protocolVersion: 0 | 1
    negotiatedVideoCodec: Codec
  }) {
    this.#post({
      type: 'set-state',
      label: this.#label,
      ...params,
    })
  }

  createSession(
    target: Exclude<DaveSessionTarget, 'all'>,
    protocolVersion: number,
    userId: string,
    channelId: string,
    keyPair: SigningKeyPair,
  ) {
    this.#post({
      type: 'create-session',
      target,
      protocolVersion,
      userId,
      channelId,
      keyPair: {
        private: new Uint8Array(keyPair.private),
        public: new Uint8Array(keyPair.public),
      },
    })
  }

  disposeSessions(target: DaveSessionTarget = 'all') {
    this.#post({ type: 'dispose-session', target })
  }

  setPassthrough(
    target: Exclude<DaveSessionTarget, 'all'>,
    enabled: boolean,
    transitionExpiry?: number,
  ) {
    this.#post({ type: 'set-passthrough', target, enabled, transitionExpiry })
  }

  setExternalSender(target: Exclude<DaveSessionTarget, 'all'>, payload: Uint8Array) {
    this.#post({ type: 'set-external-sender', target, payload: new Uint8Array(payload) })
  }

  processProposals(
    target: Exclude<DaveSessionTarget, 'all'>,
    operationType: number,
    payload: Uint8Array,
    recognizedUserIds?: string[],
  ) {
    this.#post({
      type: 'process-proposals',
      target,
      operationType,
      payload: new Uint8Array(payload),
      recognizedUserIds: recognizedUserIds ? [...recognizedUserIds] : undefined,
    })
  }

  processCommit(target: Exclude<DaveSessionTarget, 'all'>, payload: Uint8Array) {
    this.#post({ type: 'process-commit', target, payload: new Uint8Array(payload) })
  }

  processWelcome(target: Exclude<DaveSessionTarget, 'all'>, payload: Uint8Array) {
    this.#post({ type: 'process-welcome', target, payload: new Uint8Array(payload) })
  }

  promotePendingSession() {
    this.#post({ type: 'promote-pending-session' })
  }

  attachSender(sender: RTCRtpSender, mediaType: MediaType): boolean {
    const existingId = this.#senderIds.get(sender)
    if (existingId) {
      return true
    }

    const scriptSender = sender as SenderWithEncodedStreams
    const transformId = `tx-${nextTransformId++}`
    try {
      const transform = new this.#ctor(this.#worker, {
        transformId,
        direction: 'sender',
        mediaType,
      } satisfies TransformOptions) as RTCRtpScriptTransform | null
      ;(scriptSender as RTCRtpSender & { transform: RTCRtpScriptTransform | null }).transform = transform
      this.#senderIds.set(sender, transformId)
      return true
    } catch {
      return false
    }
  }

  attachReceiver(receiver: RTCRtpReceiver, mediaType: MediaType, userId: string): boolean {
    const existingId = this.#receiverIds.get(receiver)
    if (existingId) {
      this.updateReceiverUserId(receiver, userId)
      return true
    }

    const scriptReceiver = receiver as ReceiverWithEncodedStreams
    const transformId = `rx-${nextTransformId++}`
    try {
      const transform = new this.#ctor(this.#worker, {
        transformId,
        direction: 'receiver',
        mediaType,
        userId,
      } satisfies TransformOptions) as RTCRtpScriptTransform | null
      ;(scriptReceiver as RTCRtpReceiver & { transform: RTCRtpScriptTransform | null }).transform = transform
      this.#receiverIds.set(receiver, transformId)
      return true
    } catch {
      return false
    }
  }

  updateReceiverUserId(receiver: RTCRtpReceiver, userId: string) {
    const transformId = this.#receiverIds.get(receiver)
    if (!transformId) return
    this.#post({ type: 'update-transform', transformId, userId })
  }

  dispose() {
    this.#worker.terminate()
  }
}
