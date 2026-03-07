/// <reference lib="webworker" />
//
// Heartbeat Web Worker
// --------------------
// Runs heartbeat timing in a dedicated thread so it is NOT subject to the
// ≥1 second throttle that browsers apply to setInterval/setTimeout on the
// main thread of hidden/background tabs.
//
// Protocol (postMessage):
//   Main → Worker  { type: 'start', intervalMs: number }  — begin (re)scheduling
//   Main → Worker  { type: 'stop' }                       — pause without destroying
//   Main → Worker  { type: 'dispose' }                    — stop + self.close()
//   Worker → Main  'beat'                                  — time to send a heartbeat

type WorkerMsg = { type: 'start'; intervalMs: number } | { type: 'stop' | 'dispose' }

let timerId: ReturnType<typeof setTimeout> | null = null

function scheduleBeat(intervalMs: number) {
  timerId = setTimeout(() => {
    postMessage('beat')
    scheduleBeat(intervalMs)
  }, intervalMs)
}

self.onmessage = (e: MessageEvent<WorkerMsg>) => {
  switch (e.data.type) {
    case 'start':
      if (timerId !== null) clearTimeout(timerId)
      scheduleBeat(e.data.intervalMs)
      break
    case 'stop':
      if (timerId !== null) { clearTimeout(timerId); timerId = null }
      break
    case 'dispose':
      if (timerId !== null) { clearTimeout(timerId); timerId = null }
      self.close()
      break
  }
}
