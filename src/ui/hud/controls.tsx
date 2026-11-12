/** HUD controls: panel frame, dial, mini gauge, segmented control, toggle and filled range. */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { hap, getSettings } from './core'
import { Ic } from './icons'

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/**
 * Live value while dragging, at most every `ms` (leading + trailing), so a lamp follows the finger without a flood.
 * `last()` is the value last sent live, so the release can skip an identical final send.
 */
function useThrottle(fn: ((v: number, el: HTMLElement) => void) | undefined, ms = 300) {
  const st = useRef({ at: 0, timer: 0, v: NaN, sent: NaN, el: null as HTMLElement | null })
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => () => window.clearTimeout(st.current.timer), [])
  const fire = () => {
    const s = st.current
    s.timer = 0
    s.at = performance.now()
    if (s.el && s.v !== s.sent) {
      s.sent = s.v
      fnRef.current?.(s.v, s.el)
    }
  }
  return {
    push(v: number, el: HTMLElement) {
      if (!fnRef.current) return
      const s = st.current
      s.v = v
      s.el = el
      const wait = ms - (performance.now() - s.at)
      if (wait <= 0) fire()
      else if (!s.timer) s.timer = window.setTimeout(fire, wait)
    },
    /** Drag ended: drop any pending live send and report what was last sent. */
    end(): number {
      const s = st.current
      window.clearTimeout(s.timer)
      s.timer = 0
      const sent = s.sent
      s.sent = NaN
      return sent
    },
  }
}

export function Pnl({ n, title, right, className = '', i = 0, children, id }: { n: string; title: ReactNode; right?: ReactNode; className?: string; i?: number; children: ReactNode; id?: string }) {
  return (
    <section className={`pnl ${className}`} style={{ ['--i' as string]: i } as CSSProperties} id={id}>
      <div className="ph">
        <b>{n}</b> {title}
        <span className="bar" />
        {right}
      </div>
      {children}
    </section>
  )
}

export function Tog({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean, el: HTMLElement) => void; label: string; disabled?: boolean }) {
  return <button className="tog" aria-pressed={on} aria-label={label} disabled={disabled} onClick={(e) => onChange(!on, e.currentTarget)} />
}

