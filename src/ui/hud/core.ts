/**
 * HUD shared state: local settings (effects, globe quality, accent hue, haptics), feedback effects,
 * toasts, the event log and the single gateway to device tools (`runTool` → bridge 'laite' request).
 */
import { create } from 'zustand'
import { request } from '../../lib/brain'

export type Fx = 0 | 1 | 2
export type Settings = { fx: Fx; q: 0 | 1 | 2; hue: number; hap: boolean }

const RM = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const PREFIX = 'jv2.'
function load<T>(k: string, d: T): T {
  try {
    const v = localStorage.getItem(PREFIX + k)
    return v == null ? d : (JSON.parse(v) as T)
  } catch {
    return d
  }
}
function save(k: string, v: unknown) {
  try {
    localStorage.setItem(PREFIX + k, JSON.stringify(v))
  } catch {
    /* private mode: settings live for this page only */
  }
}

export type Toast = { id: number; key: string; title: string; code: string; st: 'send' | 'ok' | 'warn' | 'err'; ts: string; out?: boolean }
export type LogRow = { t: number; txt: string }
/** Round-trip of one command (tap → bridge reply), for the JÄRJESTELMÄ "Viive" panel. */
export type Latency = { t: number; label: string; ms: number; ok: boolean }
/** koti_tila answer time and when each device's state last arrived (ms the device took on the bridge). */
export type HomeTiming = { ms: number; t: number } | null
export type DeviceTiming = Record<string, { t: number; kesto: number | null }>

type HudState = {
  settings: Settings
  toasts: Toast[]
  log: LogRow[]
  fps: number
  lat: Latency[]
  homeLat: HomeTiming
  devLat: DeviceTiming
  set: <K extends keyof Settings>(k: K, v: Settings[K]) => void
}

/** Phones and small laptops (≤ 4 cores) start with light effects and the light globe; a saved choice wins. */
const WEAK = typeof navigator !== 'undefined' && (navigator.hardwareConcurrency || 8) <= 4

export const useHud = create<HudState>((setState) => ({
  settings: { fx: load<Fx>('fx', RM ? 0 : WEAK ? 1 : 2), q: load('q', WEAK ? 0 : 1), hue: load('hue', 190), hap: load('hap', true) },
  toasts: [],
  log: [],
  fps: 0,
  lat: [],
  homeLat: null,
  devLat: {},
  set: (k, v) => {
    save(k, v)
    setState((s) => ({ settings: { ...s.settings, [k]: v } }))
  },
}))

export const getSettings = () => useHud.getState().settings

// ---------------------------------------------------------------- haptics
export function hap(ms = 8) {
  if (!getSettings().hap) return
  try {
    navigator.vibrate?.(ms)
  } catch {
    /* not supported */
  }
}

// ---------------------------------------------------------------- colour helpers
export function hsl2rgb(h: number, s: number, l: number): [number, number, number] {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number]
}
/** Colour temperature (K) → RGB for the dial and light ripple. */
export function ctColor(k: number): [number, number, number] {
  const t = (k - 2200) / 4300
  const w = [255, 173, 85], m = [255, 240, 220], c = [185, 220, 255]
  const mix = (a: number[], b: number[], u: number) => a.map((x, i) => Math.round(x + (b[i] - x) * u))
  return (t < 0.5 ? mix(w, m, t * 2) : mix(m, c, (t - 0.5) * 2)) as [number, number, number]
}

// ---------------------------------------------------------------- task effects
let FX: HTMLDivElement | null = null
export const setFxLayer = (el: HTMLDivElement | null) => {
  FX = el
}
/** Globe pulse hook (routine effect); set by the globe. */
export const globeHooks = { pulse: () => {} }

function addFx(el: HTMLElement, ms: number) {
  FX?.appendChild(el)
  window.setTimeout(() => el.remove(), ms)
}
function center(el?: Element | null): [number, number] {
  if (!el) return [innerWidth / 2, innerHeight / 2]
  const r = el.getBoundingClientRect()
  return [r.left + r.width / 2, r.top + r.height / 2]
}

export type FxType = 'heat' | 'cool' | 'light' | 'media' | 'tv' | 'vac' | 'scan' | 'snap' | 'routine' | 'key' | 'power' | null | undefined

