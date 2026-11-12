/**
 * Dot globe on one 2D canvas (ported from the approved prototype): Fibonacci points, land blobs, graticule,
 * HUD rings, home marker and service arcs. Rotation follows the page-swipe progress; on the Koti page it sits in
 * the hero slot, elsewhere it drifts to the background. DPR ≤ 2, half frame rate after 4 s idle, nothing drawn
 * while the tab is hidden.
 */
import { getSettings, globeHooks, useHud } from './core'

/** Shared, per-frame state written by the page swiper (no React re-render per scroll frame). */
export const PG = { prog: 0, sysIdx: -1, need: true }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)
type V3 = [number, number, number]
const xyz = (lat: number, lon: number): V3 => {
  lat *= Math.PI / 180
  lon *= Math.PI / 180
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)]
}

const BLOBS = [[50,-100,22],[42,-95,15],[60,-120,15],[64,-150,9],[30,-102,9],[20,-100,7],[14,-88,4],[55,-73,12],[68,-100,12],[72,-80,8],[47,-66,5],
 [72,-42,10],[78,-40,7],[-10,-60,16],[0,-66,12],[-24,-60,11],[-37,-66,7],[-48,-70,5],[6,-70,7],[-6,-40,6],
 [50,10,9],[45,14,5],[40,-4,6],[55,24,9],[62,15,6],[64,26,6],[53,-2,3.5],[57,-4,2.5],[44,24,5],
 [10,12,15],[0,22,14],[-14,25,12],[-27,25,8],[20,4,13],[25,25,10],[8,40,7],[30,0,8],[-19,46,4],
 [56,90,24],[46,72,14],[35,104,15],[62,128,15],[66,160,10],[22,78,8],[14,77,5],[28,48,10],[22,45,6],[16,102,7],[38,138,3.5],[43,142,2.5],[40,128,3],[68,70,10],[72,105,9],
 [-2,114,5],[-4,138,5],[-6,106,3],[12,123,3],[-25,134,13],[-32,146,6],[-18,128,6],[-42,172,3],[-80,0,1]]
const B3 = BLOBS.map(([la, lo, r]) => {
  const p = xyz(la, lo)
  return [p[0], p[1], p[2], Math.cos((r * Math.PI) / 180)]
})
function isLand(x: number, y: number, z: number) {
  if (y < -0.94) return true
  const nz = Math.sin(x * 9 + z * 5) * Math.cos(y * 11 - x * 4) * 0.012
  for (const b of B3) if (x * b[0] + y * b[1] + z * b[2] > b[3] - nz) return true
  return false
}
const HOME = xyz(62, 25.5)
const NODES = [{ n: 'CLAUDE', p: xyz(37.8, -122.4) }, { n: 'TUYA', p: xyz(50.1, 8.7) }, { n: 'TELEGRAM', p: xyz(52.4, 4.9) }, { n: 'NTFY', p: xyz(48.8, 2.3) }]
const ARCS = NODES.map((nd) => {
  const a = HOME, b = nd.p
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const om = Math.acos(clamp(dot, -1, 1)), so = Math.sin(om) || 1
  const pts: V3[] = []
  for (let i = 0; i <= 40; i++) {
    const t = i / 40, k1 = Math.sin((1 - t) * om) / so, k2 = Math.sin(t * om) / so, h = 1 + Math.sin(Math.PI * t) * (0.08 + om * 0.12)
    pts.push([(a[0] * k1 + b[0] * k2) * h, (a[1] * k1 + b[1] * k2) * h, (a[2] * k1 + b[2] * k2) * h])
  }
  return { n: nd.n, pts, end: b }
})

export type GlobeApi = {
  setMode: (work: boolean) => void
  setAccent: (rgb: [number, number, number]) => void
  setHero: (el: HTMLElement | null) => void
  measureHero: () => void
  flip: () => void
  touch: () => void
  dirty: () => void
  rebuild: () => void
  /** Called each animation frame before drawing (page transforms, dock indicator). */
  onFrame: (fn: (() => void) | null) => void
  /** Stop drawing while any reason is on (vertical page scroll, chat sheet, keyboard); redraws once when cleared. */
  pause: (reason: string, on: boolean) => void
  destroy: () => void
}

