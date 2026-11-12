import type { AskHandlers } from './anthropic'
import type { Blade, Panel } from '../store'
import { BRIDGE_WS_URL } from '../config'

/**
 * Client for the local bridge (see bridge/server.mjs).
 *
 * Same `ask()` shape as the browser-direct path, so App.tsx doesn't care which
 * brain is behind it. The difference is what's reachable: this one runs on your
 * machine, so every MCP server in your Claude Code config is in play.
 *
 * The socket is the session. The bridge holds one Claude Agent SDK query per
 * connection and the whole conversation lives inside it, so a dropped socket
 * silently wipes JARVIS's memory of the exchange while the transcript on screen
 * still shows it. That is why the reconnect below is loud rather than
 * invisible: `watchConnection` exists so the HUD can say so.
 */

/** Anything the bridge sends. Deliberately loose — a frame from a future
 *  bridge build should be ignored, not crash the turn. */
type Frame = {
  type?: string
  delta?: string
  name?: string
  text?: string
  message?: string
  panel?: Panel
  blade?: Blade
  op?: string
  args?: unknown
  id?: string
  ask?: string
  reason?: string
  mode?: string
  seconds?: number
  when?: string
  servers?: Array<string | { name?: string }>
  ok?: boolean
  data?: unknown
  error?: string
}

/** Every question gets an id so its answer can be told from anyone else's. */
let askSeq = 0

let socket: WebSocket | null = null
let connecting: Promise<WebSocket> | null = null

/** Server names reported by the bridge, for the HUD readout. */
let servers: string[] = []
export const bridgeServers = () => servers

/** The list arrives twice — once from config, once with live status — so the
 *  HUD subscribes rather than reading it a single time at boot. */
let onServers: ((s: string[]) => void) | null = null
export function watchServers(fn: (s: string[]) => void) {
  onServers = fn
}

/** Panels arrive out of band — they're pushed while a turn is in flight,
 *  not returned by it. */
let onPanel: ((panel: Panel) => void) | null = null
export function watchPanels(fn: (panel: Panel) => void) {
  onPanel = fn
}

/**
 * The one request the bridge makes of us rather than the other way round.
 *
 * Everything else on this socket is pushed at the browser and needs no answer.
 * A camera frame has to travel back, so this handler is registered by the app
 * and its result is returned against the request's id.
 */
export type CaptureRequest = {
  /** 'look' for a single frame, 'watch' for a grid over time. */
  mode: 'look' | 'watch'
  reason: string
  seconds: number
  /** 'now' records forward; 'past' reads the rolling buffer. */
  when: 'now' | 'past'
}
export type CaptureResult = { data?: string; mimeType?: string; error?: string }

let onCapture: ((req: CaptureRequest) => Promise<CaptureResult>) | null = null
export function watchCapture(fn: (req: CaptureRequest) => Promise<CaptureResult>) {
  onCapture = fn
}

/** Blades arrive the same way panels do — pushed mid-turn, so the article is
 *  already open as he starts the sentence about it. */
let onBlade: ((blade: Blade) => void) | null = null
export function watchBlades(fn: (blade: Blade) => void) {
  onBlade = fn
}

/** Commands that redress the interface — theme, reactor, orbits, effects. Same
 *  out-of-band route as panels: JARVIS issues them while he is still mid-answer
 *  so the change is on screen as he says it, which means they cannot ride back
 *  on the turn's result. The op/args pair stays untyped here on purpose — this
 *  module is a transport, and the store is where the shape is decided. */
let onUi: ((op: string, args: any) => void) | null = null
export function watchUi(fn: (op: string, args: any) => void) {
  onUi = fn
}

/**
 * Connection state, for the UI.
 *
 *   'open'        — first connection of the page.
 *   'lost'        — the socket died. The agent session died with it, so
 *                   everything said so far is gone as far as JARVIS knows.
 *   'reconnected' — we're back, on a fresh session with no memory of the above.
 */
export type ConnectionState = 'open' | 'lost' | 'reconnected'
let onConnection: ((state: ConnectionState) => void) | null = null
export function watchConnection(fn: (state: ConnectionState) => void) {
  onConnection = fn
}

/** One device's new state, pushed by the bridge as soon as it arrives (koti.mjs cache, 9.11.2026). */
export type HomePart = { laite: string; tila: Record<string, unknown>; at: number }
const homeSubs = new Set<(p: HomePart) => void>()
export function watchHome(fn: (p: HomePart) => void): () => void {
  homeSubs.add(fn)
  return () => {
    homeSubs.delete(fn)
  }
}

