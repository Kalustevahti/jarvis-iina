/**
 * JARVIS 2.0 shell: dot-globe background, header, horizontal scroll-snap pages (light 3D tilt while swiping,
 * scan sweep + panel stagger when a page settles), dock with a moving indicator and the mic in the middle,
 * arrow keys and mouse drag-to-swipe. Each page has its own #hash.
 */
import { createContext, Suspense, useContext, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createGlobe, PG, type GlobeApi } from './globe'
import { getSettings, hap, hsl2rgb, setFxLayer, useHud } from './core'
import { Ic } from './icons'

export type PageDef = { key: string; title: string; short: string; icon: string; render: (active: boolean) => ReactNode }

type Nav = { goKey: (k: string) => void; globe: () => GlobeApi | null; activeKey: string }
const NavCtx = createContext<Nav>({ goKey: () => {}, globe: () => null, activeKey: '' })
export const useNav = () => useContext(NavCtx)

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const pad = (n: number) => String(n).padStart(2, '0')

function Clock() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setT(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return <div className="clock">{`${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`}</div>
}

function Toasts() {
  const toasts = useHud((s) => s.toasts)
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.st === 'ok' ? ' ok mini' : t.st === 'warn' ? ' warn' : t.st === 'err' ? ' err' : ' mini'}${t.out ? ' out' : ''}`}>
          <b>{t.title}</b>
          <code>{t.code}</code>
          <span className="ts">{t.ts}</span>
        </div>
      ))}
    </div>
  )
}

function scramble(el: HTMLElement | null, txt: string) {
  if (!el) return
  if (getSettings().fx === 0) {
    el.textContent = txt
    return
  }
  const ch = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖ0123456789#/'
  let f = 0
  const step = () => {
    f++
    el.textContent = txt
      .split('')
      .map((c, i) => (c === ' ' ? ' ' : i < f * 1.6 ? c : ch[(Math.random() * ch.length) | 0]))
      .join('')
    if (f * 1.6 < txt.length) requestAnimationFrame(step)
    else el.textContent = txt
  }
  step()
}

export function Shell({
  work,
  pages,
  link,
  onMic,
  micOn,
  onSwitchMode,
  startKey,
  still = false,
  children,
}: {
  work: boolean
  pages: PageDef[]
  link: { dot: '' | 'a' | 'r'; text: string }
  onMic: () => void
  micOn: boolean
  onSwitchMode: () => void
  startKey?: string
  /** A sheet or full-screen view covers the pages: the globe stops drawing. */
  still?: boolean
  children?: ReactNode
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const cvRef = useRef<HTMLCanvasElement>(null)
  const pagesRef = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLSpanElement>(null)
  const indRef = useRef<HTMLSpanElement>(null)
  const fxRef = useRef<HTMLDivElement>(null)
  const globe = useRef<GlobeApi | null>(null)
  const [idx, setIdx] = useState(-1)
  const lastIdx = useRef(-1)
  const settings = useHud((s) => s.settings)
  const pagesNow = useRef(pages)
  pagesNow.current = pages
  // Pages are mounted when first near (current ± 1) or jumped to, then kept: the first paint renders two or three
  // pages instead of all of them, and lazily loaded pages (NÄYTTÖ, Työ) download only when needed.
  const startIdx = Math.max(0, pages.findIndex((p) => p.key === (startKey ?? '')))
  const [seen, setSeen] = useState<ReadonlySet<number>>(() => new Set([startIdx - 1, startIdx, startIdx + 1]))
  const see = (...is: number[]) => setSeen((s) => (is.every((i) => s.has(i)) ? s : new Set([...s, ...is])))

  // ---- globe lifecycle
  useEffect(() => {
    if (!cvRef.current) return
    const g = createGlobe(cvRef.current)
    globe.current = g
    try {
      if (sessionStorage.getItem('jv2.flip') === '1') {
        sessionStorage.removeItem('jv2.flip')
        g.flip()
      }
    } catch {
      /* no session storage */
    }
    return () => g.destroy()
  }, [])
  useEffect(() => {
    globe.current?.setMode(work)
  }, [work])

  // ---- accent hue (Koti only; Työ is black/white/red)
  useLayoutEffect(() => {
    const r = rootRef.current?.style
    if (!r) return
    const vars = ['--acc', '--acc2', '--line', '--line2', '--glow']
    if (!work) {
      const h = settings.hue
      const acc = hsl2rgb(h, 100, 65)
      r.setProperty('--acc', `rgb(${acc})`)
      r.setProperty('--acc2', `rgb(${hsl2rgb(h, 100, 88)})`)
      r.setProperty('--line', `hsla(${h},100%,80%,.18)`)
      r.setProperty('--line2', `hsla(${h},100%,80%,.42)`)
      r.setProperty('--glow', `0 0 18px hsla(${h},100%,65%,.35)`)
      globe.current?.setAccent(acc)
    } else {
      vars.forEach((v) => r.removeProperty(v))
      globe.current?.setAccent([245, 245, 245])
    }
  }, [work, settings.hue])
  useEffect(() => {
    globe.current?.rebuild()
  }, [settings.q])

  // ---- fx layer
  useEffect(() => {
    setFxLayer(fxRef.current)
    return () => setFxLayer(null)
  }, [])

  // ---- globe stops while a sheet / full view covers the pages, or the on-screen keyboard is up
  useEffect(() => {
    globe.current?.pause('sheet', still)
  }, [still])
  useEffect(() => {
    const typing = (el: EventTarget | null) => el instanceof HTMLElement && el.matches('input:not([type=range]):not([type=checkbox]),textarea')
    const onIn = (e: FocusEvent) => typing(e.target) && globe.current?.pause('keys', true)
    const onOut = () => globe.current?.pause('keys', false)
    addEventListener('focusin', onIn)
    addEventListener('focusout', onOut)
    return () => {
      removeEventListener('focusin', onIn)
      removeEventListener('focusout', onOut)
    }
  }, [])

  // ---- page geometry, per frame
  // Layout is read once (mount, resize, page list change), never inside the per-frame swipe update: reading
  // getBoundingClientRect right after writing transforms forced a full layout on every frame of a swipe.
  const geo = useRef<{ secs: HTMLElement[]; btns: HTMLButtonElement[]; x: number[]; w: number[]; pw: number }>({ secs: [], btns: [], x: [], w: [], pw: 1 })
  const measure = () => {
    const P = pagesRef.current
    const btns = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('.dk button') ?? [])
    const base = indRef.current?.parentElement?.getBoundingClientRect()
    geo.current = {
      secs: Array.from(P?.querySelectorAll<HTMLElement>(':scope > .page') ?? []),
      btns,
      x: btns.map((b) => b.getBoundingClientRect().left - (base?.left ?? 0)),
      w: btns.map((b) => b.getBoundingClientRect().width),
      pw: P?.clientWidth || 1,
    }
    PG.need = true
  }
  const lastNi = useRef(-1)
  const apply = () => {
    const P = pagesRef.current
    if (!P) return
    const g = geo.current
    PG.prog = P.scrollLeft / g.pw
    const fx3d = getSettings().fx === 2
    g.secs.forEach((p, i) => {
      const inn = p.firstElementChild as HTMLElement | null
      if (!inn) return
      const d = i - PG.prog
      if (Math.abs(d) < 1.05 && fx3d && Math.abs(d) > 0.001) {
        inn.style.transform = `perspective(1400px) rotateY(${(-d * 24).toFixed(2)}deg) translateZ(${(-Math.abs(d) * 140).toFixed(1)}px)`
        inn.style.opacity = (1 - Math.min(1, Math.abs(d)) * 0.7).toFixed(3)
      } else if (inn.style.transform) {
        inn.style.transform = ''
        inn.style.opacity = ''
      }
    })
    const n = g.btns.length
    const a = clamp(Math.floor(PG.prog), 0, n - 1), b = Math.min(n - 1, a + 1), f = PG.prog - a
    const ind = indRef.current
    if (ind && n) {
      ind.style.transform = `translateX(${(g.x[a] + (g.x[b] - g.x[a]) * f).toFixed(1)}px)`
      ind.style.width = (g.w[a] + (g.w[b] - g.w[a]) * f).toFixed(1) + 'px'
    }
    const ni = Math.round(PG.prog)
    if (ni !== lastNi.current) {
      lastNi.current = ni
      g.btns.forEach((bt, i) => bt.setAttribute('aria-current', String(i === ni)))
    }
  }
  useLayoutEffect(() => {
    measure()
    addEventListener('resize', measure)
    document.fonts?.ready.then(measure).catch(() => {})
    return () => removeEventListener('resize', measure)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length, work])
  useEffect(() => {
    globe.current?.onFrame(() => {
      if (PG.need) {
        apply()
        PG.need = false
      }
    })
    return () => globe.current?.onFrame(null)
  })

  const settle = () => {
    const P = pagesRef.current
    if (!P) return
    const i = Math.round(P.scrollLeft / (P.clientWidth || 1))
    if (i === lastIdx.current) return
    lastIdx.current = i
    const def = pagesNow.current[i]
    if (!def) return
    setIdx(i)
    see(i - 1, i, i + 1)
    scramble(titleRef.current, def.title)
    try {
      history.replaceState(null, '', '#' + def.key)
    } catch {
      /* file:// or sandboxed */
    }
    const sec = geo.current.secs[i]
    if (getSettings().fx > 0 && sec && fxRef.current) {
      const s = document.createElement('div')
      s.className = 'scanfx'
      fxRef.current.appendChild(s)
      window.setTimeout(() => s.remove(), 720)
      sec.classList.remove('enter')
      void sec.offsetWidth
      sec.classList.add('enter')
    }
    window.setTimeout(() => globe.current?.measureHero(), 30)
  }
  const settleT = useRef(0)
  const goPage = (i: number, instant?: boolean) => {
    const P = pagesRef.current
    if (!P) return
    i = clamp(i, 0, pagesNow.current.length - 1)
    see(i)
    P.scrollTo({ left: i * P.clientWidth, behavior: instant || getSettings().fx === 0 ? 'auto' : 'smooth' })
  }
  const goKey = (k: string) => {
    const i = pagesNow.current.findIndex((p) => p.key === k)
    if (i >= 0) {
      hap()
      goPage(i)
    }
  }

  // ---- initial page (hash) + sys index
  useEffect(() => {
    PG.sysIdx = pages.findIndex((p) => p.key === 'jarvis')
    PG.need = true
  }, [pages])
  useEffect(() => {
    const k = startKey ?? ''
    const i = pages.findIndex((p) => p.key === k)
    requestAnimationFrame(() => {
      if (i > 0) goPage(i, true)
      requestAnimationFrame(() => {
        apply()
        settle()
      })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- input: scroll, keys, mouse drag
  useEffect(() => {
    const P = pagesRef.current
    if (!P) return
    const onScroll = () => {
      PG.need = true
      globe.current?.dirty()
      globe.current?.touch()
      window.clearTimeout(settleT.current)
      settleT.current = window.setTimeout(settle, 110)
    }
    P.addEventListener('scroll', onScroll, { passive: true })
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t?.closest?.('input,textarea,select,[role=slider],.ovl,.sheet.on,.scr-stage')) return
      const cur = Math.round(PG.prog)
      if (e.key === 'ArrowRight') goPage(cur + 1)
      if (e.key === 'ArrowLeft') goPage(cur - 1)
    }
    addEventListener('keydown', onKey)
    let sx = 0, sl = 0, on = false, moved = false
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return
      if ((e.target as HTMLElement).closest('button,input,select,textarea,svg,a,.joy,.inp,.log,.res,.hx-legacy,.scr-stage,.camf')) return
      on = true
      moved = false
      sx = e.clientX
      sl = P.scrollLeft
    }
    const move = (e: PointerEvent) => {
      if (!on) return
      const dx = e.clientX - sx
      if (!moved && Math.abs(dx) > 6) {
        moved = true
        P.classList.add('drag')
      }
      if (moved) P.scrollLeft = sl - dx
    }
    const up = (e: PointerEvent) => {
      if (!on) return
      on = false
      if (!moved) return
      P.classList.remove('drag')
      const dx = e.clientX - sx, w = P.clientWidth
      let i = Math.round(sl / w)
      if (dx < -60) i++
      else if (dx > 60) i--
      goPage(i)
    }
    P.addEventListener('pointerdown', down)
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    const onResize = () => {
      // keep the current page aligned after rotation / resize
      const i = Math.max(0, lastIdx.current)
      P.scrollLeft = i * P.clientWidth
    }
    addEventListener('resize', onResize)
    return () => {
      P.removeEventListener('scroll', onScroll)
      removeEventListener('keydown', onKey)
      P.removeEventListener('pointerdown', down)
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('resize', onResize)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // hero = the Koti page's hero slot (exists once that page is mounted)
  const heroPage = useRef<Element | null>(null)
  useEffect(() => {
    const hero = pagesRef.current?.querySelector<HTMLElement>('[data-hero]') ?? null
    heroPage.current = hero?.closest('.page') ?? null
    globe.current?.setHero(hero)
  }, [pages.length, seen])

  // Vertical page scroll: the globe stops drawing until the scroll ends. On the hero page the globe sits in the
  // hero slot, so the canvas is moved with the content (a compositor-only transform) and redrawn in place after.
  useEffect(() => {
    const P = pagesRef.current
    const cv = cvRef.current
    if (!P || !cv) return
    let t = 0
    let from = -1
    let el: HTMLElement | null = null
    const end = () => {
      cv.style.transform = ''
      from = -1
      globe.current?.measureHero()
      globe.current?.pause('scroll', false)
    }
    const onS = (e: Event) => {
      const tgt = e.target as HTMLElement
      if (tgt === P || !tgt.classList?.contains('page')) return
      if (from < 0 || el !== tgt) {
        el = tgt
        from = tgt.scrollTop
        globe.current?.pause('scroll', true)
      }
      if (tgt === heroPage.current && PG.prog < 0.02) cv.style.transform = `translate3d(0,${from - tgt.scrollTop}px,0)`
      window.clearTimeout(t)
      t = window.setTimeout(end, 140)
    }
    P.addEventListener('scroll', onS, { passive: true, capture: true })
    return () => {
      P.removeEventListener('scroll', onS, { capture: true })
      window.clearTimeout(t)
    }
  }, [])

  const half = Math.ceil(pages.length / 2)
  const dockBtn = (p: PageDef, i: number) => (
    <button key={p.key} aria-current={i === idx} onClick={() => (hap(), goPage(i))} aria-label={p.title}>
      <Ic n={p.icon} />
      <span>{p.short}</span>
    </button>
  )
  const activeKey = pages[idx]?.key ?? ''
  return (
    <NavCtx.Provider value={{ goKey, globe: () => globe.current, activeKey }}>
      <div ref={rootRef} className={`hud2${work ? ' work' : ''}${settings.fx === 0 ? ' fx0' : ''}`}>
        <canvas ref={cvRef} className="globe" aria-hidden="true" />
        <header className="top">
          <div className="brand">
            <div className="core" />
            <div>
              <b>JARVIS</b>
              <small>{work ? 'TYÖ · KALUSTOVAHTI' : 'KOTI · HOLO-HUD 2.0'}</small>
            </div>
          </div>
          <div className="ttl">
            <i />
            <span ref={titleRef}>{pages[Math.max(0, idx)]?.title ?? ''}</span>
            <i />
          </div>
          <div className="hr">
            <div className="link">
              <span className={`dot ${link.dot}`} />
              <span>{link.text}</span>
            </div>
            <Clock />
            <div className="modesw" role="group" aria-label="Tila">
              <button aria-pressed={!work} onClick={() => work && onSwitchMode()}>
                KOTI
              </button>
              <button aria-pressed={work} onClick={() => !work && onSwitchMode()}>
                TYÖ
              </button>
            </div>
          </div>
        </header>

        <main ref={pagesRef} className="pages">
          {pages.map((p, i) => (
            <section key={p.key} className="page" data-key={p.key} aria-label={p.title} style={{ ['--pi' as string]: i } as CSSProperties}>
              <div className="pgi-wrap">{seen.has(i) ? <Suspense fallback={<div className="pgi pg-wait">LADATAAN…</div>}>{p.render(i === idx)}</Suspense> : null}</div>
            </section>
          ))}
        </main>

        <div ref={fxRef} className="fxl" />
        <Toasts />

        <nav className="dock" aria-label="Sivut">
          <div className="dk">
            {pages.slice(0, half).map((p, i) => dockBtn(p, i))}
            <span ref={indRef} className="ind" />
          </div>
          <button className={`mic${micOn ? ' on' : ''}`} onClick={onMic} aria-label="Puhu JARVISille">
            <Ic n="mic" />
          </button>
          <div className="dk">{pages.slice(half).map((p, i) => dockBtn(p, i + half))}</div>
        </nav>
        {children}
      </div>
    </NavCtx.Provider>
  )
}