/** Task-specific effect at the element (heat/cool particles, light ripple, media beam, CRT, sweep, flash). */
export function fx(type: FxType, el?: Element | null, color?: string) {
  const lvl = getSettings().fx
  if (lvl === 0 || !type || !FX) return
  const [x, y] = center(el)
  const lite = lvl === 1
  const rip = (c?: string) => {
    const d = document.createElement('div')
    d.className = 'rip'
    d.style.left = x + 'px'
    d.style.top = y + 'px'
    if (c) d.style.setProperty('--c', c)
    addFx(d, 820)
  }
  const parts = (kind: 'heat' | 'cool') => {
    const n = lite ? 6 : 16
    for (let i = 0; i < n; i++) {
      const p = document.createElement('i')
      p.className = 'pt ' + kind
      const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 110
      const dx = Math.cos(a) * r, dy = kind === 'heat' ? -(60 + Math.random() * 160) : Math.sin(a) * r + 40
      p.style.cssText = `left:${x + (Math.random() - 0.5) * 60}px;top:${y + (Math.random() - 0.5) * 40}px;--dx:${dx * (kind === 'heat' ? 0.4 : 1)}px;--dy:${dy}px;animation-delay:${Math.random() * 120}ms`
      addFx(p, 1300)
    }
  }
  const tint = (k: string) => {
    if (lite) return
    const d = document.createElement('div')
    d.className = 'tint ' + k
    addFx(d, 1150)
  }
  const inPanel = (cls: string, ms: number) => {
    const p = el?.closest('.pnl') as HTMLElement | null
    if (!p) return
    const s = document.createElement('div')
    s.className = cls
    p.appendChild(s)
    window.setTimeout(() => s.remove(), ms)
  }
  switch (type) {
    case 'heat':
      parts('heat')
      tint('heat')
      break
    case 'cool':
      parts('cool')
      tint('cool')
      break
    case 'light':
      rip(color)
      break
    case 'media':
      if (!lite) {
        const b = document.createElement('div')
        b.className = 'beam'
        addFx(b, 1050)
      }
      rip()
      break
    case 'tv': {
      const p = el?.closest('.pnl') as HTMLElement | null
      if (p) {
        p.classList.remove('crt')
        void p.offsetWidth
        p.classList.add('crt')
      }
      rip()
      break
    }
    case 'vac':
    case 'scan':
      inPanel('swp', 950)
      break
    case 'snap':
      inPanel('flash', 420)
      break
    case 'routine':
      globeHooks.pulse()
      rip()
      break
    default:
      rip()
  }
}

/** Short ripple at a screen point (NÄYTTÖ taps). */
export function rippleAt(x: number, y: number) {
  if (!FX || getSettings().fx === 0) return
  const d = document.createElement('div')
  d.className = 'rip rip--sm'
  d.style.left = x + 'px'
  d.style.top = y + 'px'
  addFx(d, 600)
}

// ---------------------------------------------------------------- toasts + log
let toastSeq = 0
const toastTimers = new Map<number, number>()

export function toastStart(title: string, code: string, key: string): number {
  const id = ++toastSeq
  useHud.setState((s) => {
    const rest = s.toasts.filter((t) => t.key !== key)
    const old = s.toasts.find((t) => t.key === key)
    if (old) window.clearTimeout(toastTimers.get(old.id))
    return { toasts: [{ id, key, title, code, st: 'send' as const, ts: 'LÄHETETÄÄN' }, ...rest].slice(0, 3) }
  })
  return id
}
export function toastDone(id: number, result: string, st: 'ok' | 'warn' | 'err' = 'ok') {
  useHud.setState((s) => ({
    toasts: s.toasts.map((t) => (t.id === id ? { ...t, st, code: result || t.code, ts: st === 'ok' ? '✓ OK' : st === 'warn' ? '! HUOM' : '✕ VIRHE' } : t)),
  }))
  const life = st === 'ok' ? 1400 : 7000
  toastTimers.set(
    id,
    window.setTimeout(() => {
      useHud.setState((s) => ({ toasts: s.toasts.map((t) => (t.id === id ? { ...t, out: true } : t)) }))
      window.setTimeout(() => useHud.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 320)
    }, life),
  )
}
/** One-line toast without a tool call (settings, local events). */
export function note(title: string, code = '', st: 'ok' | 'warn' | 'err' = 'ok') {
  const id = toastStart(title, code, 'note' + title)
  toastDone(id, code, st)
}