export function isConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN
}

// ---------------------------------------------------------------------------
// PIN login (9.11.2026)
// ---------------------------------------------------------------------------

/**
 * Every socket starts unauthenticated: the bridge answers nothing but {type:'pin_tila'} until this page sends
 * the device token (localStorage) or a PIN. connect() resolves only after login, so every caller (chat,
 * requests, the meeting window, practice, phone) goes through the same gate.
 */
export type AuthState = { tila: 'yhdistaa' | 'pin' | 'tarkistaa' | 'ok'; syy?: string; lukittuMs?: number; jaljella?: number; viesti?: string }
let auth: AuthState = { tila: 'yhdistaa' }
const authSubs = new Set<(a: AuthState) => void>()
export function watchAuth(fn: (a: AuthState) => void): () => void {
  authSubs.add(fn)
  fn(auth)
  return () => {
    authSubs.delete(fn)
  }
}
function setAuth(a: AuthState) {
  auth = a
  authSubs.forEach((f) => f(a))
}
export const authState = () => auth

const TOKEN_KEY = 'jarvis.laite'
const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? ''
  } catch {
    return ''
  }
}
const saveToken = (t: string) => {
  try {
    localStorage.setItem(TOKEN_KEY, t)
  } catch {
    /* private mode: PIN again next time */
  }
}
const clearToken = () => {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* ok */
  }
}

/** Per-run key for the bridge's /file, /tts and /stt (given only after login). */
let pageKey = ''
export const pageKeyParam = () => pageKey
export const pageKeyHeaders = (): Record<string, string> => (pageKey ? { 'x-jarvis-avain': pageKey } : {})

let pinWaiter: ((pin: string) => void) | null = null
/** PIN from the PIN screen. */
export function submitPin(pin: string): void {
  pinWaiter?.(pin)
}
/** Kirjaudu ulos: the bridge forgets this device; the page reloads to the PIN screen. */
export function logout(): void {
  clearToken()
  try {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'kirjaudu_ulos' }))
  } catch {
    /* closing anyway */
  }
  window.setTimeout(() => window.location.reload(), 300)
}

function authenticate(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let token = readToken()
    const cleanup = () => {
      pinWaiter = null
      ws.removeEventListener('message', onMsg)
      ws.removeEventListener('close', onClose)
    }
    const askPin = (extra: Partial<AuthState> = {}) => {
      setAuth({ tila: 'pin', ...extra })
      pinWaiter = (pin) => {
        setAuth({ tila: 'tarkistaa' })
        try {
          ws.send(JSON.stringify({ type: 'pin', pin }))
        } catch {
          /* close handler reports */
        }
      }
    }
    const onMsg = (e: MessageEvent) => {
      if (typeof e.data !== 'string') return
      let m: { type?: string; ok?: boolean; token?: string; avain?: string; syy?: string; lukittuMs?: number; jaljella?: number }
      try {
        m = JSON.parse(e.data)
      } catch {
        return
      }
      if (m.type !== 'pin_tila') return
      if (m.ok) {
        if (m.token) saveToken(m.token)
        pageKey = m.avain ?? ''
        cleanup()
        setAuth({ tila: 'ok' })
        resolve()
        return
      }
      if (token) {
        // Stored token expired or revoked: ask for the PIN.
        token = ''
        clearToken()
        return askPin(m.syy === 'ei_pinia' ? { syy: 'ei_pinia' } : {})
      }
      askPin({ syy: m.syy, lukittuMs: m.lukittuMs, jaljella: m.jaljella })
    }
    const onClose = () => {
      cleanup()
      setAuth({ tila: 'yhdistaa' })
      reject(new Error('The bridge closed the connection.'))
    }
    ws.addEventListener('message', onMsg)
    ws.addEventListener('close', onClose)
    if (token) {
      setAuth({ tila: 'tarkistaa' })
      ws.send(JSON.stringify({ type: 'laite_token', token }))
    } else askPin()
  })
}

// ---------------------------------------------------------------------------
// NÄYTTÖ page: binary frames ('JVN1' + header length + JSON header + JPEG) and naytto_tila messages
// ---------------------------------------------------------------------------