export function createGlobe(cv: HTMLCanvasElement): GlobeApi {
  const ctx = cv.getContext('2d')!
  const G = {
    w: 0, h: 0, dpr: 1, n: 0,
    X: new Float32Array(0), Y: new Float32Array(0), Z: new Float32Array(0), L: new Uint8Array(0),
    grat: [] as V3[][], dirty: true, pulse: 0, flipT: -1e9,
    hero: null as null | { x: number; y: number; s: number }, heroEl: null as HTMLElement | null,
    work: false, acc: [79, 227, 255] as [number, number, number],
  }
  let frameHook: (() => void) | null = null
  const paused = new Set<string>()
  let lastIn = performance.now(), frame = 0, fpsN = 0, fpsT = performance.now(), raf = 0, alive = true

  function build() {
    const N = [1400, 2600, 4000][getSettings().q] ?? 2600
    G.n = N
    G.X = new Float32Array(N); G.Y = new Float32Array(N); G.Z = new Float32Array(N); G.L = new Uint8Array(N)
    for (let i = 0; i < N; i++) {
      const y = 1 - (2 * (i + 0.5)) / N, r = Math.sqrt(1 - y * y), th = i * 2.399963229728653
      const x = Math.cos(th) * r, z = Math.sin(th) * r
      G.X[i] = x; G.Y[i] = y; G.Z[i] = z; G.L[i] = isLand(x, y, z) ? 1 : 0
    }
    G.grat = []
    for (let la = -60; la <= 60; la += 30) {
      const l: V3[] = []
      for (let lo = -180; lo <= 180; lo += 6) l.push(xyz(la, lo))
      G.grat.push(l)
    }
    for (let lo = -180; lo < 180; lo += 30) {
      const l: V3[] = []
      for (let la = -90; la <= 90; la += 6) l.push(xyz(la, lo))
      G.grat.push(l)
    }
    G.dirty = true
  }
  function measureHero() {
    const h = G.heroEl
    if (!h || !h.offsetParent) {
      G.hero = null
      return
    }
    const pg = h.closest('.page') as HTMLElement | null
    const r = h.getBoundingClientRect()
    const pr = pg ? pg.getBoundingClientRect() : ({ left: 0 } as DOMRect)
    G.hero = { x: r.left - pr.left + r.width / 2, y: r.top + r.height / 2, s: Math.min(r.width, r.height) }
    G.dirty = true
  }
  function resize() {
    G.dpr = Math.min(devicePixelRatio || 1, getSettings().q === 0 ? 1.25 : 2)
    G.w = innerWidth
    G.h = innerHeight
    cv.width = Math.round(G.w * G.dpr)
    cv.height = Math.round(G.h * G.dpr)
    G.dirty = true
    measureHero()
  }

  function draw(now: number) {
    const c = ctx, d = G.dpr, W = G.w, H = G.h, fxl = getSettings().fx
    c.setTransform(d, 0, 0, d, 0, 0)
    c.clearRect(0, 0, W, H)
    const work = G.work, mob = W < 980
    const pIdx = PG.prog
    const kk = ease(work ? 0 : clamp(1 - pIdx, 0, 1))
    const bg = work
      ? { x: mob ? W * 0.5 : W * 0.74, y: mob ? H * 0.46 : H * 0.52, R: Math.min(W, H) * (mob ? 0.52 : 0.4), a: mob ? 0.32 : 0.55 }
      : { x: W * 0.5, y: H * (mob ? 0.5 : 0.55), R: Math.min(W, H) * (mob ? 0.62 : 0.52), a: 0.32 }
    let hx = bg.x, hy = bg.y, hR = bg.R
    if (G.hero && !work) {
      hx = G.hero.x
      hy = G.hero.y
      hR = G.hero.s * (mob ? 0.4 : 0.36)
    }
    const cx = hx + (bg.x - hx) * (1 - kk), cy = hy + (bg.y - hy) * (1 - kk), R = hR + (bg.R - hR) * (1 - kk)
    const alpha = kk + bg.a * (1 - kk)
    const ft = clamp((now - G.flipT) / 1100, 0, 1), flip = (1 - ease(ft)) * Math.PI
    const drift = fxl === 2 ? Math.sin(now / 9000) * 0.1 : 0
    const lam = (-25.5 * Math.PI) / 180 - pIdx * 1.15 + drift + flip, cl = Math.cos(lam), sl = Math.sin(lam)
    const tilt = ((work ? 14 : 22) * Math.PI) / 180, ct = Math.cos(tilt), st = Math.sin(tilt)
    const rgb = G.acc.join(','), red = '255,61,74'
    const pu = G.pulse
    if (G.pulse > 0) G.pulse = Math.max(0, G.pulse - 0.02)
    const A = alpha * (1 + pu * 0.6)
    // atmosphere
    const g = c.createRadialGradient(cx, cy, R * 0.75, cx, cy, R * 1.3)
    g.addColorStop(0, `rgba(${rgb},0)`)
    g.addColorStop(0.55, `rgba(${rgb},${0.1 * A})`)
    g.addColorStop(1, `rgba(${rgb},0)`)
    c.fillStyle = g
    c.beginPath(); c.arc(cx, cy, R * 1.3, 0, 6.2832); c.fill()
    c.fillStyle = work ? `rgba(0,0,0,${0.6 * alpha})` : `rgba(2,10,22,${0.55 * alpha})`
    c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.fill()
    // graticule
    c.lineWidth = 1
    const front = new Path2D(), back = new Path2D()
    for (const ln of G.grat) {
      let pf = false, pb = false
      for (const p of ln) {
        const x = p[0] * cl + p[2] * sl, z0 = p[2] * cl - p[0] * sl, y = p[1] * ct - z0 * st, z = p[1] * st + z0 * ct
        const sx = cx + x * R, sy = cy - y * R
        if (z >= 0) {
          if (pf) front.lineTo(sx, sy)
          else front.moveTo(sx, sy)
          pf = true
          pb = false
        } else {
          if (pb) back.lineTo(sx, sy)
          else back.moveTo(sx, sy)
          pb = true
          pf = false
        }
      }
    }
    c.strokeStyle = `rgba(${rgb},${0.05 * A})`; c.stroke(back)
    c.strokeStyle = `rgba(${rgb},${0.2 * A})`; c.stroke(front)
    // dots
    const X = G.X, Y = G.Y, Z = G.Z, L = G.L, n = G.n, ds = Math.max(1, R / 210)
    const buckets: number[][] = [[], [], [], []]
    const oce: number[] = [], bk: number[] = []
    for (let i = 0; i < n; i++) {
      const x = X[i] * cl + Z[i] * sl, z0 = Z[i] * cl - X[i] * sl, y = Y[i] * ct - z0 * st, z = Y[i] * st + z0 * ct
      const sx = cx + x * R, sy = cy - y * R
      if (L[i]) {
        if (z > 0) buckets[Math.min(3, (z * 4) | 0)].push(sx, sy, z)
        else if (z > -0.9 && i & 1) bk.push(sx, sy)
      } else if (z > 0 && (work || i % 3 === 0)) oce.push(sx, sy, z)
    }
    c.fillStyle = `rgba(${rgb},${0.07 * A})`
    for (let i = 0; i < bk.length; i += 2) c.fillRect(bk[i], bk[i + 1], ds, ds)
    c.fillStyle = `rgba(${rgb},${(work ? 0.22 : 0.12) * A})`
    for (let i = 0; i < oce.length; i += 3) {
      const s = ds * (0.8 + oce[i + 2] * 0.6)
      c.fillRect(oce[i] - s / 2, oce[i + 1] - s / 2, s, s)
    }
    for (let b = 0; b < 4; b++) {
      const arr = buckets[b]
      c.fillStyle = `rgba(${rgb},${(0.32 + b * 0.22) * A})`
      for (let i = 0; i < arr.length; i += 3) {
        const s = ds * (1.3 + arr[i + 2] * 1.5)
        c.fillRect(arr[i] - s / 2, arr[i + 1] - s / 2, s, s)
      }
    }
    const proj = (p: V3): V3 => {
      const x = p[0] * cl + p[2] * sl, z0 = p[2] * cl - p[0] * sl, y = p[1] * ct - z0 * st, z = p[1] * st + z0 * ct
      return [cx + x * R, cy - y * R, z]
    }
    // rim
    c.strokeStyle = `rgba(${rgb},${0.55 * A})`; c.lineWidth = 1.2
    c.beginPath(); c.arc(cx, cy, R, 0, 6.2832); c.stroke()
    // HUD rings
    const ringR = R * 1.1, rot = lam * 0.9
    c.lineWidth = 1; c.strokeStyle = `rgba(${rgb},${0.35 * alpha})`
    c.beginPath()
    for (let i = 0; i < 120; i++) {
      const a = rot + (i * Math.PI) / 60, l = i % 10 === 0 ? 10 : 4, ca = Math.cos(a), sa = Math.sin(a)
      c.moveTo(cx + ca * ringR, cy + sa * ringR)
      c.lineTo(cx + ca * (ringR + l), cy + sa * (ringR + l))
    }
    c.stroke()
    if (fxl > 0) {
      const r2 = R * 1.2, tt = now / 6000
      c.lineWidth = 2; c.strokeStyle = `rgba(${rgb},${0.5 * alpha})`
      for (let i = 0; i < 3; i++) {
        c.beginPath(); c.arc(cx, cy, r2, -tt + i * 2.094, -tt + i * 2.094 + 0.7); c.stroke()
      }
      c.lineWidth = 1; c.strokeStyle = `rgba(${work ? red : rgb},${0.4 * alpha})`
      c.beginPath(); c.arc(cx, cy, R * 1.27, tt * 1.4, tt * 1.4 + 0.35); c.stroke()
    }
    // service arcs (stronger on the JÄRJESTELMÄ page)
    const sysK = PG.sysIdx >= 0 ? clamp(1 - Math.abs(pIdx - PG.sysIdx), 0, 1) : 0
    const arcA = (0.22 + 0.78 * sysK) * alpha
    for (let j = 0; j < ARCS.length; j++) {
      const ar = ARCS[j]
      c.beginPath()
      let started = false
      for (const p of ar.pts) {
        const q = proj(p)
        if (q[2] > -0.05) {
          if (started) c.lineTo(q[0], q[1])
          else {
            c.moveTo(q[0], q[1])
            started = true
          }
        } else started = false
      }
      c.strokeStyle = `rgba(${rgb},${0.45 * arcA})`; c.lineWidth = 1; c.stroke()
      const tt = (now / 2600 + j * 0.27) % 1, q = proj(ar.pts[Math.floor(tt * 40)])
      if (q[2] > 0) {
        c.fillStyle = `rgba(${rgb},${arcA})`
        c.beginPath(); c.arc(q[0], q[1], 2.2, 0, 6.2832); c.fill()
      }
      const e = proj(ar.end)
      if (e[2] > 0 && sysK > 0.3) {
        c.fillStyle = `rgba(${rgb},${0.9 * arcA})`
        c.font = '10px "Share Tech Mono",monospace'
        c.fillText(ar.n, e[0] + 6, e[1] - 4)
        c.fillRect(e[0] - 2, e[1] - 2, 4, 4)
      }
    }
    // home marker
    const h = proj(HOME)
    if (h[2] > 0) {
      const col = work ? red : rgb, ph = (now % 1800) / 1800
      c.strokeStyle = `rgba(${col},${(1 - ph) * alpha})`; c.lineWidth = 1.5
      c.beginPath(); c.arc(h[0], h[1], 4 + ph * 18, 0, 6.2832); c.stroke()
      c.fillStyle = `rgba(${col},${alpha})`
      c.beginPath(); c.arc(h[0], h[1], 3.2, 0, 6.2832); c.fill()
      if (kk > 0.2 || work) {
        c.strokeStyle = `rgba(${col},${0.7 * alpha})`; c.lineWidth = 1
        c.beginPath(); c.moveTo(h[0], h[1]); c.lineTo(h[0] + 26, h[1] - 26); c.lineTo(h[0] + 74, h[1] - 26); c.stroke()
        c.fillStyle = `rgba(${col},${alpha})`
        c.font = '600 12px Rajdhani,Bahnschrift,sans-serif'
        c.fillText(work ? 'KALUSTOVAHTI' : 'KOTI', h[0] + 30, h[1] - 31)
      }
    }
  }

  function loop(now: number) {
    if (!alive) return
    raf = requestAnimationFrame(loop)
    if (document.hidden) return
    frame++
    frameHook?.()
    if (paused.size) return
    const fxl = getSettings().fx
    const idle = now - lastIn > 4000, flipping = now - G.flipT < 1200
    if (fxl === 0 && !G.dirty && !flipping) return
    if (!flipping && (idle || fxl === 1) && frame & 1) return
    draw(now)
    G.dirty = false
    fpsN++
    if (now - fpsT > 1000) {
      useHud.setState({ fps: Math.round((fpsN * 1000) / (now - fpsT)) })
      fpsN = 0
      fpsT = now
    }
  }

  const touch = () => {
    lastIn = performance.now()
  }
  const onResize = () => {
    resize()
    PG.need = true
  }
  const evs = ['pointerdown', 'wheel', 'keydown'] as const
  evs.forEach((ev) => addEventListener(ev, touch, { passive: true }))
  addEventListener('resize', onResize)
  globeHooks.pulse = () => {
    G.pulse = 1
  }
  build()
  resize()
  raf = requestAnimationFrame(loop)
  document.fonts?.ready.then(() => {
    measureHero()
    G.dirty = true
  })

  return {
    setMode: (work) => {
      G.work = work
      G.dirty = true
    },
    setAccent: (rgb) => {
      G.acc = rgb
      G.dirty = true
    },
    setHero: (el) => {
      G.heroEl = el
      measureHero()
    },
    measureHero,
    flip: () => {
      G.flipT = performance.now()
    },
    touch,
    dirty: () => {
      G.dirty = true
    },
    rebuild: () => {
      build()
      resize()
    },
    onFrame: (fn) => {
      frameHook = fn
    },
    pause: (reason, on) => {
      if (on) paused.add(reason)
      else if (paused.delete(reason) && !paused.size) G.dirty = true
    },
    destroy: () => {
      alive = false
      cancelAnimationFrame(raf)
      evs.forEach((ev) => removeEventListener(ev, touch))
      removeEventListener('resize', onResize)
      globeHooks.pulse = () => {}
    },
  }
}