export function log(txt: string) {
  useHud.setState((s) => ({ log: [{ t: Date.now(), txt }, ...s.log].slice(0, 40) }))
}

export function recordLatency(label: string, ms: number, ok: boolean) {
  useHud.setState((s) => ({ lat: [{ t: Date.now(), label, ms: Math.round(ms), ok }, ...s.lat].slice(0, 20) }))
}

// ---------------------------------------------------------------- tool gateway
export type Reply = { text: string; [k: string]: unknown }
const errText = (e: unknown) => String((e as Error)?.message ?? e)
/** Result lines that mean "did not happen" even though the request itself succeeded. */
const SOFT_FAIL = /^(Ei onnistunut|Tuntematon|En löytänyt|Kerro mitä)|epäonnistui|ei ole (yhdistetty|asennettu)|ei vastaa|ei löytynyt|offline|ei ole lämmitystilaa|ei ole päällä/i
/** Projector busy with another task or still waking: a notice, not an error — the control keeps its new position. */
const QUEUED = /^(Projektori on varattu|Projektori herää|Jonossa)/i

const inflight = new Set<string>()
const pending = new Map<string, { run: () => void; drop: () => void }>()

export type RunOpts = {
  label: string
  fx?: FxType
  el?: Element | null
  color?: string
  key?: string
  ms?: number
  coalesce?: boolean
  after?: (r: Reply | null) => void
  /** Optimistic UI: the screen already shows the new state; this puts the previous one back if the command failed. */
  onFail?: () => void
  /** No haptic/effect (repeated live sends while a dial is dragged). */
  quiet?: boolean
}

/**
 * The single gateway from HUD controls to the bridge: same 'laite' request the old views use.
 * coalesce: while a command with the same key is in flight, only the latest new one is kept and sent next — this
 * is also what throttles live sends from a dragged dial to the speed the device can take.
 */
export function runTool(tyokalu: string, args: Record<string, unknown>, o: RunOpts): Promise<Reply | null> {
  const key = o.key ?? tyokalu
  if (o.coalesce && inflight.has(key)) {
    // The superseded command's caller resolves with the newer one's result; only that one's onFail matters.
    const prev = pending.get(key)
    if (prev) prev.drop()
    return new Promise((resolve) => pending.set(key, { run: () => void runTool(tyokalu, args, o).then(resolve), drop: () => resolve(null) }))
  }
  if (!o.quiet) {
    hap()
    fx(o.fx, o.el, o.color)
  }
  const code = '→ ' + tyokalu + ' ' + JSON.stringify(args).replace(/"/g, '').replace(/,/g, ', ')
  const id = toastStart(o.label, code, key)
  inflight.add(key)
  const t0 = performance.now()
  return request<Reply>('laite', { tyokalu, args }, o.ms ?? 60_000)
    .then((r) => {
      const first = String(r?.text ?? '').split('\n')[0].slice(0, 180) || 'Tehty.'
      const queued = QUEUED.test(first)
      const soft = !queued && SOFT_FAIL.test(first)
      recordLatency(o.label, performance.now() - t0, !soft && !queued)
      if (soft) o.onFail?.()
      toastDone(id, first, queued ? 'warn' : soft ? (o.onFail ? 'err' : 'warn') : 'ok')
      log(soft ? `${o.label}: ${first.slice(0, 60)}` : o.label)
      o.after?.(r)
      return r
    })
    .catch((e) => {
      recordLatency(o.label, performance.now() - t0, false)
      o.onFail?.()
      toastDone(id, `Ei onnistunut: ${errText(e)}`, 'err')
      log(`${o.label}: virhe`)
      o.after?.(null)
      return null
    })
    .finally(() => {
      inflight.delete(key)
      const next = pending.get(key)
      if (next) {
        pending.delete(key)
        next.run()
      }
    })
}