/** tila: 'ff' = ffmpeg, 'ps' = perustila; tavoite = target fps of the current capture settings. */
export type ScreenFrame = { seq: number; t: number; w: number; h: number; kesto: number; naytto: number; tila?: string; tavoite?: number; jpg: Blob }
/** naytto_fokus: is a text field focused on the PC (rect normalized to the captured monitor). Never its content. */
export type ScreenFocus = { kirjoitus: boolean; rect: { x: number; y: number; w: number; h: number } | null; salasana: boolean }
export type ScreenEvent = { kind: 'frame'; frame: ScreenFrame } | { kind: 'tila'; data: Record<string, unknown> } | { kind: 'fokus'; data: ScreenFocus }
let onScreen: ((e: ScreenEvent) => void) | null = null
export function watchScreen(fn: ((e: ScreenEvent) => void) | null): void {
  onScreen = fn
}
/** naytto_* messages to the bridge (only on the logged-in socket). */
export function sendScreen(o: Record<string, unknown>): boolean {
  try {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify(o))
    return true
  } catch {
    return false
  }
}
const utf8 = new TextDecoder()
async function readFrame(data: Blob | ArrayBuffer) {
  if (data instanceof ArrayBuffer) {
    // binaryType 'arraybuffer': parsed synchronously, so frames can never overtake each other.
    const v = new DataView(data)
    if (v.byteLength < 8 || String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3)) !== 'JVN1') return
    const len = v.getUint32(4)
    const head = JSON.parse(utf8.decode(new Uint8Array(data, 8, len)))
    onScreen?.({ kind: 'frame', frame: { ...head, jpg: new Blob([new Uint8Array(data, 8 + len)], { type: 'image/jpeg' }) } })
    return
  }
  const blob = data
  const pre = new DataView(await blob.slice(0, 8).arrayBuffer())
  if (pre.byteLength < 8 || String.fromCharCode(pre.getUint8(0), pre.getUint8(1), pre.getUint8(2), pre.getUint8(3)) !== 'JVN1') return
  const len = pre.getUint32(4)
  const head = JSON.parse(await blob.slice(8, 8 + len).text())
  onScreen?.({ kind: 'frame', frame: { ...head, jpg: blob.slice(8 + len, blob.size, 'image/jpeg') } })
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

/** Resolved by the socket-level dispatcher on the first `ready` of the current
 *  connection. Re-armed per connection so a reconnect re-announces. */
let firstReady = deferred()

let everConnected = false

/** Backoff for the automatic re-dial: fast at first, then every 10 s for about
 *  five minutes — a restart ("uudelleen") rebuilds the interface, which can take
 *  a minute, and a phone left on the page should find JARVIS again by itself.
 *  After that it stops; the next ask()/request() or waking the page re-dials.
 *  9.11.2026: a failed re-dial used to end the chain after the first try. */
const RECONNECT_DELAYS = [500, 1000, 2000, 4000, 8000, ...Array<number>(28).fill(10_000)]
let attempt = 0
let reconnectTimer = 0

function scheduleReconnect() {
  if (attempt >= RECONNECT_DELAYS.length) return
  const delay = RECONNECT_DELAYS[attempt]
  attempt += 1
  clearTimeout(reconnectTimer)
  reconnectTimer = window.setTimeout(() => {
    void connect().catch(() => scheduleReconnect())
  }, delay)
}

// The phone wakes the page (or the network comes back): re-dial now instead of waiting for the next backoff step.
if (typeof window !== 'undefined') {
  const wake = () => {
    if (!everConnected || socket?.readyState === WebSocket.OPEN || connecting || document.hidden) return
    attempt = 0
    clearTimeout(reconnectTimer)
    void connect().catch(() => scheduleReconnect())
  }
  document.addEventListener('visibilitychange', wake)
  window.addEventListener('online', wake)
}

/**
 * One message listener per socket, owning everything that isn't part of a
 * turn. It used to live inside warmBridge, bound to that one socket: after any
 * reconnect the SYSTEM rail froze for the life of the page, and every extra
 * warmBridge() call leaked another listener onto the same socket.
 */
