import loadGoDave, {
  type GoDaveSession,
  type SigningKeyPair,
} from '@flameinthedark/go-dave'
import wasmExecURL from '@flameinthedark/go-dave/wasm_exec.js?url'
import wasmURL from '@flameinthedark/go-dave/go-dave.wasm?url'

type DaveMode = 'passthrough' | 'pending_upgrade' | 'pending_downgrade'
type DaveSessionTarget = 'active' | 'pending'
type TransformDirection = 'sender' | 'receiver'

type EncodedFrame = {
  data: ArrayBuffer
}

interface TransformOptions {
  transformId: string
  direction: TransformDirection
  mediaType: number
  userId?: string
}

interface TransformState extends TransformOptions {
  attached: boolean
}

type WorkerCommand =
  | {
    type: 'set-state'
    enabled: boolean
    required: boolean
    mode: DaveMode
    protocolVersion: 0 | 1
    negotiatedVideoCodec: number
    label: string
  }
  | {
    type: 'create-session'
    target: DaveSessionTarget
    protocolVersion: number
    userId: string
    channelId: string
    keyPair: SigningKeyPair
  }
  | {
    type: 'dispose-session'
    target: DaveSessionTarget | 'all'
  }
  | {
    type: 'set-passthrough'
    target: DaveSessionTarget
    enabled: boolean
    transitionExpiry?: number
  }
  | {
    type: 'set-external-sender'
    target: DaveSessionTarget
    payload: Uint8Array
  }
  | {
    type: 'process-proposals'
    target: DaveSessionTarget
    operationType: number
    payload: Uint8Array
    recognizedUserIds?: string[]
  }
  | {
    type: 'process-commit'
    target: DaveSessionTarget
    payload: Uint8Array
  }
  | {
    type: 'process-welcome'
    target: DaveSessionTarget
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

let activeSession: GoDaveSession | null = null
let pendingSession: GoDaveSession | null = null
let daveEnabled = false
let daveRequired = false
let daveMode: DaveMode = 'passthrough'
let daveProtocolVersion: 0 | 1 = 0
let negotiatedVideoCodec = 0
let runtimeLabel = '[DAVE]'
const transforms = new Map<string, TransformState>()
let audioMediaType: number | null = null
let videoMediaType: number | null = null
let opusCodec = 0
let unknownCodec = 0
const goDavePromise = loadGoDave({
  url: wasmURL,
  wasmExecUrl: wasmExecURL,
}).then((module) => {
  audioMediaType = module.MediaType.AUDIO
  videoMediaType = module.MediaType.VIDEO
  opusCodec = module.Codec.OPUS
  unknownCodec = module.Codec.UNKNOWN
  return module
})

function logWarn(message: string, ...args: unknown[]) {
  console.warn(runtimeLabel, message, ...args)
}

function currentSession(target: DaveSessionTarget): GoDaveSession | null {
  return target === 'pending' ? pendingSession : activeSession
}

function currentMediaSession(): GoDaveSession | null {
  return activeSession
}

function shouldExpectDaveMediaPath(): boolean {
  return daveEnabled && (daveRequired || daveProtocolVersion > 0 || daveMode !== 'passthrough')
}

function looksLikeDaveEncryptedFrame(data: ArrayBufferLike | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  return bytes.length >= 2 && bytes[bytes.length - 2] === 0xfa && bytes[bytes.length - 1] === 0xfa
}

function sessionReady(session: GoDaveSession | null): boolean {
  return Boolean(session?.getState().ready)
}

function resolveSenderCodec(mediaType: number): number {
  if (audioMediaType !== null && mediaType === audioMediaType) {
    return opusCodec
  }
  return negotiatedVideoCodec
}

function copyFrameData(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function attachTransform(transformer: { readable: ReadableStream; writable: WritableStream; options: TransformOptions }) {
  const options = transformer.options
  transforms.set(options.transformId, { ...options, attached: true })

  transformer.readable
    .pipeThrough(
      new TransformStream({
        transform(frame: EncodedFrame, controller) {
          const state = transforms.get(options.transformId)
          if (!state) {
            controller.enqueue(frame)
            return
          }

          const active = currentMediaSession()
          const rawFrame = new Uint8Array(frame.data)
          const encryptedHint = looksLikeDaveEncryptedFrame(rawFrame)

          if (state.direction === 'sender') {
            if (!shouldExpectDaveMediaPath()) {
              controller.enqueue(frame)
              return
            }
            if (!active || !sessionReady(active)) {
              return
            }

            try {
              const codec = resolveSenderCodec(state.mediaType)
              if (videoMediaType !== null && state.mediaType === videoMediaType && codec === unknownCodec) {
                controller.enqueue(frame)
                return
              }
              const encrypted = active.encrypt(state.mediaType, codec, rawFrame)
              if (!encrypted) {
                return
              }
              frame.data = copyFrameData(new Uint8Array(encrypted))
              controller.enqueue(frame)
            } catch (error) {
              logWarn('sender transform failed', error)
            }
            return
          }

          const userId = state.userId ?? ''
          const shouldUseDave = Boolean(userId) && (shouldExpectDaveMediaPath() || encryptedHint)
          if (!shouldUseDave) {
            controller.enqueue(frame)
            return
          }
          if (!active || !sessionReady(active)) {
            return
          }

          try {
            const decrypted = active.decrypt(userId, state.mediaType, rawFrame)
            if (!decrypted) {
              if (!encryptedHint && active.canPassthrough(userId)) {
                controller.enqueue(frame)
              }
              return
            }
            frame.data = copyFrameData(new Uint8Array(decrypted))
            controller.enqueue(frame)
          } catch (error) {
            if (!encryptedHint && active.canPassthrough(userId)) {
              controller.enqueue(frame)
              return
            }
            logWarn('receiver transform failed', error)
          }
        },
      }),
    )
    .pipeTo(transformer.writable)
    .catch(() => undefined)
}

function disposeSession(target: DaveSessionTarget | 'all') {
  if (target === 'all' || target === 'pending') {
    pendingSession?.dispose()
    pendingSession = null
  }
  if (target === 'all' || target === 'active') {
    activeSession?.dispose()
    activeSession = null
  }
}

async function handleCommand(command: WorkerCommand) {
  switch (command.type) {
    case 'set-state':
      daveEnabled = command.enabled
      daveRequired = command.required
      daveMode = command.mode
      daveProtocolVersion = command.protocolVersion
      negotiatedVideoCodec = command.negotiatedVideoCodec
      runtimeLabel = command.label
      return

    case 'create-session': {
      const module = await goDavePromise
      const session = module.createSession(
        command.protocolVersion,
        command.userId,
        command.channelId,
        {
          private: new Uint8Array(command.keyPair.private),
          public: new Uint8Array(command.keyPair.public),
        },
      )
      session.setPassthroughMode(true)
      if (command.target === 'pending') {
        pendingSession?.dispose()
        pendingSession = session
      } else {
        activeSession?.dispose()
        activeSession = session
      }
      return
    }

    case 'dispose-session':
      disposeSession(command.target)
      return

    case 'set-passthrough':
      currentSession(command.target)?.setPassthroughMode(command.enabled, command.transitionExpiry)
      return

    case 'set-external-sender':
      currentSession(command.target)?.setExternalSender(command.payload)
      return

    case 'process-proposals':
      currentSession(command.target)?.processProposals(
        command.operationType,
        command.payload,
        command.recognizedUserIds,
      )
      return

    case 'process-commit':
      currentSession(command.target)?.processCommit(command.payload)
      return

    case 'process-welcome':
      currentSession(command.target)?.processWelcome(command.payload)
      return

    case 'promote-pending-session':
      if (pendingSession) {
        activeSession?.dispose()
        activeSession = pendingSession
        pendingSession = null
      }
      return

    case 'update-transform': {
      const current = transforms.get(command.transformId)
      if (!current) return
      transforms.set(command.transformId, {
        ...current,
        userId: command.userId ?? current.userId,
      })
      return
    }
  }
}

const scope = self as DedicatedWorkerGlobalScope & {
  onrtctransform?: ((event: Event & { transformer: { readable: ReadableStream; writable: WritableStream; options: TransformOptions } }) => void) | null
}

let commandQueue = Promise.resolve()

scope.onmessage = (event: MessageEvent<WorkerCommand>) => {
  commandQueue = commandQueue
    .then(() => handleCommand(event.data))
    .catch((error) => {
      logWarn('worker command failed', error)
    })
}

scope.onrtctransform = (event) => {
  attachTransform(event.transformer)
}