export type SegOpt<T> = { v: T; label: ReactNode; icon?: string }
export function Seg<T extends string | number>({ opts, value, onChange, className = '', label }: { opts: SegOpt<T>[]; value: T | null | undefined; onChange: (v: T, el: HTMLElement) => void; className?: string; label?: string }) {
  return (
    <div className={`seg ${className}`} role="group" aria-label={label}>
      {opts.map((o) => (
        <button
          key={String(o.v)}
          aria-pressed={o.v === value}
          onClick={(e) => {
            if (o.v === value) return
            hap()
            onChange(o.v, e.currentTarget)
          }}
        >
          {o.icon ? <Ic n={o.icon} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Range with an accent fill. onCommit fires on release (change), onInput while dragging (local only), onLive
 *  sends while dragging at most every 300 ms. */
export function Range({ min, max, step = 1, value, onInput, onLive, onCommit, className = '', label, disabled }: { min: number; max: number; step?: number; value: number; onInput?: (v: number) => void; onLive?: (v: number, el: HTMLElement) => void; onCommit: (v: number, el: HTMLElement) => void; className?: string; label: string; disabled?: boolean }) {
  const [v, setV] = useState(value)
  const dragging = useRef(false)
  const live = useThrottle(onLive)
  useEffect(() => {
    if (!dragging.current) setV(value)
  }, [value])
  const p = ((v - min) / (max - min || 1)) * 100
  return (
    <input
      type="range"
      className={`rng ${className}`}
      min={min}
      max={max}
      step={step}
      value={v}
      disabled={disabled}
      aria-label={label}
      style={{ ['--p' as string]: p + '%' } as CSSProperties}
      onPointerDown={() => (dragging.current = true)}
      onInput={(e) => {
        const n = Number((e.target as HTMLInputElement).value)
        setV(n)
        onInput?.(n)
        if (dragging.current) live.push(n, e.currentTarget as HTMLElement)
      }}
      onChange={(e) => {
        dragging.current = false
        const n = Number(e.target.value)
        setV(n)
        if (live.end() !== n) onCommit(n, e.currentTarget)
      }}
    />
  )
}

/** Mini gauge (270° arc). */
export function MiniGauge({ frac, txt, label, sub, color, onClick, style }: { frac: number; txt: string; label: string; sub?: string; color?: string; onClick?: () => void; style?: CSSProperties }) {
  const ticks = useMemo(() => {
    let k = ''
    for (let i = 0; i <= 36; i++) {
      const a = ((-135 + (270 * i) / 36) * Math.PI) / 180, r1 = 46, r2 = i % 9 === 0 ? 40 : 43
      k += `M${(50 + r1 * Math.sin(a)).toFixed(1)} ${(50 - r1 * Math.cos(a)).toFixed(1)}L${(50 + r2 * Math.sin(a)).toFixed(1)} ${(50 - r2 * Math.cos(a)).toFixed(1)}`
    }
    return k
  }, [])
  const body = (
    <>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <path className="k" d={ticks} />
        <circle className="t" cx="50" cy="50" r="34" pathLength={100} strokeDasharray="75 100" transform="rotate(135 50 50)" />
        <circle className="v" cx="50" cy="50" r="34" pathLength={100} strokeDasharray={`${(clamp(frac, 0, 1) * 75).toFixed(1)} 100`} transform="rotate(135 50 50)" style={color ? { stroke: color } : undefined} />
      </svg>
      <div className="c">
        <b>{txt}</b>
        <small>{label}</small>
        <em>{sub ?? ''}</em>
      </div>
    </>
  )
  return onClick ? (
    <button className="mg" onClick={onClick} style={style} aria-label={`${label}: ${txt}`}>
      {body}
    </button>
  ) : (
    <div className="mg" style={style}>
      {body}
    </div>
  )
}

type DialProps = {
  min: number
  max: number
  step: number
  tick: number
  major: number
  labels?: boolean
  value: number
  unit: string
  label: string
  small?: boolean
  off?: boolean
  color?: string
  disabled?: boolean
  fmt?: (v: number) => string
  /** Fires once the user lets go (~450 ms debounce for wheel/keys/±). */
  onCommit: (v: number, el: HTMLElement) => void
  /** Optional: sent while dragging, at most every 300 ms (lamps). Not given for IR (ILP): that sends on release only. */
  onLive?: (v: number, el: HTMLElement) => void
}

/** Rotary dial: drag, wheel, arrow keys or ±. Commits after release; onLive (if given) follows the finger, throttled. */
export function Dial(o: DialProps) {
  const SZ = 240, C = SZ / 2, R = C - 28, A0 = -135, SW = 270
  const host = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [v, setV] = useState(o.value)
  const [st, setSt] = useState('')
  const drag = useRef(false)
  const deb = useRef(0)
  const start = useRef(o.value)
  const vRef = useRef(o.value)
  vRef.current = v
  const live = useThrottle(o.onLive)
  useEffect(() => {
    if (drag.current || deb.current) return
    setV(o.value)
    start.current = o.value
  }, [o.value])
  useEffect(() => () => window.clearTimeout(deb.current), [])

  const pt = (a: number, r: number): [number, number] => [C + r * Math.sin((a * Math.PI) / 180), C - r * Math.cos((a * Math.PI) / 180)]
  const arc = (a1: number, a2: number, r: number) => {
    if (a2 - a1 < 0.5) return ''
    const p = pt(a1, r), q = pt(a2, r)
    return `M${p[0].toFixed(2)} ${p[1].toFixed(2)}A${r} ${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${q[0].toFixed(2)} ${q[1].toFixed(2)}`
  }
  const deco = useMemo(() => {
    const n = Math.round((o.max - o.min) / o.tick)
    const tk: ReactNode[] = []
    const tl: ReactNode[] = []
    for (let i = 0; i <= n; i++) {
      const a = A0 + (SW * i) / n, mj = i % o.major === 0
      const p = pt(a, R + 10), q = pt(a, R + (mj ? 22 : 15))
      tk.push(<line key={i} className={`dl-tk${mj ? ' mj' : ''}`} x1={p[0].toFixed(1)} y1={p[1].toFixed(1)} x2={q[0].toFixed(1)} y2={q[1].toFixed(1)} />)
      if (mj && o.labels !== false) {
        const l = pt(a, R - 20)
        tl.push(
          <text key={i} className="dl-tl" x={l[0].toFixed(1)} y={l[1].toFixed(1)}>
            {o.min + i * o.tick}
          </text>,
        )
      }
    }
    return { tk, tl }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.min, o.max, o.tick, o.major, o.labels])

  const snap = (x: number) => +clamp(Math.round((x - o.min) / o.step) * o.step + o.min, o.min, o.max).toFixed(2)
  const setVal = (x: number) => {
    const n = snap(x)
    if (n !== vRef.current) {
      vRef.current = n
      setV(n)
      if (getSettings().hap) hap(4)
    }
  }
  const commitSoon = (ms = 450) => {
    setSt('· · ·')
    window.clearTimeout(deb.current)
    deb.current = window.setTimeout(() => {
      deb.current = 0
      setSt('')
      const sentLive = live.end()
      if (vRef.current !== start.current) {
        start.current = vRef.current
        if (sentLive !== vRef.current) o.onCommit(vRef.current, host.current!)
      }
    }, ms)
  }
  // The dial's box is read once per drag (pointerdown), not on every move: a layout read per pointer event is a
  // forced reflow per frame while the value text re-renders.
  const box = useRef<DOMRect | null>(null)
  const fromEvt = (e: { clientX: number; clientY: number }) => {
    const r = box.current ?? svg.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * SZ - C, y = ((e.clientY - r.top) / r.height) * SZ - C
    const a = clamp((Math.atan2(x, -y) * 180) / Math.PI, -135, 135)
    setVal(o.min + ((a - A0) / SW) * (o.max - o.min))
    if (drag.current && host.current) live.push(vRef.current, host.current)
  }
  useEffect(() => {
    // Wheel needs passive:false to keep the page from scrolling while adjusting.
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (o.disabled) return
      e.preventDefault()
      setVal(vRef.current + (e.deltaY < 0 ? o.step : -o.step))
      commitSoon()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const t = (v - o.min) / (o.max - o.min), a = A0 + SW * t, d = arc(A0, a, R), k = pt(a, R)
  const stroke = o.off ? undefined : o.color
  return (
    <div ref={host} className={`dial${o.small ? ' sm' : ''}${o.off ? ' off' : ''}${o.disabled ? ' dis' : ''}`}>
      <svg
        ref={svg}
        viewBox={`0 0 ${SZ} ${SZ}`}
        role="slider"
        tabIndex={0}
        aria-label={o.label}
        aria-valuemin={o.min}
        aria-valuemax={o.max}
        aria-valuenow={v}
        onPointerDown={(e) => {
          if (o.disabled) return
          drag.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          box.current = e.currentTarget.getBoundingClientRect()
          fromEvt(e)
          setSt('SÄÄDÄ')
        }}
        onPointerMove={(e) => drag.current && fromEvt(e)}
        onPointerUp={() => {
          if (!drag.current) return
          drag.current = false
          box.current = null
          commitSoon(120)
        }}
        onPointerCancel={() => {
          if (!drag.current) return
          drag.current = false
          box.current = null
          commitSoon(120)
        }}
        onKeyDown={(e) => {
          const dd = ({ ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 } as Record<string, number>)[e.key]
          if (dd && !o.disabled) {
            e.preventDefault()
            e.stopPropagation()
            setVal(vRef.current + dd * o.step)
            commitSoon()
          }
        }}
      >
        <circle className="dl-spin" cx={C} cy={C} r={R - 36} />
        <circle className="dl-in" cx={C} cy={C} r={R - 8} />
        <g>{deco.tk}</g>
        {deco.tl}
        <path className="dl-track" d={arc(A0, A0 + SW, R)} />
        <path className="dl-glow" d={d} style={stroke ? { stroke } : undefined} />
        <path className="dl-val" d={d} style={stroke ? { stroke } : undefined} />
        <circle className="dl-knob" r="8" cx={k[0]} cy={k[1]} />
      </svg>
      <div className="dl-c">
        <div className="dl-v">{o.fmt ? o.fmt(v) : v}</div>
        <div className="dl-u">{o.unit}</div>
        <div className="dl-s">{st}</div>
      </div>
      <button
        className="dl-b dl-m"
        aria-label="Pienennä"
        disabled={o.disabled}
        onClick={() => {
          setVal(vRef.current - o.step)
          commitSoon()
        }}
      >
        −
      </button>
      <button
        className="dl-b dl-p"
        aria-label="Suurenna"
        disabled={o.disabled}
        onClick={() => {
          setVal(vRef.current + o.step)
          commitSoon()
        }}
      >
        +
      </button>
    </div>
  )
}