function dispatch(ws: WebSocket) {
  // Only NÄYTTÖ frames are binary; an ArrayBuffer parses synchronously (no Blob reads per frame).
  ws.binaryType = 'arraybuffer'
  ws.addEventListener('message', (e: MessageEvent) => {
    if (typeof e.data !== 'string') {
      if (onScreen) void readFrame(e.data as Blob | ArrayBuffer).catch(() => {})
      return
    }
    let msg: Frame & Record<string, unknown>
    try {
      msg = JSON.parse(e.data as string)
    } catch {
      return
    }

    if (msg.type === 'naytto_tila') {
      onScreen?.({ kind: 'tila', data: msg })
    } else if (msg.type === 'naytto_fokus') {
      const r = msg.rect as ScreenFocus['rect']
      onScreen?.({ kind: 'fokus', data: { kirjoitus: msg.kirjoitus === true, rect: r && typeof r.x === 'number' ? r : null, salasana: msg.salasana === true } })
    } else if (msg.type === 'koti_osa' && typeof msg.laite === 'string') {
      const part = { laite: msg.laite, tila: (msg.tila ?? {}) as Record<string, unknown>, at: Number(msg.at) || Date.now() }
      homeSubs.forEach((f) => f(part))
    } else if (msg.type === 'pin_tila' && msg.ok === false && auth.tila === 'ok') {
      // Logged out from elsewhere (/laitteet pois): forget the token; the PIN screen takes over.
      clearToken()
      setAuth({ tila: 'pin', syy: String(msg.syy ?? 'ulos') })
    } else if (msg.type === 'ready') {
      // The bridge announces immediately on connect from Claude Code's config,
      // then again with live status once the agent initialises. Keep listening
      // so the later, more accurate list wins.
      servers = (msg.servers ?? [])
        .map((s) => (typeof s === 'string' ? s : (s.name ?? '')))
        .filter(Boolean)
      onServers?.(servers)
      firstReady.resolve()
    } else if (msg.type === 'panel' && msg.panel) {
      onPanel?.(msg.panel)
    } else if (msg.type === 'blade' && msg.blade) {
      onBlade?.(msg.blade)
    } else if (msg.type === 'capture' && msg.id) {
      const id = msg.id
      const reply = (payload: Record<string, unknown>) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'reply', id, ...payload }))
        }
      }
      if (!onCapture) {
        reply({ error: 'The interface has no camera handler.' })
      } else {
        // Always answers, even on failure: the bridge is holding a turn open
        // waiting for this, and a rejection that never arrives is a turn that
        // hangs until the idle timer notices.
        onCapture({
          mode: msg.mode === 'watch' ? 'watch' : 'look',
          reason: msg.reason ?? '',
          seconds: Math.max(2, Math.min(15, Number(msg.seconds) || 6)),
          when: msg.when === 'past' ? 'past' : 'now',
        })
          .then(reply)
          .catch((err) => reply({ error: String(err?.message ?? err) }))
      }
    } else if (msg.type === 'vastaus' && msg.id) {
      const slot = requests.get(msg.id)
      if (slot) {
        requests.delete(msg.id)
        clearTimeout(slot.timer)
        if (msg.ok) slot.resolve(msg.data)
        else slot.reject(new Error(msg.error ?? 'Pyyntö epäonnistui'))
      }
    } else if (msg.type === 'ui' && msg.op) {
      // A `ui` frame with no args is normal — reset and clear take none — so an
      // absent args object is an empty one, not a reason to drop the command.
      onUi?.(msg.op, (msg.args ?? {}) as Record<string, unknown>)
    }
  })
}

/** Suorat pyynnöt bridgelle (Tänään-näkymä, liidien hyväksyntä) — eivät kuluta mallia. */
const requests = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }>()
let reqSeq = 0
export async function request<T = unknown>(nimi: string, args: Record<string, unknown> = {}, timeoutMs = 45_000): Promise<T> {
  const ws = await connect()
  const id = `p${++reqSeq}`
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      requests.delete(id)
      reject(new Error('Bridge ei vastannut ajoissa'))
    }, timeoutMs)
    requests.set(id, { resolve, reject, timer })
    try {
      ws.send(JSON.stringify({ type: 'pyynto', id, nimi, args }))
    } catch (err) {
      clearTimeout(timer)
      requests.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Uusi keskustelu: suljetaan yhteys tarkoituksella, jolloin bridge aloittaa uuden istunnon.
 * Pitkä istunto lähettää koko historian joka kysymyksellä — tämä on krediittien säästöä.
 */
let quietReset = false
export async function newConversation(): Promise<void> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    await connect()
    return
  }
  quietReset = true
  socket.close()
  await new Promise((r) => setTimeout(r, 150))
  await connect()
}

