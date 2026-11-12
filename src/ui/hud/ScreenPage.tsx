/**
 * NÄYTTÖ (9.11.2026, jatko 10.11.2026): koneen näyttö kuvana ja ohjaus napautuksilla tai hiirellä.
 * Napautus = klikkaus, pitkä painallus = oikea klikkaus, kaksoisnapautus = tuplaklikkaus, kahden sormen veto =
 * vieritys, nipistys = zoom (yhdellä sormella panoroi zoomattuna), hiirellä raahaus = raahaus, rulla = vieritys.
 * Virta kulkee vain kun tämä sivu on näkyvissä. Kuvat piirretään canvasille (createImageBitmap); jokainen kuva
 * kuitataan heti saapuessaan ja hitaan purun aikana vain uusin odottaa (ei jonoa).
 * Koko näyttö: CSS-näkymä kaiken päälle (iPhone Safari) + Fullscreen API, missä se toimii. Kun koneella on
 * tekstikenttä kohdistettuna (naytto_fokus), puhelimen näppäimistö avautuu piilokentästä ja kirjoitus menee
 * koneelle merkki kerrallaan (~40 ms erissä).
 */
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sendScreen, watchScreen, type ScreenEvent, type ScreenFocus, type ScreenFrame } from '../../lib/bridge'
import { hap, note, rippleAt } from './core'
import { Pnl, Seg } from './controls'
import { Ic } from './icons'

type Mon = { i: number; ensisijainen: boolean; w: number; h: number; kaikki?: boolean }
type FpsSel = 'auto' | 5 | 10 | 15 | 30
type Rect = { x: number; y: number; w: number; h: number }
type Op = { k: 't'; s: string } | { k: 'b'; n: number } | { k: 'key'; key: string }
const KEYS: Array<[string, string]> = [
  ['enter', 'Enter'], ['esc', 'Esc'], ['tab', 'Tab'], ['backspace', '⌫'], ['delete', 'Del'],
  ['vasen', '←'], ['ylös', '↑'], ['alas', '↓'], ['oikea', '→'],
  ['win', 'Win'], ['alt+tab', 'Alt+Tab'], ['ctrl+c', 'Ctrl+C'], ['ctrl+v', 'Ctrl+V'], ['ctrl+z', 'Ctrl+Z'],
]
/** Compact strip in full-screen mode. */
const FULL_KEYS: Array<[string, string]> = [
  ['enter', '⏎'], ['esc', 'Esc'], ['tab', 'Tab'], ['backspace', '⌫'],
  ['vasen', '←'], ['ylös', '↑'], ['alas', '↓'], ['oikea', '→'],
  ['win', 'Win'], ['alt+tab', 'Alt+Tab'], ['ctrl+c', 'C+C'], ['ctrl+v', 'C+V'], ['ctrl+z', 'C+Z'],
]
const FPS_OPTS: FpsSel[] = ['auto', 5, 10, 15, 30]
const fpsLabel = (f: FpsSel) => (f === 'auto' ? 'AUTO' : `${f} FPS`)
const loadFps = (): FpsSel => {
  try {
    const n = Number(localStorage.getItem('jv2.nfps2'))
    return n === 5 || n === 10 || n === 15 || n === 30 ? n : 'auto'
  } catch {
    return 'auto'
  }
}
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const UA = typeof navigator !== 'undefined' ? navigator.userAgent : ''
const IS_IOS = /iP(hone|ad|od)/.test(UA) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const IS_IPHONE = /iPhone|iPod/.test(UA)
const COARSE = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
/** Sentinel in the hidden field: backspace on an "empty" field still fires an input event (iOS sends none). */
const SENT = '​'
const DOC_KEYS: Record<string, string> = { ArrowLeft: 'vasen', ArrowRight: 'oikea', ArrowUp: 'ylös', ArrowDown: 'alas', Tab: 'tab', Escape: 'esc', Delete: 'delete', Home: 'home', End: 'end' }

async function decodeJpeg(b: Blob): Promise<{ img: ImageBitmap | HTMLImageElement; w: number; h: number }> {
  if (typeof createImageBitmap === 'function') {
    const bm = await createImageBitmap(b)
    return { img: bm, w: bm.width, h: bm.height }
  }
  const url = URL.createObjectURL(b)
  try {
    const im = new Image()
    im.src = url
    await im.decode()
    return { img: im, w: im.naturalWidth, h: im.naturalHeight }
  } finally {
    URL.revokeObjectURL(url)
  }
}
/** The letterboxed picture inside the canvas box (object-fit: contain). */
function contentRect(el: HTMLElement, w: number, h: number) {
  const r = el.getBoundingClientRect()
  if (!w || !h || !r.width || !r.height) return r
  const s = Math.min(r.width / w, r.height / h)
  const cw = w * s, ch = h * s
  return { left: r.left + (r.width - cw) / 2, top: r.top + (r.height - ch) / 2, width: cw, height: ch }
}
const kbOpen = () => {
  const vv = window.visualViewport
  return Boolean(vv && window.innerHeight - vv.height > 120)
}