function connect(): Promise<WebSocket> {
  if (socket?.readyState === WebSocket.OPEN) return Promise.resolve(socket)
  if (connecting) return connecting

  firstReady = deferred()

  connecting = new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(BRIDGE_WS_URL)
    let settled = false

    /**
     * Every terminal path runs through here, and clearing `connecting` is the
     * whole point. The timeout used to reject without clearing it, which
     * bricked the client: the fast path above hands that same dead promise to
     * every later caller, so one slow start cost you a page reload.
     */
    const settle = (err: Error | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      connecting = null
      if (err) reject(err)
      else resolve(ws)
    }

    const timer = setTimeout(() => {
      ws.close()
      settle(new Error('Bridge not responding — is `npm run bridge` running?'))
    }, 6000)

    ws.onopen = () => {
      // The dial worked; logging in (token or PIN) may take as long as the user needs.
      clearTimeout(timer)
      dispatch(ws)
      authenticate(ws).then(
        () => {
          socket = ws
          attempt = 0
          settle(null)
          if (quietReset) quietReset = false
          else onConnection?.(everConnected ? 'reconnected' : 'open')
          everConnected = true
        },
        (err: Error) => settle(err),
      )
    }
    ws.onerror = () => {
      /**
       * The browser will not tell us why.
       *
       * A refused handshake and a rejected Origin arrive here identically — no
       * status, no reason, just `error` — and the two have completely different
       * fixes. The old message named only one of them, and confidently: it said
       * to start the bridge. When the real cause was the page being served on a
       * port outside the range the bridge trusts, that advice sent everyone to
       * inspect a process that was running perfectly the whole time.
       *
       * So say both, and put the actual port in front of them, since that is
       * the fact that distinguishes the two cases at a glance.
       */
      settle(
        new Error(
          `Cannot reach the bridge at ${BRIDGE_WS_URL}. Either it is not ` +
            'running (start it with `npm start`), or this page is on a port it ' +
            `refuses — it accepts localhost:5173-5199 and 4173-4199, and this ` +
            `page is on ${location.port || '80'}.`,
        ),
      )
    }
    ws.onclose = () => {
      // A close before open is just a failed dial; after open it's a lost
      // session, and the two want different handling.
      settle(new Error('The bridge closed the connection.'))
      if (socket === ws) {
        socket = null
        if (quietReset) return // uusi keskustelu: newConversation() avaa yhteyden itse
        onConnection?.('lost')
        scheduleReconnect()
      }
    }
  })

  return connecting
}