export function ScreenPage({ active }: { active: boolean }) {
  const [fps, setFps] = useState<FpsSel>(loadFps)
  const [paused, setPaused] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [taken, setTaken] = useState(false)
  const [hidden, setHidden] = useState(() => document.hidden)
  const [mons, setMons] = useState<Mon[]>([])
  const [mon, setMon] = useState<number | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [stats, setStats] = useState({ fps: 0, viive: 0 })
  const [perus, setPerus] = useState<string | null>(null)
  const [more, setMore] = useState(false)
  const [hasFrame, setHasFrame] = useState(false)
  const [full, setFull] = useState(false)
  const [ui, setUi] = useState(true)
  const [keysOpen, setKeysOpen] = useState(false)
  const [hint, setHint] = useState(false)
  const [foc, setFoc] = useState<ScreenFocus | null>(null)
  const [bubble, setBubble] = useState<{ x: number; y: number } | null>(null)
  const [typing, setTyping] = useState(false)
  const [kbBottom, setKbBottom] = useState(0)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const typeRef = useRef<HTMLInputElement>(null)
  const offset = useRef(0)
  const lastFrame = useRef(0)
  const paints = useRef<number[]>([])
  const lastLat = useRef(0)
  const z = useRef({ s: 1, tx: 0, ty: 0 })
  const lastImg = useRef<ImageBitmap | HTMLImageElement | null>(null)
  const size = useRef({ w: 0, h: 0 })
  const pending = useRef<ScreenFrame | null>(null)
  const decoding = useRef(false)
  const uiTimer = useRef(0)
  const reqFs = useRef(false)
  // typing
  const typingRef = useRef(false)
  const manual = useRef(false)
  const optimistic = useRef(0)
  const lastTap = useRef(0)
  const editRect = useRef<Rect | null>(null)
  const focRef = useRef<ScreenFocus | null>(null)
  const prevVal = useRef(SENT)
  const ops = useRef<Op[]>([])
  const flushT = useRef(0)
  const bubbleT = useRef(0)

  const want = active && !paused && !stopped && !taken && !hidden
  const wantRef = useRef(want)
  wantRef.current = want

  // ---- drawing (latest frame wins while a decode is running)
  const paint = () => {
    const c = canvasRef.current, img = lastImg.current
    if (!c || !img) return
    const { w, h } = size.current
    if (c.width !== w || c.height !== h) {
      c.width = w
      c.height = h
    }
    c.getContext('2d')?.drawImage(img, 0, 0, w, h)
  }
  const setCanvas = (c: HTMLCanvasElement | null) => {
    canvasRef.current = c
    if (c) paint()
  }
  const decodeNext = () => {
    if (decoding.current || !pending.current) return
    const f = pending.current
    pending.current = null
    decoding.current = true
    decodeJpeg(f.jpg)
      .then(({ img, w, h }) => {
        const old = lastImg.current
        lastImg.current = img
        size.current = { w, h }
        paint()
        if (old && old !== img && 'close' in old) old.close()
        const now = Date.now()
        paints.current.push(now)
        lastLat.current = Math.max(0, Math.round(now - (f.t - offset.current)))
        setHasFrame(true)
      })
      .catch(() => {})
      .finally(() => {
        decoding.current = false
        decodeNext()
      })
  }

  // ---- typing to the PC (live, ~40 ms batches)
  const flush = () => {
    flushT.current = 0
    const q = ops.current.splice(0)
    if (!wantRef.current) return
    for (const op of q) {
      if (op.k === 't') {
        for (let i = 0; i < op.s.length; i += 400) sendScreen({ type: 'naytto_syote', tyyppi: 'teksti', teksti: op.s.slice(i, i + 400) })
      } else if (op.k === 'b') {
        for (let n = op.n; n > 0; n -= 50) sendScreen({ type: 'naytto_syote', tyyppi: 'nappain', nappi: 'backspace', kerrat: Math.min(50, n), kirjoitus: true })
      } else sendScreen({ type: 'naytto_syote', tyyppi: 'nappain', nappi: op.key, kirjoitus: true })
    }
  }
  const queueOp = (op: Op) => {
    const q = ops.current
    const last = q[q.length - 1]
    if (op.k === 't' && last?.k === 't') last.s += op.s
    else if (op.k === 'b' && last?.k === 'b') last.n += op.n
    else q.push(op)
    if (!flushT.current) flushT.current = window.setTimeout(flush, 40)
  }
  /** Diff the hidden field against what was sent: handles autocorrect, predictive text and IME composition. */
  const syncValue = () => {
    const el = typeRef.current
    if (!el) return
    const v = el.value, prev = prevVal.current
    let p = 0
    while (p < prev.length && p < v.length && prev[p] === v[p]) p++
    if (p > 0 && p < prev.length && /[\uD800-\uDBFF]/.test(prev[p - 1])) p-- // never split a surrogate pair
    const del = [...prev.slice(p)].length
    const ins = v.slice(p).replace(/​/g, '')
    if (del) queueOp({ k: 'b', n: del })
    if (ins) queueOp({ k: 't', s: ins })
    prevVal.current = v
    if (!v.startsWith(SENT) || (v.length > 200 && /\s$/.test(v))) {
      el.value = SENT
      prevVal.current = SENT
      try {
        el.setSelectionRange(1, 1)
      } catch {
        /* ok */
      }
    }
  }
  /** Must run synchronously inside the tap (iOS opens the keyboard only then). */
  const openTyping = (isManual: boolean) => {
    const el = typeRef.current
    if (!el || !wantRef.current) return
    manual.current = isManual
    el.value = SENT
    prevVal.current = SENT
    el.focus({ preventScroll: true })
    try {
      el.setSelectionRange(1, 1)
    } catch {
      /* ok */
    }
    setBubble(null)
  }
  const stopTyping = () => typeRef.current?.blur()
  const showBubble = (rect: Rect | null) => {
    const st = stageRef.current, c = canvasRef.current
    if (!st || !c) return
    const sr = st.getBoundingClientRect()
    const cr = contentRect(c, size.current.w, size.current.h)
    let x = sr.width / 2, y = sr.height - 70
    if (rect) {
      x = cr.left - sr.left + (rect.x + rect.w / 2) * cr.width
      y = cr.top - sr.top + (rect.y + rect.h) * cr.height + 10
      if (y > sr.height - 64) y = cr.top - sr.top + rect.y * cr.height - 62
    }
    setBubble({ x: clamp(x, 80, sr.width - 80), y: clamp(y, 8, sr.height - 60) })
    window.clearTimeout(bubbleT.current)
    bubbleT.current = window.setTimeout(() => setBubble(null), 10_000)
  }
  const onFocusMsg = useRef<(d: ScreenFocus) => void>(() => {})
  onFocusMsg.current = (d) => {
    focRef.current = d
    setFoc(d)
    if (!d.kirjoitus) {
      setBubble(null)
      if (typingRef.current && !manual.current && Date.now() - optimistic.current > 1500) stopTyping()
      return
    }
    if (d.rect) editRect.current = d.rect
    if (typingRef.current) return setBubble(null)
    const recentTap = Date.now() - lastTap.current < 1500
    if (!IS_IOS && recentTap) {
      // Android / desktop: try straight away (the tap's user activation is usually still valid).
      openTyping(false)
      if (COARSE)
        window.setTimeout(() => {
          if (typingRef.current && !kbOpen()) {
            stopTyping()
            showBubble(d.rect)
          }
        }, 700)
      return
    }
    showBubble(d.rect)
  }

  // ---- frames + status from the bridge
  useEffect(() => {
    const onEv = (e: ScreenEvent) => {
      if (e.kind === 'frame') {
        const f = e.frame
        // Ack on arrival: the next frame travels while this one decodes.
        sendScreen({ type: 'naytto_kuittaus', seq: f.seq })
        lastFrame.current = Date.now()
        pending.current = f
        decodeNext()
        return
      }
      if (e.kind === 'fokus') return onFocusMsg.current(e.data)
      const d = e.data as { tila?: string; viesti?: string; naytot?: Mon[]; naytto?: number; palvelinAika?: number; perustila?: string | null }
      if (typeof d.palvelinAika === 'number') offset.current = d.palvelinAika - Date.now()
      if (d.tila === 'kaynnissa') {
        if (d.naytot) setMons(d.naytot)
        if (typeof d.naytto === 'number') setMon(d.naytto)
        if ('perustila' in d) setPerus(d.perustila ?? null)
        if (d.viesti) note('Näyttö', d.viesti, 'warn')
      } else if (d.tila === 'siirretty') {
        setTaken(true)
        setMsg(d.viesti ?? 'Ohjaus siirtyi toiselle laitteelle.')
      } else if (d.tila === 'virhe' || (d.tila === 'pysaytetty' && d.viesti)) {
        setStopped(true)
        setMsg(d.viesti ?? 'Näyttövirta pysähtyi.')
      }
    }
    watchScreen(onEv)
    const onVis = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      watchScreen(null)
      document.removeEventListener('visibilitychange', onVis)
      sendScreen({ type: 'naytto_lopeta' })
      const img = lastImg.current
      if (img && 'close' in img) img.close()
      lastImg.current = null
      window.clearTimeout(flushT.current)
      window.clearTimeout(uiTimer.current)
      window.clearTimeout(bubbleT.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- start / stop the stream with the page
  useEffect(() => {
    if (!want) {
      sendScreen({ type: 'naytto_lopeta' })
      stopTyping()
      setBubble(null)
      return
    }
    setMsg(null)
    const start = () => {
      if (!sendScreen({ type: 'naytto_aloita', fps, ...(mon != null ? { naytto: mon } : {}) })) setMsg('Ei yhteyttä JARVISiin — yritetään uudelleen…')
    }
    start()
    lastFrame.current = Date.now()
    // Watchdog: reconnect or a lost frame → ask again (a still screen is re-sent every 3 s by the bridge).
    const t = window.setInterval(() => {
      if (Date.now() - lastFrame.current > 8000) {
        lastFrame.current = Date.now()
        start()
      }
    }, 2000)
    // Real fps + delay in the corner, twice a second (not per frame: no re-render at 30 fps).
    const s = window.setInterval(() => {
      const now = Date.now()
      paints.current = paints.current.filter((x) => now - x < 2000)
      setStats({ fps: Math.round((paints.current.length / 2) * 10) / 10, viive: lastLat.current })
    }, 500)
    return () => {
      window.clearInterval(t)
      window.clearInterval(s)
    }
  }, [want, fps, mon])

  // ---- keyboard bar follows the on-screen keyboard
  useEffect(() => {
    if (!typing) return
    const vv = window.visualViewport
    if (!vv) return
    const f = () => setKbBottom(Math.max(0, Math.round(window.innerHeight - (vv.offsetTop + vv.height))))
    f()
    vv.addEventListener('resize', f)
    vv.addEventListener('scroll', f)
    return () => {
      vv.removeEventListener('resize', f)
      vv.removeEventListener('scroll', f)
    }
  }, [typing])

  // ---- full screen
  const showUi = () => {
    setUi(true)
    window.clearTimeout(uiTimer.current)
    uiTimer.current = window.setTimeout(() => setUi(false), 3000)
  }
  const enterFull = () => {
    hap()
    setFull(true)
    setMore(false)
    showUi()
    const de = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
    // iPhone Safari has no element full screen: the CSS view (and the home-screen app) covers it.
    if (!IS_IPHONE) {
      try {
        if (document.fullscreenEnabled && de.requestFullscreen) {
          de.requestFullscreen({ navigationUI: 'hide' })
            .then(() => {
              reqFs.current = true
              const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
              o?.lock?.('landscape').catch(() => {})
            })
            .catch(() => {})
        } else if (de.webkitRequestFullscreen) {
          de.webkitRequestFullscreen()
          reqFs.current = true
        }
      } catch {
        /* CSS view only */
      }
    }
    try {
      if (window.innerHeight > window.innerWidth && !localStorage.getItem('jv2.nkaanna')) {
        localStorage.setItem('jv2.nkaanna', '1')
        setHint(true)
        window.setTimeout(() => setHint(false), 2000)
      }
    } catch {
      /* ok */
    }
  }
  const exitFull = () => {
    hap()
    setFull(false)
    setKeysOpen(false)
    setHint(false)
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void }
    reqFs.current = false
    try {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      else if (d.webkitFullscreenElement) d.webkitExitFullscreen?.()
      ;(screen.orientation as ScreenOrientation & { unlock?: () => void })?.unlock?.()
    } catch {
      /* ok */
    }
  }
  useEffect(() => {
    if (!full) return
    const onFs = () => {
      const d = document as Document & { webkitFullscreenElement?: Element }
      if (reqFs.current && !document.fullscreenElement && !d.webkitFullscreenElement) {
        reqFs.current = false
        setFull(false)
        setKeysOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !typingRef.current && !reqFs.current) exitFull()
    }
    document.addEventListener('fullscreenchange', onFs)
    document.addEventListener('webkitfullscreenchange', onFs)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('fullscreenchange', onFs)
      document.removeEventListener('webkitfullscreenchange', onFs)
      window.removeEventListener('keydown', onKey)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full])
  useEffect(() => {
    if (!active && full) exitFull()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // ---- input helpers
  const norm = (cx: number, cy: number) => {
    const c = canvasRef.current
    if (!c) return null
    const r = contentRect(c, size.current.w, size.current.h)
    if (!r.width) return null
    const x = (cx - r.left) / r.width, y = (cy - r.top) / r.height
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x: +x.toFixed(4), y: +y.toFixed(4) }
  }
  const input = (o: Record<string, unknown>) => {
    if (!want) return
    hap(6)
    if (!sendScreen({ type: 'naytto_syote', ...o })) setMsg('Ei yhteyttä JARVISiin.')
  }
  const applyZ = () => {
    const v = viewRef.current, st = stageRef.current
    if (!v || !st) return
    const { s } = z.current
    const mx = ((s - 1) * st.clientWidth) / 2, my = ((s - 1) * st.clientHeight) / 2
    z.current.tx = clamp(z.current.tx, -mx, mx)
    z.current.ty = clamp(z.current.ty, -my, my)
    v.style.transform = `translate(${z.current.tx}px,${z.current.ty}px) scale(${s})`
  }
  const resetZ = () => {
    z.current = { s: 1, tx: 0, ty: 0 }
    applyZ()
  }
  const setStage = (el: HTMLDivElement | null) => {
    stageRef.current = el
    if (el) requestAnimationFrame(applyZ)
  }

  /** A tap on the last known text field opens the phone keyboard at once (same gesture → works on iOS). */
  const maybeType = (cx: number, cy: number) => {
    const p = norm(cx, cy), r = editRect.current
    if (!p || !r || typingRef.current) return
    const m = 0.01
    if (p.x < r.x - m || p.x > r.x + r.w + m || p.y < r.y - m || p.y > r.y + r.h + m) return
    optimistic.current = Date.now()
    openTyping(false)
    window.setTimeout(() => {
      // The tap missed the field after all (window moved): close again.
      if (typingRef.current && !manual.current && !focRef.current?.kirjoitus) stopTyping()
    }, 1800)
  }

  // tap / double-tap
  const pendingTap = useRef<{ t: number; x: number; y: number; timer: number } | null>(null)
  const tap = (cx: number, cy: number) => {
    const p = norm(cx, cy)
    if (!p) return
    lastTap.current = Date.now()
    rippleAt(cx, cy)
    const prev = pendingTap.current
    if (prev && Date.now() - prev.t < 280 && Math.hypot(prev.x - cx, prev.y - cy) < 30) {
      window.clearTimeout(prev.timer)
      pendingTap.current = null
      input({ tyyppi: 'tupla', ...p })
      return
    }
    const timer = window.setTimeout(() => {
      pendingTap.current = null
      input({ tyyppi: 'klikkaa', ...p })
    }, 280)
    pendingTap.current = { t: Date.now(), x: cx, y: cy, timer }
  }

  // pointer gestures
  const ptrs = useRef(new Map<number, { x: number; y: number; x0: number; y0: number; type: string; btn: number }>())
  const g = useRef({ moved: false, long: 0, longFired: false, mode: '' as '' | 'zoom' | 'scroll' | 'tri', d0: 0, s0: 1, cy0: 0, acc: 0, panX: 0, panY: 0 })
  const twoInfo = () => {
    const [a, b] = [...ptrs.current.values()]
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }
  const onDown = (e: RPointerEvent) => {
    // Keep the hidden field focused (desktop mouse would move focus to the page).
    if (typingRef.current) e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, type: e.pointerType, btn: e.button })
    const G = g.current
    if (full && ui) showUi()
    if (ptrs.current.size === 1) {
      G.moved = false
      G.longFired = false
      G.mode = ''
      G.panX = e.clientX
      G.panY = e.clientY
      window.clearTimeout(G.long)
      if (e.pointerType !== 'mouse') {
        const cx = e.clientX, cy = e.clientY
        G.long = window.setTimeout(() => {
          const p = norm(cx, cy)
          if (!p || G.moved) return
          G.longFired = true
          rippleAt(cx, cy)
          hap(25)
          input({ tyyppi: 'oikea', ...p })
        }, 550)
      }
    } else if (ptrs.current.size === 2) {
      window.clearTimeout(G.long)
      G.moved = true
      const t = twoInfo()
      G.d0 = t.d
      G.s0 = z.current.s
      G.cy0 = t.cy
      G.acc = 0
      G.mode = ''
    } else if (ptrs.current.size === 3) {
      // three fingers: toolbar back (full screen), never a click
      G.mode = 'tri'
      if (full) showUi()
    }
  }
  const onMove = (e: RPointerEvent) => {
    const p = ptrs.current.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    const G = g.current
    if (G.mode === 'tri') return
    if (ptrs.current.size === 2) {
      const t = twoInfo()
      const ratio = t.d / (G.d0 || 1)
      if (G.mode !== 'scroll' && (G.mode === 'zoom' || Math.abs(ratio - 1) > 0.08)) {
        G.mode = 'zoom'
        z.current.s = clamp(G.s0 * ratio, 1, 5)
        applyZ()
      } else if (G.mode === 'scroll' || Math.abs(t.cy - G.cy0) > 12) {
        G.mode = 'scroll'
        const dy = t.cy - G.cy0
        const steps = Math.trunc((dy - G.acc) / 40)
        if (steps) {
          G.acc += steps * 40
          const c = norm(t.cx, t.cy) ?? { x: 0.5, y: 0.5 }
          input({ tyyppi: 'vieritys', dy: -steps * 2, ...c })
        }
      }
      return
    }
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > (p.type === 'mouse' ? 6 : 10)) {
      G.moved = true
      window.clearTimeout(G.long)
    }
    if (p.type !== 'mouse' && G.moved && z.current.s > 1) {
      z.current.tx += e.clientX - G.panX
      z.current.ty += e.clientY - G.panY
      applyZ()
    }
    G.panX = e.clientX
    G.panY = e.clientY
  }
  const onUp = (e: RPointerEvent) => {
    const p = ptrs.current.get(e.pointerId)
    ptrs.current.delete(e.pointerId)
    const G = g.current
    window.clearTimeout(G.long)
    if (!p || ptrs.current.size > 0 || G.mode) {
      if (!ptrs.current.size) G.mode = ''
      return
    }
    if (p.type === 'mouse') {
      if (G.moved) {
        const a = norm(p.x0, p.y0), b = norm(e.clientX, e.clientY)
        if (a && b) input({ tyyppi: 'raahaa', x1: a.x, y1: a.y, x2: b.x, y2: b.y })
        return
      }
      if (p.btn === 2) {
        const q = norm(e.clientX, e.clientY)
        if (q) {
          rippleAt(e.clientX, e.clientY)
          input({ tyyppi: 'oikea', ...q })
        }
        return
      }
      if (p.btn === 0) {
        maybeType(e.clientX, e.clientY)
        tap(e.clientX, e.clientY)
      }
      return
    }
    if (!G.moved && !G.longFired) {
      maybeType(e.clientX, e.clientY)
      tap(e.clientX, e.clientY)
    }
  }
  // wheel: scroll on the PC; ctrl+wheel (trackpad pinch) zooms the view
  const wheelAcc = useRef({ v: 0, t: 0 })
  useEffect(() => {
    const st = stageRef.current
    if (!st) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey) {
        z.current.s = clamp(z.current.s * (e.deltaY < 0 ? 1.1 : 0.9), 1, 5)
        applyZ()
        return
      }
      const w = wheelAcc.current
      w.v += e.deltaY
      if (Date.now() - w.t < 120) return
      const steps = Math.trunc(w.v / 100) || Math.sign(w.v)
      w.v = 0
      w.t = Date.now()
      const c = norm(e.clientX, e.clientY)
      if (c && steps) input({ tyyppi: 'vieritys', dy: clamp(steps, -10, 10), ...c })
    }
    st.addEventListener('wheel', onWheel, { passive: false })
    return () => st.removeEventListener('wheel', onWheel)
  })

  const restart = () => {
    hap()
    setTaken(false)
    setStopped(false)
    setPaused(false)
    setMsg(null)
  }
  const chooseFps = (v: FpsSel) => {
    setFps(v)
    try {
      localStorage.setItem('jv2.nfps2', String(v))
    } catch {
      /* ok */
    }
  }
  const live = want && hasFrame
  const corner = live ? `${stats.fps} FPS · ${stats.viive} MS` : fpsLabel(fps)

  const stage: ReactNode = (
    <div
      ref={setStage}
      className="scr-stage"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
      role="application"
      aria-label="Koneen näyttö: napauta = klikkaus"
    >
      <div ref={viewRef} className="scr-view">
        <canvas ref={setCanvas} className={hasFrame ? '' : 'none'} />
      </div>
      {!live ? (
        <div className="scr-msg">
          <div>{msg ?? (taken ? 'Ohjaus siirtyi toiselle laitteelle.' : stopped ? 'Näyttövirta pysäytetty.' : paused ? 'Tauko — kuva ei päivity.' : 'Yhdistetään näyttöön…')}</div>
          {taken || stopped ? (
            <button className="btn pri" onPointerDown={(e) => e.stopPropagation()} onClick={restart}>
              {taken ? 'OTA OHJAUS TAKAISIN' : 'KÄYNNISTÄ'}
            </button>
          ) : null}
        </div>
      ) : null}
      <span className="br b1" />
      <span className="br b2" />
      <span className="br b3" />
      <span className="br b4" />
      <div className="scr-ov">
        <span className={live ? 'rec' : ''}>{live ? '● LIVE' : '○'}</span>
        <span>
          {corner}
          {perus ? <em className="scr-perus"> · {perus.toUpperCase()}</em> : null}
        </span>
      </div>
      {bubble && !typing && want ? (
        <button
          className="scr-bubble"
          style={{ left: bubble.x, top: bubble.y }}
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onClick={() => openTyping(false)}
        >
          ⌨ Kirjoita{foc?.salasana ? ' (salasana)' : ''}
        </button>
      ) : null}
    </div>
  )

  const work = typeof document !== 'undefined' && Boolean(document.querySelector('.hud2.work'))
  const fullView = full
    ? createPortal(
        <div className={`hud2 scr-full${work ? ' work' : ''}`}>
          {stage}
          {ui && !typing ? (
            <div className="scr-tb" onPointerDown={showUi}>
              <button className="btn sm" onClick={() => openTyping(true)} disabled={!want} aria-label="Näppäimistö">
                ⌨
              </button>
              <button className="btn sm" aria-pressed={keysOpen} onClick={() => (hap(), setKeysOpen(!keysOpen))} aria-label="Näppäimet">
                NÄPP. ▾
              </button>
              <button className="btn sm" onClick={() => (hap(), chooseFps(FPS_OPTS[(FPS_OPTS.indexOf(fps) + 1) % FPS_OPTS.length]))} aria-label="Kuvanopeus">
                {fpsLabel(fps)}
              </button>
              <button className="btn sm" onClick={() => (hap(), setPaused(!paused))} disabled={stopped || taken} aria-label={paused ? 'Jatka' : 'Tauko'}>
                <Ic n={paused ? 'play' : 'pause'} />
              </button>
              <button className="btn sm" onClick={resetZ} aria-label="Zoom 1:1">
                1:1
              </button>
              <button className="btn sm red" onClick={exitFull} aria-label="Poistu koko näytöstä">
                ✕
              </button>
            </div>
          ) : null}
          {ui && keysOpen && !typing ? (
            <div className="scr-tkeys" onPointerDown={showUi}>
              {FULL_KEYS.map(([k, l]) => (
                <button key={k} className="btn sm" onClick={() => input({ tyyppi: 'nappain', nappi: k })} disabled={!want}>
                  {l}
                </button>
              ))}
            </div>
          ) : null}
          {!ui && !typing ? (
            <button className="scr-handle" onClick={showUi} aria-label="Näytä työkalut">
              ⋯
            </button>
          ) : null}
          {hint ? <div className="scr-hint">Käännä puhelin vaakaan</div> : null}
        </div>,
        document.body,
      )
    : null

  // Hidden field + "Kirjoitat koneelle" bar live outside the HUD (fixed to the page, never inside a moving pager).
  const typeLayer = createPortal(
    <>
      <input
        ref={typeRef}
        className="jv-typein"
        type="text"
        defaultValue={SENT}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect={foc?.salasana ? 'off' : 'on'}
        spellCheck={false}
        enterKeyHint="enter"
        aria-label="Kirjoitus koneelle"
        tabIndex={-1}
        onFocus={() => {
          typingRef.current = true
          setTyping(true)
          setBubble(null)
        }}
        onBlur={() => {
          syncValue()
          flush()
          typingRef.current = false
          manual.current = false
          setTyping(false)
        }}
        onInput={syncValue}
        onCompositionEnd={syncValue}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            syncValue()
            queueOp({ k: 'key', key: 'enter' })
          } else if (DOC_KEYS[e.key]) {
            e.preventDefault()
            syncValue()
            queueOp({ k: 'key', key: DOC_KEYS[e.key] })
          }
        }}
      />
      {typing ? (
        <div className="jv-typebar" style={{ bottom: kbBottom }} onPointerDown={(e) => e.preventDefault()} onMouseDown={(e) => e.preventDefault()}>
          <span className="jv-tt">{foc?.salasana ? '🔒 salasanakenttä' : '⌨ Kirjoitat koneelle'}</span>
          <button onClick={() => queueOp({ k: 'key', key: 'vasen' })} aria-label="Vasen">
            ←
          </button>
          <button onClick={() => queueOp({ k: 'key', key: 'oikea' })} aria-label="Oikea">
            →
          </button>
          <button onClick={() => queueOp({ k: 'key', key: 'tab' })} aria-label="Tab">
            ⇥
          </button>
          <button className="jv-done" onClick={stopTyping}>
            Valmis
          </button>
        </div>
      ) : null}
    </>,
    document.body,
  )

  return (
    <div className="pgi g-screen">
      <Pnl n="16" title="NÄYTTÖ · OHJAUS" right={live ? <span className="live">LIVE</span> : <span>{taken ? 'TOISELLA LAITTEELLA' : stopped ? 'PYSÄYTETTY' : paused ? 'TAUKO' : 'ODOTTAA'}</span>} className="wide" i={0}>
        <div className="scr-frame">{full ? <div className="scr-stage scr-ghost">Koko näyttö päällä</div> : stage}</div>
        <div className="scr-bar">
          <button className="btn sm pri scr-fullbtn" onClick={enterFull}>
            <span aria-hidden="true">⛶</span> KOKO NÄYTTÖ
          </button>
          <button className="btn sm" aria-pressed={typing} onClick={() => (typing ? stopTyping() : openTyping(true))} disabled={!want}>
            <Ic n="key" />
            KIRJOITA
          </button>
          <button className="btn sm" onClick={() => (hap(), setPaused(!paused))} disabled={stopped || taken}>
            <Ic n={paused ? 'play' : 'pause'} />
            {paused ? 'JATKA' : 'TAUKO'}
          </button>
          <button className="btn sm red" onClick={() => (hap(), setStopped(true), setMsg('Näyttövirta pysäytetty.'))} disabled={stopped}>
            LOPETA
          </button>
        </div>
        <div className="scr-keys">
          {KEYS.map(([k, l]) => (
            <button key={k} className="btn sm" onClick={() => input({ tyyppi: 'nappain', nappi: k })} disabled={!want}>
              {l}
            </button>
          ))}
          <button className="btn sm" onClick={resetZ}>
            1:1
          </button>
        </div>
        <button className="btn sm wide" style={{ marginTop: 10 }} aria-expanded={more} onClick={() => (hap(), setMore(!more))}>
          {more ? 'PIILOTA LISÄÄ' : '⋯ LISÄÄ: ASETUKSET JA ELEET'}
        </button>
        {more ? (
          <div className="setgrid" style={{ marginTop: 12 }}>
            <div>
              <div className="lbl" style={{ marginTop: 0 }}>
                KUVANOPEUS
              </div>
              <Seg opts={FPS_OPTS.map((v) => ({ v, label: v === 'auto' ? 'Auto' : String(v) }))} value={fps} label="Kuvanopeus" onChange={(v) => chooseFps(v)} />
            </div>
            {mons.length > 1 ? (
              <div>
                <div className="lbl" style={{ marginTop: 0 }}>
                  NÄYTTÖ
                </div>
                <Seg opts={mons.map((m) => ({ v: m.i, label: `${m.i + 1}${m.ensisijainen ? ' ★' : ''}` }))} value={mon} label="Näyttö" onChange={(v) => (setMon(v as number), resetZ())} />
              </div>
            ) : null}
            <p className="sub">Napauta = klikkaus · pitkä painallus = oikea klikkaus · kaksoisnapautus = tuplaklikkaus · kaksi sormea = vieritys · nipistys = zoom · koko näytössä kolme sormea = työkalut esiin.</p>
            <p className="sub">Kun napautat koneen tekstikenttää, näppäimistö aukeaa (iPhonessa napauta "⌨ Kirjoita" -kuplaa). Auto säätää kuvanopeuden ja tarkkuuden yhteyden mukaan.</p>
            <p className="sub">iPhone: Safari → Jaa → Lisää Koti-valikkoon, niin JARVIS aukeaa ilman Safarin palkkeja (PIN kysytään kerran uudelleen).</p>
            <p className="sub">Yksinomaisessa koko näytön tilassa oleva peli voi näkyä mustana — se on normaalia tällä kuvaustavalla.</p>
          </div>
        ) : null}
      </Pnl>
      {fullView}
      {typeLayer}
    </div>
  )
}