/** Open the socket early so the first "Hey Jarvis" isn't waiting on a handshake. */
export async function warmBridge(): Promise<void> {
  await connect()
  // Don't block startup if the bridge never announces — the dispatcher fills
  // the rail in whenever the list does turn up.
  await Promise.race([
    firstReady.promise,
    new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  ])
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

/**
 * No frame of any kind for two minutes means the turn is never coming back.
 * Generous on purpose: a long agent run can sit silent through a slow tool,
 * and cutting a real answer off is worse than waiting. What this catches is
 * the case that used to hang forever — the bridge alive but the turn lost.
 */
const IDLE_TIMEOUT_MS = 120_000

/** The turn in flight, so a barge-in can settle it locally. */
let pending: { finish: (fallback?: string) => void } | null = null

export async function ask(
  prompt: string,
  handlers: AskHandlers,
  opts: { mode?: 'text' | 'voice' } = {},
): Promise<{ text: string; tools: string[] }> {
  /**
   * A new question supersedes the one in flight.
   *
   * Two concurrent turns genuinely would corrupt each other — both listeners
   * see every delta, and the first 'done' resolves both with the other's text —
   * but refusing the new one was the wrong way to prevent that. It surfaced as
   * "JARVIS is already answering", which is a sentence about this module's
   * bookkeeping rather than about anything the user did, and it contradicts the
   * premise the whole app is built on: say something and it becomes the turn.
   *
   * It fired far more than it looked like it should, because the only thing
   * that cleared the slot was a barge-in — and a barge-in only fires in guard
   * mode. A transcript can arrive well after the speech that produced it: the
   * segment queue means several can be waiting, and their onsets happened while
   * the machine was still listening, when nothing interrupts. So the second
   * utterance of a normal sentence could land on a turn that was already
   * running and simply be refused.
   *
   * Cancelling settles the old promise synchronously, so by the time the code
   * below claims the slot there is nothing left to collide with. The abandoned
   * turn's caller sees its own `stale()` check and stands down quietly.
   */
  if (pending) cancel()

  // Claim the slot in this same tick. connect() below awaits, and two calls
  // made before it settles would otherwise both sail past the check above.
  let cancelledWhileDialling = false
  pending = {
    finish: () => {
      cancelledWhileDialling = true
    },
  }

  let ws: WebSocket
  try {
    ws = await connect()
  } catch (err) {
    pending = null
    throw err
  }

  // Barged in on before the socket was even up. Nothing was ever asked.
  if (cancelledWhileDialling) {
    pending = null
    return { text: '', tools: [] }
  }

  const id = `a${++askSeq}`
  const tools: string[] = []
  let text = ''

  return new Promise((resolve, reject) => {
    let done = false
    let timer = 0

    const cleanup = () => {
      done = true
      pending = null
      clearTimeout(timer)
      ws.removeEventListener('message', onMessage)
      ws.removeEventListener('close', onClose)
      ws.removeEventListener('error', onError)
    }

    const finish = (fallback = '') => {
      if (done) return
      cleanup()
      // Prefer the streamed text; fall back to the final result if this build
      // didn't emit deltas.
      resolve({ text: (text || fallback).trim(), tools })
    }

    const fail = (err: Error) => {
      if (done) return
      cleanup()
      reject(err)
    }

    const arm = () => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        fail(new Error('The bridge went quiet — that turn was lost, sir.'))
      }, IDLE_TIMEOUT_MS)
    }

    const onMessage = (e: MessageEvent) => {
      // Any frame at all is proof of life, including ones this turn ignores.
      arm()

      let msg: Frame
      try {
        msg = JSON.parse(e.data as string)
      } catch {
        // A frame we can't read is not a reason to abandon the turn. It used
        // to be: the parse threw inside the listener, nothing settled the
        // promise, and App's `busy` flag stayed true for the life of the page.
        return
      }

      /**
       * Somebody else's answer.
       *
       * A superseded turn keeps streaming for a moment after it is abandoned,
       * and this listener is attached to the socket rather than to a turn — so
       * without this check the tail of the old answer is read as the beginning
       * of the new one. Measured before it existed: ask for ALPHA, barge in,
       * ask for BRAVO, and BRAVO's answer came back as "ALPHA".
       */
      if (msg.ask && msg.ask !== id) return

      try {
        switch (msg.type) {
          case 'text':
            text += msg.delta ?? ''
            handlers.onText(msg.delta ?? '')
            break

          case 'tool':
            if (!msg.name) break
            tools.push(msg.name)
            handlers.onTool(prettyToolName(msg.name))
            break

          case 'done':
            finish(msg.text ?? '')
            break

          case 'error':
            fail(new Error(msg.message ?? 'The bridge reported an error.'))
            break
        }
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)))
      }
    }

    const onClose = () => {
      fail(new Error('The bridge disconnected mid-answer — that session is gone.'))
    }
    const onError = () => {
      fail(new Error('The connection to the bridge failed.'))
    }

    pending = { finish }
    ws.addEventListener('message', onMessage)
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onError)
    arm()

    try {
      ws.send(JSON.stringify({ type: 'ask', text: prompt, id, mode: opts.mode ?? 'voice' }))
    } catch (err) {
      // The socket can go into CLOSING between connect() resolving and here.
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * Cut JARVIS off mid-answer.
 *
 * Tells the bridge to stop, then settles the in-flight turn here rather than
 * waiting for a 'done' that a barge-in may never produce. Whatever he had
 * already said is returned, so the caller's await always comes back and the
 * transcript keeps the half-sentence the user actually heard.
 */
export function cancel(): void {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'interrupt' }))
  }
  pending?.finish()
}

/** The older name for `cancel()`. */
export function interrupt(): void {
  cancel()
}

/**
 * Kokoustila: kuultu puhe menee bridgelle litteraattiin, ei kysymyksenä.
 * Hiljainen epäonnistuminen on tarkoituksellinen — pätkän katoaminen ei saa
 * keskeyttää kuuntelua.
 */
export function sendMeeting(text: string): void {
  try {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'meeting', text }))
    }
  } catch {
    /* ohi */
  }
}

/** `mcp__higgsfield__generate_image` -> `higgsfield · generate image` */
function prettyToolName(raw: string): string {
  if (!raw.startsWith('mcp__')) return raw
  const [, server, ...rest] = raw.split('__')
  return `${server} · ${rest.join(' ').replace(/_/g, ' ')}`
}
