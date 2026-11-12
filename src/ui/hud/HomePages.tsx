/**
 * Koti pages (KOTI, ILMA & VALO, VIIHDE, TURVA & IMURI) on real data: state from the bridge's koti_tila
 * (koti.mjs), commands through the same 'laite' tools the old Koti/Laitteet views use.
 * Controls with no backend yet (ILP timer, camera zoom/privacy/motion/snapshot, TV text input, vacuum rooms and
 * suction) are deliberately not shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { request, watchHome } from '../../lib/brain'
import { BRIDGE_HTTP_URL } from '../../config'
import { ctColor, fx, hap, note, runTool, useHud, type FxType, type RunOpts } from './core'
import { Dial, MiniGauge, Pnl, Range, Seg, Tog } from './controls'
import { Ic } from './icons'
import { useNav } from './Shell'

/** paivitetty/kesto: when the bridge last read the device and how long it took (koti.mjs cache). haetaan: not read yet. */
type Part = { asennettu: boolean; virhe?: string; haetaan?: boolean; paivitetty?: number; kesto?: number }
type Lamp = { nimi: string; online: boolean; paalla: boolean | null; kirkkaus?: number | null; vari?: boolean }
export type Koti = {
  at: number
  valot: Part & { lista?: Lamp[] }
  /** heraa: the bridge is waking it up (projektori_virta paalle running) — presses queue until it is awake. */
  projektori: Part & { tila?: string; sovellus?: string; toisto?: string; aani?: number | null; heraa?: boolean }
  samsung: Part & { tila?: string }
  imuri: Part & { tila?: string; akku?: number | null; siivoaa?: boolean; virhe?: string }
  ilp: Part & { virta?: boolean | null; lampotila?: number; tila?: string; puhallus?: string; at?: number }
  kamera: Part & { kamerat?: string[] }
}
type Reply = { text: string; koti?: Koti; kamerat?: string[]; avain?: string }

const errText = (err: unknown) => String((err as Error)?.message ?? err)
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const pad = (n: number) => String(n).padStart(2, '0')
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

// ---------------------------------------------------------------- state hook
type DevKey = 'valot' | 'projektori' | 'samsung' | 'imuri' | 'ilp'
type LoadOpts = { pakota?: boolean; odota?: boolean; laite?: DevKey }
const PART_KEYS = ['valot', 'projektori', 'samsung', 'imuri', 'ilp', 'kamera'] as const
const recordDevices = (parts: Partial<Koti>) => {
  const add: Record<string, { t: number; kesto: number | null }> = {}
  for (const key of PART_KEYS) {
    const p = parts[key] as Part | undefined
    if (p?.paivitetty) add[key] = { t: p.paivitetty, kesto: p.kesto ?? null }
  }
  if (Object.keys(add).length) useHud.setState((s) => ({ devLat: { ...s.devLat, ...add } }))
}

export type Home = ReturnType<typeof useHome>
/**
 * Home state (9.11.2026, nopeus): koti_tila answers from the bridge's cache at once, and each device's new state is
 * pushed as it arrives (watchHome). Controls are optimistic: `command` shows the new state immediately, holds back
 * older pushes for that device while the command runs, then re-reads only that device; on failure the last
 * confirmed state comes back.
 */
export function useHome(enabled = true) {
  const [k, setK] = useState<Koti | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [camOpen, setCamOpen] = useState(false)
  const kRef = useRef<Koti | null>(null)
  kRef.current = k
  /** Server clock − local clock, so "päivitetty N s sitten" is right even if the phone's clock is off. */
  const skew = useRef(0)

  // Per-device optimistic hold: commands in flight, confirm timer, and the last confirmed part to fall back to.
  const busy = useRef<Record<string, number>>({})
  const confirmT = useRef<Record<string, number>>({})
  const confirming = useRef<Record<string, boolean>>({})
  const base = useRef<Record<string, unknown>>({})
  const held = (key: string) => (busy.current[key] ?? 0) > 0 || confirmT.current[key] != null || Boolean(confirming.current[key])

  /** Merge parts from a poll or a push; a held device keeps its optimistic state (the part becomes its fallback). */
  const merge = useCallback((parts: Partial<Koti>, force: readonly string[] = []) => {
    setK((prev) => {
      const next = { ...(prev ?? ({ at: Date.now() } as Koti)) } as Record<string, unknown>
      for (const key of PART_KEYS) {
        const p = parts[key] as Part | undefined
        if (!p) continue
        const had = prev?.[key] as Part | undefined
        if (p.haetaan && had && !had.haetaan) continue // never replace data with the "not read yet" placeholder
        // A confirm read (force) wins over the hold, unless yet another command for the device is already running.
        if (held(key) && !(force.includes(key) && !(busy.current[key] > 0))) {
          base.current[key] = p
          continue
        }
        next[key] = p
      }
      if (parts.at) next.at = parts.at
      // The first answer must have every part (the pages read k.valot etc. directly).
      return PART_KEYS.every((key) => key in next) ? (next as Koti) : prev
    })
    recordDevices(parts)
  }, [])

  const load = useCallback(
    async (o: boolean | LoadOpts = {}): Promise<Koti | null> => {
      const opts = typeof o === 'boolean' ? { pakota: o } : o
      const t0 = performance.now()
      try {
        const r = await request<Reply>('laite', { tyokalu: 'koti_tila', args: opts }, opts.odota ? 40_000 : 20_000)
        useHud.setState({ homeLat: { ms: Math.round(performance.now() - t0), t: Date.now() } })
        if (r.koti) {
          skew.current = r.koti.at - Date.now()
          merge(r.koti, opts.laite ? [opts.laite] : [])
        }
        setErr(null)
        return r.koti ?? null
      } catch (e) {
        setErr(/Tuntematon|kotitoiminto/i.test(errText(e)) ? 'Koti-näkymä vaatii JARVISin uudelleenkäynnistyksen ("uudelleen").' : `Tilaa ei saatu: ${errText(e)}`)
        return null
      }
    },
    [merge],
  )
  useEffect(() => {
    if (!enabled) return
    void load()
    const t = window.setInterval(() => void load(), 60_000)
    const onUp = () => void load()
    window.addEventListener('jarvis-connected', onUp)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('jarvis-connected', onUp)
    }
  }, [enabled, load])
  // Pushed device updates (also in Työ mode, for the JÄRJESTELMÄ page).
  useEffect(
    () =>
      watchHome((p) => {
        if ((PART_KEYS as readonly string[]).includes(p.laite)) merge({ [p.laite]: p.tila } as Partial<Koti>)
      }),
    [merge],
  )

  /** After a command: re-read only that device, once, shortly after the last command for it has answered. */
  const confirm = useCallback(
    (key: DevKey, delay: number) => {
      window.clearTimeout(confirmT.current[key])
      confirmT.current[key] = window.setTimeout(async () => {
        delete confirmT.current[key]
        if ((busy.current[key] ?? 0) > 0) return // a newer command will confirm
        confirming.current[key] = true
        const fresh = await load({ laite: key, pakota: key !== 'ilp', odota: key !== 'ilp' }).finally(() => (confirming.current[key] = false))
        if (!held(key) && !fresh) {
          // Could not read it back: show the last confirmed state rather than a guess.
          const b = base.current[key]
          if (b) setK((p) => (p ? { ...p, [key]: b } : p))
        }
      }, delay)
    },
    [load],
  )
  const later = useCallback(() => void window.setTimeout(() => void load({ pakota: true }), 1500), [load])

  /**
   * Optimistic command: `apply` changes the screen now; the tool runs in the background; failure → back to the last
   * confirmed state + error toast; success → that one device is re-read after a short delay.
   */
  const command = (key: DevKey, tyokalu: string, args: Record<string, unknown>, o: RunOpts, apply?: (k: Koti) => Koti) => {
    if (!held(key) && kRef.current) base.current[key] = kRef.current[key]
    busy.current[key] = (busy.current[key] ?? 0) + 1
    if (apply) setK((p) => (p ? apply(p) : p))
    const done = runTool(tyokalu, args, {
      ...o,
      onFail: () => {
        const b = base.current[key]
        if (b) setK((p) => (p ? { ...p, [key]: b } : p))
      },
    })
    // Resolves both when the command ran and when a newer one superseded it (coalesce), so the hold always ends.
    void done.then(() => {
      busy.current[key] = Math.max(0, (busy.current[key] ?? 1) - 1)
      confirm(key, key === 'ilp' ? 0 : 1200)
    })
    return done
  }
  const ageOf = (p?: Part) => (p?.paivitetty ? Math.max(0, Date.now() + skew.current - p.paivitetty) : null)

  // ---- ILP: always the full state (power, mode, temp, wind) like the real remote
  const ilp = {
    on: Boolean(k?.ilp.virta),
    known: k?.ilp.virta != null,
    temp: k?.ilp.lampotila ?? 21,
    mode: k?.ilp.tila ?? 'puhallus',
    fan: k?.ilp.puhallus ?? 'auto',
  }
  const ilpSend = (next: { on: boolean; temp: number; mode: string; fan: string }, label: string, el?: Element | null) => {
    const f: FxType = !next.on ? 'power' : next.mode === 'jäähdytys' ? 'cool' : next.mode === 'lämmitys' ? 'heat' : 'light'
    void command('ilp', 'ir_lampopumppu', { virta: next.on, lampotila: next.temp, tila: next.mode, puhallus: next.fan }, { label, fx: f, el, key: 'ilp', coalesce: true, ms: 30_000 }, (p) => ({
      ...p,
      ilp: { ...p.ilp, virta: next.on, lampotila: next.temp, tila: next.mode, puhallus: next.fan },
    }))
  }
  /** Lights with an optimistic lamp update (fn applied to every lamp, or only `nimi`). */
  const lights = (args: Record<string, unknown>, o: RunOpts, fn?: (l: Lamp) => Lamp) =>
    void command('valot', 'valo_aseta', args, { coalesce: true, ms: 30_000, ...o }, fn ? (p) => ({ ...p, valot: { ...p.valot, lista: (p.valot.lista ?? []).map(fn) } }) : undefined)
  return { k, kRef, err, load, later, command, lights, ageOf, ilp, ilpSend, camOpen, setCamOpen }
}

/** "päivitetty 12 s sitten" for one device; ticks on its own so the page does not re-render. */
export function Age({ home, part }: { home: Home; part?: Part }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 5000)
    return () => window.clearInterval(t)
  }, [])
  const ms = home.ageOf(part)
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  return <span className="age">päivitetty {s < 5 ? 'juuri nyt' : s < 90 ? `${s} s sitten` : `${Math.round(s / 60)} min sitten`}</span>
}

// ---------------------------------------------------------------- device summaries
type DevId = 'valot' | 'ilp' | 'projektori' | 'samsung' | 'imuri' | 'kamera'
const DEV_NAME: Record<DevId, string> = { valot: 'Valot', ilp: 'Lämpöpumppu', projektori: 'Projektori', samsung: 'Samsung TV', imuri: 'Imuri', kamera: 'Kamera' }
const DEV_ICON: Record<DevId, string> = { valot: 'bulb', ilp: 'air', projektori: 'film', samsung: 'tv', imuri: 'bot', kamera: 'cam' }
const DEV_PAGE: Record<DevId, string> = { valot: 'ilma', ilp: 'ilma', projektori: 'viihde', samsung: 'viihde', imuri: 'turva', kamera: 'turva' }
const INSTALL: Record<DevId, string> = { valot: 'asenna_valot.bat', ilp: 'asenna_valot.bat', projektori: 'asenna_projektori.bat', samsung: 'asenna_telkkari.bat', imuri: 'asenna_imuri.bat', kamera: 'asenna_kamera.bat' }

function devView(id: DevId, k: Koti | null, camLive: boolean): { on: boolean; ok: boolean; state: string } {
  if (!k) return { on: false, ok: false, state: 'Haetaan…' }
  const p = k[id] as Part
  if (!p?.asennettu) return { on: false, ok: false, state: 'Ei yhdistetty' }
  if (p.haetaan) return { on: false, ok: true, state: 'Haetaan…' }
  if (p.virhe && id !== 'imuri') return { on: false, ok: true, state: 'Ei vastaa juuri nyt' }
  switch (id) {
    case 'valot': {
      const l = k.valot.lista ?? []
      const on = l.filter((x) => x.paalla)
      const b = on.map((x) => x.kirkkaus).filter((x): x is number => typeof x === 'number')
      return { on: on.length > 0, ok: true, state: on.length ? `${on.length} päällä${b.length ? ` · ${Math.max(...b)} %` : ''}` : l.length ? 'Kaikki pois' : 'Ei lamppuja' }
    }
    case 'ilp':
      if (k.ilp.virta == null) return { on: false, ok: true, state: 'Ei vielä asetettu täältä' }
      return { on: !!k.ilp.virta, ok: true, state: k.ilp.virta ? `${cap(k.ilp.tila ?? 'auto')} ${k.ilp.lampotila ?? 21}° · viimeksi asetettu` : 'Pois · viimeksi asetettu' }
    case 'projektori': {
      const t = k.projektori.tila
      return { on: t === 'paalla', ok: true, state: t === 'paalla' ? k.projektori.sovellus || 'Päällä' : t === 'valmiustila' ? 'Valmiustila' : 'Pois / syvä valmiustila' }
    }
    case 'samsung': {
      const t = k.samsung.tila
      return { on: t === 'paalla', ok: true, state: t === 'paalla' ? 'Päällä' : t === 'valmiustila' ? 'Valmiustila' : 'Pois' }
    }
    case 'imuri': {
      const v = k.imuri
      return { on: !!v.siivoaa, ok: true, state: `${v.virhe ? v.virhe : cap(v.tila ?? '')}${v.akku != null ? ` · ${v.akku} %` : ''}` }
    }
    case 'kamera':
      return { on: camLive, ok: true, state: camLive ? 'Live auki' : (k.kamera.kamerat ?? []).join(', ') || 'Kamera' }
  }
}

const ROUTINES = [
  { id: 'leffailta', n: 'Leffailta', ic: 'film', d: 'Projektori + Netflix, valot pois, näyttö kiinni' },
  { id: 'hyvaa_yota', n: 'Hyvää yötä', ic: 'moon', d: 'Projektori valmiustilaan, kone lukkoon' },
  { id: 'huomenta', n: 'Huomenta', ic: 'sun', d: 'Päivän tapaamiset ja putken asiat' },
  { id: 'nukkumaan', n: 'Nukkumaan', ic: 'door', d: 'Kaikki laitteet kiinni, kone lukkoon' },
] as const

// ---------------------------------------------------------------- KOTI
export function KotiPage({ home, onAsk }: { home: Home; onAsk: (t: string) => void }) {
  const { k, err, ilp, load, later } = home
  const nav = useNav()
  const logRows = useHud((s) => s.log)
  const [run, setRun] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ name: string; snap: Koti; left: number } | null>(null)
  const [restoring, setRestoring] = useState(false)

  useEffect(() => {
    if (!undo || restoring) return
    if (undo.left <= 0) {
      setUndo(null)
      return
    }
    const t = window.setTimeout(() => setUndo((u) => (u ? { ...u, left: u.left - 1 } : u)), 1000)
    return () => window.clearTimeout(t)
  }, [undo, restoring])

  // Long routines answer at once ("käynnissä", kaynnissa: true) and push their result as koti_osa 'rutiini'.
  const runSnap = useRef<{ id: string; name: string; snap: Koti | null } | null>(null)
  useEffect(
    () =>
      watchHome((p) => {
        const r = runSnap.current
        if (p.laite !== 'rutiini' || !p.tila.valmis || !r || p.tila.nimi !== r.id) return
        runSnap.current = null
        setRun(null)
        const text = String(p.tila.teksti ?? '').trim()
        note(`Rutiini: ${r.name}`, text.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 180) ?? 'Valmis.', p.tila.ok ? 'ok' : 'warn')
        void load(true)
        if (r.snap) setUndo({ name: r.name, snap: r.snap, left: 10 })
      }),
    [load],
  )
  // A lost push (bridge restart) must not leave the routine buttons locked.
  useEffect(() => {
    if (!run) return
    const t = window.setTimeout(() => {
      if (runSnap.current?.id === run) runSnap.current = null
      setRun(null)
    }, 240_000)
    return () => window.clearTimeout(t)
  }, [run])
  const runRoutine = (r: (typeof ROUTINES)[number], el: HTMLElement) => {
    if (run) return
    const snap = home.kRef.current ? (JSON.parse(JSON.stringify(home.kRef.current)) as Koti) : null
    setRun(r.id)
    setUndo(null)
    runSnap.current = { id: r.id, name: r.n, snap: r.id !== 'huomenta' ? snap : null }
    void runTool('rutiini', { nimi: r.id }, {
      label: `Rutiini: ${r.n}`,
      fx: 'routine',
      el,
      key: 'rt',
      ms: 30_000,
      after: (res) => {
        if (res?.kaynnissa) return // result comes by push
        runSnap.current = null
        setRun(null)
        void load(true)
        if (res && snap && r.id !== 'huomenta') setUndo({ name: r.n, snap, left: 10 })
      },
    })
  }

  /** Undo: compare the snapshot with fresh state and send the restoring commands with the existing tools. */
  const restore = async () => {
    if (!undo) return
    const snap = undo.snap
    setRestoring(true)
    const fresh = await load({ pakota: true, odota: true })
    const cmds: Array<[string, Record<string, unknown>, string, number]> = []
    for (const l of snap.valot.lista ?? []) {
      if (!l.online || l.paalla == null) continue
      const now = fresh?.valot.lista?.find((x) => x.nimi === l.nimi)
      if (now && now.paalla === l.paalla) continue
      cmds.push(['valo_aseta', l.paalla ? { nimi: l.nimi, paalle: true, ...(l.kirkkaus ? { kirkkaus: l.kirkkaus } : {}) } : { nimi: l.nimi, paalle: false }, `${l.nimi} ${l.paalla ? 'päälle' : 'pois'}`, 30_000])
    }
    const a = snap.ilp
    if (a.asennettu && a.virta != null && fresh && (fresh.ilp.virta !== a.virta || fresh.ilp.lampotila !== a.lampotila || fresh.ilp.tila !== a.tila || fresh.ilp.puhallus !== a.puhallus))
      cmds.push(['ir_lampopumppu', { virta: !!a.virta, lampotila: a.lampotila ?? 21, tila: a.tila ?? 'puhallus', puhallus: a.puhallus ?? 'auto' }, 'Lämpöpumppu palautettu', 30_000])
    const pw = (was?: string, now?: string) => (was === 'paalla') !== (now === 'paalla')
    if (snap.projektori.asennettu && fresh && pw(snap.projektori.tila, fresh.projektori.tila))
      cmds.push(['projektori_virta', { tila: snap.projektori.tila === 'paalla' ? 'paalle' : 'pois' }, 'Projektori palautettu', 110_000])
    if (snap.samsung.asennettu && fresh && pw(snap.samsung.tila, fresh.samsung.tila))
      cmds.push(['samsung_virta', { tila: snap.samsung.tila === 'paalla' ? 'paalle' : 'pois' }, 'Samsung palautettu', 40_000])
    if (snap.imuri.asennettu && !snap.imuri.siivoaa && fresh?.imuri.siivoaa) cmds.push(['imuri', { toiminto: 'kotiin' }, 'Imuri telakkaan', 110_000])
    setUndo(null)
    if (!cmds.length) note('Ei palautettavaa', 'Laitteet ovat jo samassa tilassa kuin ennen rutiinia.', 'warn')
    for (const [t, args, label, ms] of cmds) await runTool(t, args, { label, key: 'undo', ms })
    if (cmds.length) note(`${undo.name} peruttu`, `${cmds.length} laitetta palautettu. Koneen lukitusta ei voi perua täältä.`)
    setRestoring(false)
    later()
  }

  const primary = (id: DevId, el: HTMLElement) => {
    const v = devView(id, k, home.camOpen)
    if (!k || !(k[id] as Part)?.asennettu) {
      note(`${DEV_NAME[id]} ei ole yhdistetty`, `Asennus: tyokalut\\${INSTALL[id]}`, 'warn')
      return
    }
    switch (id) {
      case 'valot':
        return home.lights({ paalle: !v.on }, { label: v.on ? 'Valot pois' : 'Valot päälle', fx: 'light', el, key: 'light' }, (l) => (l.online ? { ...l, paalla: !v.on } : l))
      case 'ilp':
        return home.ilpSend({ ...ilp, on: !ilp.on }, ilp.on ? 'Lämpöpumppu pois' : 'Lämpöpumppu päälle', el)
      case 'projektori':
        return void home.command('projektori', 'projektori_virta', { tila: v.on ? 'pois' : 'paalle' }, { label: v.on ? 'Projektori valmiustilaan' : 'Projektori päälle', fx: v.on ? 'power' : 'media', el, key: 'proj', ms: 110_000 }, (p) => ({
          ...p,
          projektori: { ...p.projektori, tila: v.on ? 'valmiustila' : 'paalla', virhe: undefined },
        }))
      case 'samsung':
        return void home.command('samsung', 'samsung_virta', { tila: v.on ? 'pois' : 'paalle' }, { label: v.on ? 'Samsung pois' : 'Samsung päälle', fx: v.on ? 'power' : 'tv', el, key: 'tv', ms: 40_000 }, (p) => ({
          ...p,
          samsung: { ...p.samsung, tila: v.on ? 'pois' : 'paalla', virhe: undefined },
        }))
      case 'imuri':
        return void home.command('imuri', 'imuri', { toiminto: v.on ? 'kotiin' : 'aloita' }, { label: v.on ? 'Imuri telakkaan' : 'Imuri aloittaa', fx: 'vac', el, key: 'vac', ms: 110_000 }, (p) => ({
          ...p,
          imuri: { ...p.imuri, siivoaa: !v.on, tila: v.on ? 'palaa telakkaan' : 'siivoaa' },
        }))
      case 'kamera':
        home.setCamOpen(!home.camOpen)
        if (!home.camOpen) nav.goKey('turva')
        return
    }
  }

  const ids: DevId[] = ['valot', 'ilp', 'projektori', 'samsung', 'imuri', 'kamera']
  const lamps = k?.valot.lista ?? []
  const lampsOn = lamps.filter((l) => l.paalla)
  const bri = lampsOn.map((l) => l.kirkkaus).filter((x): x is number => typeof x === 'number')
  const maxBri = bri.length ? Math.max(...bri) : lampsOn.length ? 100 : 0
  const projOn = k?.projektori.tila === 'paalla'
  const active = ids.filter((id) => devView(id, k, home.camOpen).on).length
  const modeCol = ilp.mode === 'jäähdytys' ? 'var(--cold)' : ilp.mode === 'lämmitys' ? 'var(--hot)' : undefined

  const summary = !k ? (
    err ?? 'Haetaan laitteiden tilaa…'
  ) : (
    <>
      {lampsOn.length ? (
        <>
          <em>{lampsOn.length} valoa</em> päällä{bri.length ? ` ${maxBri} %` : ''}
        </>
      ) : (
        <>
          Valot <em>pois</em>
        </>
      )}
      {' · '}lämpöpumppu {ilp.known ? <em>{ilp.on ? `${ilp.mode} ${ilp.temp}°` : 'pois'}</em> : <em>ei tiedossa</em>}
      {' · '}
      {projOn || k.samsung.tila === 'paalla' ? (
        <>
          {projOn ? <em>projektori{k.projektori.sovellus ? ` (${k.projektori.sovellus})` : ''}</em> : null}
          {projOn && k.samsung.tila === 'paalla' ? ', ' : null}
          {k.samsung.tila === 'paalla' ? <em>Samsung TV</em> : null}
        </>
      ) : (
        'viihde valmiustilassa'
      )}
      {k.imuri.asennettu ? (
        <>
          {' · '}imuri <em>{(k.imuri.tila || '—').toLowerCase()}</em>
        </>
      ) : null}
      .
    </>
  )

  return (
    <div className="pgi g-koti">
      <div className="hero" data-hero>
        <div className="hl tl">
          SIJAINTI<b>KOTI · SUOMI</b>
        </div>
        <div className="hl tr">
          LÄMPÖPUMPPU<b>{ilp.known ? (ilp.on ? `${ilp.temp} °C ASETUS` : 'POIS') : '—'}</b>
        </div>
        <div className="hl bl">
          AKTIIVISET<b>{k ? `${active} LAITETTA` : '—'}</b>
        </div>
        <div className="hl br">
          VIIMEISIN<b>{logRows[0] ? logRows[0].txt.toUpperCase().slice(0, 26) : '—'}</b>
        </div>
      </div>
      <Pnl n="00" title="PIKAMITTARIT" className="gg" i={0}>
        <div className="mgs">
          <MiniGauge onClick={() => nav.goKey('ilma')} frac={ilp.on ? (ilp.temp - 16) / 14 : 0} txt={!ilp.known ? '—' : ilp.on ? `${ilp.temp}°` : 'OFF'} label="ILP" sub={ilp.on ? ilp.mode.toUpperCase() : ''} color={ilp.on ? modeCol : undefined} />
          <MiniGauge onClick={() => nav.goKey('ilma')} frac={maxBri / 100} txt={!k?.valot.asennettu ? '—' : lampsOn.length ? `${maxBri}%` : 'OFF'} label="VALOT" sub={lampsOn.length ? `${lampsOn.length} PÄÄLLÄ` : ''} />
          <MiniGauge onClick={() => nav.goKey('viihde')} frac={projOn && k?.projektori.aani != null ? k.projektori.aani / 100 : 0} txt={projOn ? (k?.projektori.aani != null ? `${k.projektori.aani}%` : 'ON') : 'OFF'} label="ÄÄNI" sub="PROJ" />
          <MiniGauge onClick={() => nav.goKey('turva')} frac={(k?.imuri.akku ?? 0) / 100} txt={k?.imuri.akku != null ? `${k.imuri.akku}%` : '—'} label="IMURI" sub={(k?.imuri.tila ?? '').split(' ')[0].toUpperCase().slice(0, 10)} color={(k?.imuri.akku ?? 100) < 20 ? 'var(--red)' : undefined} />
        </div>
      </Pnl>
      <div className="col cl">
        <Pnl n="01" title="TILANNE NYT" right={<span className="live">LIVE</span>} i={1}>
          <p className="sumtxt">{summary}</p>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn sm" onClick={() => void load(true)}>
              PÄIVITÄ TILA
            </button>
            <button className="btn sm" onClick={() => onAsk('Mitkä kodin laitteet ovat nyt päällä?')}>
              KYSY JARVISILTA
            </button>
          </div>
        </Pnl>
        <Pnl n="02" title="RUTIINIT" i={2}>
          <div className="rts">
            {ROUTINES.map((r) => (
              <button key={r.id} className={`rt${run === r.id ? ' run' : ''}`} disabled={!!run && run !== r.id} onClick={(e) => runRoutine(r, e.currentTarget)}>
                <b>
                  <Ic n={r.ic} />
                  {r.n}
                </b>
                <small>{run === r.id ? 'Käynnissä… (projektorin herätys voi kestää minuutin)' : r.d}</small>
                <i className="pg" />
              </button>
            ))}
          </div>
          {undo ? (
            <div className="undo on">
              <span>{restoring ? 'Palautetaan…' : `${undo.name} ajettu.`}</span>
              <button className="btn" disabled={restoring} onClick={() => void restore()}>
                <Ic n="undo" />
                PERU {undo.left}
              </button>
            </div>
          ) : null}
        </Pnl>
      </div>
      <div className="col cr">
        <Pnl n="03" title="LAITTEET" i={3}>
          <div className="tiles">
            {ids.map((id) => {
              const v = devView(id, k, home.camOpen)
              return (
                <div key={id} className={`tile${v.on ? ' on' : ''}`}>
                  <button className="go" onClick={() => nav.goKey(DEV_PAGE[id])}>
                    <Ic n={DEV_ICON[id]} />
                    <span style={{ minWidth: 0 }}>
                      <b>{DEV_NAME[id]}</b>
                      <small>{v.state}</small>
                      {id !== 'ilp' && id !== 'kamera' ? <Age home={home} part={k?.[id] as Part | undefined} /> : null}
                    </span>
                    <span className="more">OHJAIMET ›</span>
                  </button>
                  <button className="pw" aria-pressed={v.on} aria-label={`${DEV_NAME[id]} päälle/pois`} disabled={!v.ok} onClick={(e) => primary(id, e.currentTarget)}>
                    <Ic n="power" />
                  </button>
                </div>
              )
            })}
          </div>
        </Pnl>
        <Pnl n="04" title="TAPAHTUMAT" i={4}>
          <ul className="log">
            {logRows.slice(0, 12).map((l) => {
              const d = new Date(l.t)
              return (
                <li key={l.t + l.txt}>
                  <time>{`${hhmm(d)}:${pad(d.getSeconds())}`}</time>
                  <span>{l.txt}</span>
                </li>
              )
            })}
            {!logRows.length ? <li className="empty">Ei vielä tapahtumia tällä kerralla.</li> : null}
          </ul>
        </Pnl>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- ILMA & VALO
const MODES = [
  { v: 'jäähdytys', label: 'Jäähdytys', icon: 'snow' },
  { v: 'auto', label: 'Auto', icon: 'auto' },
  { v: 'puhallus', label: 'Puhallus', icon: 'fan' },
  { v: 'kuivaus', label: 'Kuivaus', icon: 'drop' },
]
const FANS = [
  { v: 'auto', label: 'Auto' },
  { v: 'hiljainen', label: 'Hiljainen' },
  { v: 'keski', label: 'Keski' },
  { v: 'kova', label: 'Kova' },
]
const PRESETS = [
  { n: 'Eco 24°', t: 24, f: 'auto' },
  { n: 'Mukava 22°', t: 22, f: 'auto' },
  { n: 'Teho 20°', t: 20, f: 'kova' },
]
const SCENES = [
  { n: 'Kirkas', b: 100, k: 5200 },
  { n: 'Lukeminen', b: 80, k: 4200 },
  { n: 'Ilta', b: 35, k: 2700 },
  { n: 'Leffa', b: 12, k: 2400 },
]
const COLORS = [
  { v: 'lämmin', c: '#ffcf8a' },
  { v: 'kylmä', c: '#d8f0ff' },
  { v: 'punainen', c: '#ff5a5a' },
  { v: 'vihreä', c: '#5dff8a' },
  { v: 'sininen', c: '#4f8bff' },
  { v: 'violetti', c: '#b07cff' },
]
/** valot.mjs lampotila is 0 (warm) – 100 (cold); the UI shows Kelvin. */
const kToPct = (K: number) => Math.round(clamp((K - 2200) / 43, 0, 100))

export function IlmaPage({ home }: { home: Home }) {
  const { k, ilp, ilpSend } = home
  const [ct, setCt] = useState(3400)
  const [showLamps, setShowLamps] = useState(false)
  const lamps = k?.valot.lista ?? []
  const lampsOn = lamps.filter((l) => l.paalla)
  const bri = lampsOn.map((l) => l.kirkkaus).filter((x): x is number => typeof x === 'number')
  const maxBri = bri.length ? Math.max(...bri) : lampsOn.length ? 100 : 0
  const anyOn = lampsOn.length > 0
  const ctRgb = `rgb(${ctColor(ct)})`
  const lightsOk = Boolean(k?.valot.asennettu)
  const ilpOk = Boolean(k?.ilp.asennettu)
  const modeCol = ilp.mode === 'jäähdytys' ? 'var(--cold)' : ilp.mode === 'lämmitys' ? 'var(--hot)' : undefined
  /** Optimistic light command: `fn` updates the lamps on screen now; live = repeated send while dragging. */
  const light = (args: Record<string, unknown>, label: string, el: Element | null, key = 'light', fn?: (l: Lamp) => Lamp, live = false) =>
    home.lights(args, { label, fx: 'light', el, color: ctRgb, key, quiet: live }, fn)
  const allOn = (b?: number) => (l: Lamp) => (l.online ? { ...l, paalla: b == null || b > 0, kirkkaus: b && b > 0 ? b : l.kirkkaus } : l)
  const bright = (v: number, el: Element | null, live = false) =>
    light(v > 0 ? { paalle: true, kirkkaus: v } : { paalle: false }, v > 0 ? `Valot ${v} %` : 'Valot pois', el, 'light', allOn(v), live)
  const one = (nimi: string, fn: (l: Lamp) => Lamp) => (l: Lamp) => (l.nimi === nimi ? fn(l) : l)

  return (
    <div className="pgi g-ilma">
      <Pnl n="05" title="LÄMPÖPUMPPU" right={<Tog on={ilp.on} label="Lämpöpumppu päälle/pois" disabled={!ilpOk} onChange={(v, el) => ilpSend({ ...ilp, on: v }, v ? 'Lämpöpumppu päälle' : 'Lämpöpumppu pois', el)} />} i={0}>
        {!ilpOk && k ? <p className="note">Lämpöpumppua ei ole yhdistetty (IR-ohjain: tyokalut\asenna_valot.bat).</p> : null}
        <Dial min={16} max={30} step={1} tick={1} major={2} value={ilp.temp} unit="°C · ASETUS" label="Lämpöpumpun lämpötila" off={!ilp.on} color={modeCol} disabled={!ilpOk} onCommit={(v, el) => ilpSend({ ...ilp, on: true, temp: v }, `Lämpöpumppu ${v} °C`, el)} />
        <div className="lbl">TILA</div>
        <Seg opts={MODES} value={ilp.mode} label="Tila" onChange={(v, el) => ilpSend({ ...ilp, on: true, mode: v }, `Tila: ${cap(v)}`, el)} />
        <div className="lbl">PUHALLIN</div>
        <Seg opts={FANS} value={ilp.fan} label="Puhallin" onChange={(v, el) => ilpSend({ ...ilp, fan: v }, `Puhallin: ${cap(v)}`, el)} />
        <div className="lbl">ESIASETUKSET</div>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.n} className="btn" disabled={!ilpOk} onClick={(e) => ilpSend({ ...ilp, on: true, temp: p.t, fan: p.f }, `Esiasetus: ${p.n}`, e.currentTarget)}>
              {p.n}
            </button>
          ))}
        </div>
        {ilpOk ? <p className="sub" style={{ marginTop: 10 }}>Tila = viimeksi lähetetty.</p> : null}
      </Pnl>
      <Pnl n="06" title="VALAISTUS" right={<Tog on={anyOn} label="Valot päälle/pois" disabled={!lightsOk} onChange={(v, el) => light({ paalle: v }, v ? 'Valot päälle' : 'Valot pois', el, 'light', (l) => (l.online ? { ...l, paalla: v } : l))} />} i={1}>
        {!lightsOk && k ? <p className="note">Valoja ei ole yhdistetty (tyokalut\asenna_valot.bat).</p> : null}
        <Dial
          min={0}
          max={100}
          step={1}
          tick={5}
          major={4}
          value={maxBri}
          unit="% · KIRKKAUS"
          label="Valojen kirkkaus"
          off={!anyOn}
          color={anyOn ? ctRgb : undefined}
          disabled={!lightsOk}
          onLive={(v, el) => bright(v, el, true)}
          onCommit={(v, el) => bright(v, el)}
        />
        <div className="lbl">
          VÄRILÄMPÖ <b>{ct} K</b>
        </div>
        <Range
          className="ct"
          min={2200}
          max={6500}
          step={100}
          value={ct}
          label="Värilämpö"
          disabled={!lightsOk}
          onInput={setCt}
          onLive={(v, el) => light({ lampotila: kToPct(v) }, `Värilämpö ${v} K`, el, 'ct', undefined, true)}
          onCommit={(v, el) => light({ lampotila: kToPct(v) }, `Värilämpö ${v} K`, el, 'ct')}
        />
        <div className="lbl">NÄKYMÄT</div>
        <div className="chips">
          {SCENES.map((s) => (
            <button
              key={s.n}
              className="chip"
              disabled={!lightsOk}
              onClick={(e) => {
                setCt(s.k)
                light({ paalle: true, kirkkaus: s.b, lampotila: kToPct(s.k) }, `Näkymä: ${s.n}`, e.currentTarget, 'light', allOn(s.b))
              }}
            >
              {s.n}
            </button>
          ))}
        </div>
        <div className="lbl">VÄRI</div>
        <div className="sws">
          {COLORS.map((c) => (
            <button key={c.v} className="sw" style={{ background: c.c }} aria-label={`Väri ${c.v}`} title={cap(c.v)} disabled={!lightsOk} onClick={(e) => light({ vari: c.v }, `Väri: ${c.v}`, e.currentTarget, 'color', (l) => (l.online ? { ...l, paalla: true, vari: c.v !== 'lämmin' && c.v !== 'kylmä' } : l))} />
          ))}
        </div>
        {lamps.length ? (
          <button className="btn sm wide" style={{ marginTop: 14 }} aria-expanded={showLamps} onClick={() => (hap(), setShowLamps(!showLamps))}>
            {showLamps ? 'PIILOTA VALAISIMET' : `VALAISIMET ERIKSEEN (${lamps.length})`}
          </button>
        ) : null}
        <div className="lamps" hidden={!showLamps} style={{ marginTop: 8 }}>
          {lamps.map((l) => (
            <div key={l.nimi} className={`lamp${l.paalla ? '' : ' off'}`}>
              <b>
                {l.nimi}
                {!l.online ? <small> · offline</small> : null}
              </b>
              <Tog
                on={!!l.paalla}
                label={l.nimi}
                disabled={!l.online}
                onChange={(v, el) => light({ nimi: l.nimi, paalle: v }, `${l.nimi} ${v ? 'päälle' : 'pois'}`, el, 'l:' + l.nimi, one(l.nimi, (x) => ({ ...x, paalla: v })))}
              />
              <Range
                min={1}
                max={100}
                value={l.kirkkaus ?? 50}
                label={`${l.nimi} kirkkaus`}
                disabled={!l.online}
                onLive={(v, el) => light({ nimi: l.nimi, paalle: true, kirkkaus: v }, `${l.nimi} ${v} %`, el, 'l:' + l.nimi, one(l.nimi, (x) => ({ ...x, paalla: true, kirkkaus: v })), true)}
                onCommit={(v, el) => light({ nimi: l.nimi, paalle: true, kirkkaus: v }, `${l.nimi} ${v} %`, el, 'l:' + l.nimi, one(l.nimi, (x) => ({ ...x, paalla: true, kirkkaus: v })))}
              />
            </div>
          ))}
        </div>
        {lightsOk && !lamps.length ? <p className="note">Ei lamppuja Tuya-tilillä.</p> : null}
      </Pnl>
    </div>
  )
}

// ---------------------------------------------------------------- VIIHDE
const PROJ_APPS = ['Netflix', 'YouTube', 'Yle Areena', 'Disney+', 'Prime Video', 'Spotify']
const TV_APPS = ['Netflix', 'YouTube', 'Yle Areena', 'Disney+', 'Prime Video', 'Spotify']

function Dpad({ onKey }: { onKey: (k: string, el: Element) => void }) {
  const C = 120, R1 = 112, R2 = 50
  const p = (a: number, r: number) => [C + r * Math.cos(a), C + r * Math.sin(a)].map((x) => x.toFixed(1)).join(' ')
  const seg = (a1: number, a2: number) => `M${p(a1, R1)}A${R1} ${R1} 0 0 1 ${p(a2, R1)}L${p(a2, R2)}A${R2} ${R2} 0 0 0 ${p(a1, R2)}Z`
  const dirs: Array<[string, number]> = [
    ['ylös', -Math.PI / 2],
    ['oikea', 0],
    ['alas', Math.PI / 2],
    ['vasen', Math.PI],
  ]
  const press = (el: SVGElement, k: string) => {
    el.classList.add('hit')
    window.setTimeout(() => el.classList.remove('hit'), 160)
    onKey(k, el)
  }
  return (
    <svg className="dpad" viewBox="0 0 240 240" aria-label="Suuntanäppäimet">
      {dirs.map(([k, a]) => {
        const m = [C + 82 * Math.cos(a), C + 82 * Math.sin(a)]
        return (
          <g key={k}>
            <path className="s" d={seg(a - Math.PI / 4 + 0.03, a + Math.PI / 4 - 0.03)} role="button" aria-label={k} onPointerDown={(e) => (e.preventDefault(), press(e.currentTarget, k))} />
            <path className="ar" d="M-7 4L0 -4L7 4" transform={`translate(${m[0].toFixed(1)} ${m[1].toFixed(1)}) rotate(${(a * 180) / Math.PI + 90})`} />
          </g>
        )
      })}
      <circle className="ok" cx="120" cy="120" r="42" role="button" aria-label="OK" onPointerDown={(e) => (e.preventDefault(), press(e.currentTarget, 'ok'))} />
      <text x="120" y="121">
        OK
      </text>
    </svg>
  )
}

export function ViihdePage({ home, onRemote }: { home: Home; onRemote: () => void }) {
  const { k } = home
  const [dev, setDev] = useState<'projektori' | 'samsung'>('projektori')
  const [song, setSong] = useState('')
  const [target, setTarget] = useState<'samsung' | 'projektori' | 'kone'>('samsung')
  const [kind, setKind] = useState<'' | 'kappale' | 'soittolista' | 'albumi' | 'artisti'>('')
  const [spRes, setSpRes] = useState<string | null>(null)
  const proj = dev === 'projektori'
  const part = proj ? k?.projektori : k?.samsung
  const installed = Boolean(part?.asennettu)
  const on = part?.tila === 'paalla'
  const name = proj ? 'Projektori' : 'Samsung TV'
  const keyTool = proj ? 'projektori_nappain' : 'samsung_nappain'
  // Projector presses during a wake-up wait in the bridge until it is awake (max 60 s): the request outlasts that,
  // the screen does not wait for it (toast only).
  const waking = proj && Boolean(k?.projektori.heraa)
  const projMs = 65_000
  const queued = (label: string) => (waking ? `${label} · jonossa, projektori herää…` : label)
  const key = (nappi: string, el: Element | null, label?: string) =>
    void runTool(keyTool, { nappi }, { label: queued(label ?? `${name}: ${nappi}`), fx: 'key', el, key: 'remote', ms: proj ? projMs : 20_000 })

  /** Optimistic: the source shows its new power / app state at once (back to the last known on failure). */
  const setDevState = (tila: string, sovellus?: string) => (p: Koti) =>
    proj ? { ...p, projektori: { ...p.projektori, tila, virhe: undefined, ...(sovellus ? { sovellus } : {}) } } : { ...p, samsung: { ...p.samsung, tila, virhe: undefined } }
  const power = (el: HTMLElement) =>
    void home.command(dev, proj ? 'projektori_virta' : 'samsung_virta', { tila: on ? 'pois' : 'paalle' }, { label: `${name} ${on ? 'pois' : 'päälle'}`, fx: on ? 'power' : proj ? 'media' : 'tv', el, key: dev, ms: proj ? 110_000 : 40_000 }, setDevState(on ? (proj ? 'valmiustila' : 'pois') : 'paalla'))
  const app = (a: string, el: HTMLElement) =>
    void home.command(dev, proj ? 'projektori_avaa' : 'samsung_avaa', { sovellus: a }, { label: `${name}: ${a}`, fx: on ? 'key' : proj ? 'media' : 'tv', el, key: dev + 'app', ms: proj ? 180_000 : 30_000 }, setDevState('paalla', a))
  const transport = (k2: 'prev' | 'rew' | 'play' | 'ffw' | 'next', el: HTMLElement) => {
    const label = { prev: 'Edellinen', rew: 'Taaksepäin', play: 'Toista / tauko', ffw: 'Eteenpäin', next: 'Seuraava' }[k2]
    if (proj) {
      const toiminto = { prev: 'edellinen', rew: 'taakse', play: 'toista_tauko', ffw: 'eteen', next: 'seuraava' }[k2]
      void home.command('projektori', 'projektori_toisto', { toiminto }, { label: queued(`Projektori: ${label}`), fx: 'key', el, key: 'tr', ms: projMs })
    } else key({ rew: 'taakse', play: 'playpause', ffw: 'eteen', prev: 'taakse', next: 'eteen' }[k2], el, `Samsung: ${label}`)
  }
  const spotify = (e: { preventDefault: () => void; currentTarget: HTMLFormElement }) => {
    e.preventDefault()
    const q = song.trim()
    if (!q) return
    setSpRes('Haetaan ja soitetaan…')
    void runTool('spotify_soita', { haku: q, laite: target, ...(kind ? { tyyppi: kind } : {}) }, { label: `Spotify: ${q.slice(0, 28)}`, fx: 'media', el: e.currentTarget, key: 'spot', ms: 60_000, after: (r) => setSpRes(r?.text ?? 'Ei onnistunut.') })
    setSong('')
  }
  const spCtl = (toiminto: string, label: string, el: HTMLElement) =>
    void runTool('spotify_ohjaa', { toiminto, ...(toiminto === 'nyt' ? {} : { laite: target }) }, { label: `Spotify: ${label}`, fx: 'key', el, key: 'spot', ms: 30_000, after: (r) => setSpRes(r?.text ?? null) })

  const status = !k ? 'HAETAAN…' : !installed ? 'EI YHDISTETTY' : waking ? 'HERÄTETÄÄN… ~20 S · NAPIT JONOSSA' : on ? `▶ PÄÄLLÄ · ${name.toUpperCase()}` : `VALMIUSTILA · ${name.toUpperCase()}`
  return (
    <div className="pgi g-media">
      <Pnl n="07" title="LÄHDE" className="a1" right={<Tog on={on} label="Laite päälle/pois" disabled={!installed} onChange={(_v, el) => power(el)} />} i={0}>
        <Seg
          opts={[
            { v: 'projektori', label: 'Projektori' },
            { v: 'samsung', label: 'Samsung TV' },
          ]}
          value={dev}
          label="Laite"
          onChange={(v) => setDev(v as 'projektori' | 'samsung')}
        />
        {k && !installed ? <p className="note">{name} ei ole yhdistetty: tyokalut\{proj ? 'asenna_projektori.bat' : 'asenna_telkkari.bat'}</p> : null}
        <div className={on ? '' : 'offcover-soft'}>
          <div className="np" style={{ marginTop: 14 }}>
            <div className="art">
              <b>{on ? (proj ? k?.projektori.sovellus || name : name) : 'OFF'}</b>
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="sub">{status}</div>
              <div className="big np-title">{on && proj ? k?.projektori.toisto || k?.projektori.sovellus || '—' : '—'}</div>
            </div>
          </div>
          <div className="transport">
            {proj ? (
              <button className="btn" aria-label="Edellinen" onClick={(e) => transport('prev', e.currentTarget)}>
                <Ic n="prev" />
              </button>
            ) : null}
            <button className="btn" aria-label="Taaksepäin" onClick={(e) => transport('rew', e.currentTarget)}>
              −10
            </button>
            <button className="btn pri" aria-label="Toista/tauko" onClick={(e) => transport('play', e.currentTarget)}>
              <Ic n="play" />
            </button>
            <button className="btn" aria-label="Eteenpäin" onClick={(e) => transport('ffw', e.currentTarget)}>
              +10
            </button>
            {proj ? (
              <button className="btn" aria-label="Seuraava" onClick={(e) => transport('next', e.currentTarget)}>
                <Ic n="next" />
              </button>
            ) : null}
          </div>
          <div className="vacrow" style={{ gridTemplateColumns: proj ? '1fr auto' : '1fr', marginTop: 8 }}>
            {proj ? (
              <Dial
                small
                min={0}
                max={100}
                step={1}
                tick={10}
                major={5}
                labels={false}
                value={k?.projektori.aani ?? 30}
                unit="% · ÄÄNI"
                label="Äänenvoimakkuus"
                off={!on}
                disabled={!installed}
                onCommit={(v, el) => void home.command('projektori', 'projektori_aani', { taso: v }, { label: queued(`Projektori: ääni ${v} %`), fx: 'key', el, key: 'vol', coalesce: true, ms: projMs }, (p) => ({ ...p, projektori: { ...p.projektori, aani: v } }))}
              />
            ) : null}
            <div style={{ display: 'grid', gap: 8 }}>
              <button className="btn" onClick={(e) => key('mykistä', e.currentTarget, `${name}: mykistys`)}>
                <Ic n="vol" />
                MYKISTÄ
              </button>
              {proj ? (
                <button className="btn" onClick={(e) => (fx('scan', e.currentTarget), key('tarkenna', e.currentTarget, 'Projektori: tarkennus'))}>
                  TARKENNA
                </button>
              ) : null}
            </div>
          </div>
          <div className="lbl">SOVELLUKSET</div>
          <div className="apps">
            {(proj ? PROJ_APPS : TV_APPS).map((a) => (
              <button key={a} className="app" aria-pressed={on && proj && (k?.projektori.sovellus ?? '').toLowerCase().includes(a.toLowerCase())} disabled={!installed} onClick={(e) => app(a, e.currentTarget)}>
                {a}
              </button>
            ))}
          </div>
        </div>
      </Pnl>
      <Pnl n="08" title="KAUKOSÄÄDIN" className="a2" right={<span>{name.toUpperCase()}</span>} i={1}>
        <Dpad onKey={(k2, el) => key(k2, el, `${name}: ${{ ylös: '▲', alas: '▼', vasen: '◀', oikea: '▶', ok: 'OK' }[k2] ?? k2}`)} />
        <div className="keys">
          <button className="btn" onClick={(e) => key('takaisin', e.currentTarget)}>
            <Ic n="back" />
            TAKAISIN
          </button>
          <button className="btn" onClick={(e) => key('koti', e.currentTarget)}>
            <Ic n="home" />
            KOTI
          </button>
          <button className="btn" onClick={(e) => key('valikko', e.currentTarget)}>
            <Ic n="menu" />
            VALIKKO
          </button>
          <button className="btn" onClick={(e) => key(proj ? 'syöte' : 'lähde', e.currentTarget, `${name}: lähde`)}>
            LÄHDE
          </button>
        </div>
        <div className="rock">
          <div>
            <button className="btn" onClick={(e) => key('ääni-', e.currentTarget, `${name}: ääni −`)}>
              −
            </button>
            <span>ÄÄNI</span>
            <button className="btn" onClick={(e) => key('ääni+', e.currentTarget, `${name}: ääni +`)}>
              +
            </button>
          </div>
          {!proj ? (
            <div>
              <button className="btn" onClick={(e) => key('kanava-', e.currentTarget, 'Samsung: kanava −')}>
                −
              </button>
              <span>KANAVA</span>
              <button className="btn" onClick={(e) => key('kanava+', e.currentTarget, 'Samsung: kanava +')}>
                +
              </button>
            </div>
          ) : (
            <button className="btn" onClick={(e) => key('asetukset', e.currentTarget, 'Projektori: asetukset')}>
              ⚙ ASETUKSET
            </button>
          )}
        </div>
        <button className="btn wide" style={{ marginTop: 12 }} onClick={onRemote}>
          KOKO KAUKOSÄÄDIN · LINKIT · RUUTU
        </button>
      </Pnl>
      <Pnl n="09" title="SPOTIFY" className="a3" right={<span className="st a">VAATII PREMIUM</span>} i={2}>
        <Seg
          opts={[
            { v: 'samsung', label: 'Samsung' },
            { v: 'projektori', label: 'Projektori' },
            { v: 'kone', label: 'Kone' },
          ]}
          value={target}
          label="Soittava laite"
          onChange={(v) => setTarget(v as typeof target)}
        />
        <div className="chips" style={{ margin: '10px 0' }}>
          {(['', 'kappale', 'soittolista', 'albumi', 'artisti'] as const).map((t) => (
            <button key={t || 'kaikki'} className="chip" aria-pressed={kind === t} onClick={() => (hap(), setKind(t))}>
              {t ? cap(t) : 'Kaikki'}
            </button>
          ))}
        </div>
        <form className="inp" onSubmit={spotify}>
          <input value={song} onChange={(e) => setSong(e.target.value)} placeholder="Hae kappale, artisti tai soittolista" aria-label="Spotify-haku" />
          <button className="btn" disabled={!song.trim()} aria-label="Soita">
            <Ic n="play" />
          </button>
        </form>
        <div className="transport" style={{ gridTemplateColumns: 'repeat(5,minmax(0,1fr))' }}>
          <button className="btn" aria-label="Edellinen kappale" onClick={(e) => spCtl('edellinen', 'edellinen', e.currentTarget)}>
            <Ic n="prev" />
          </button>
          <button className="btn" aria-label="Tauko" onClick={(e) => spCtl('tauko', 'tauko', e.currentTarget)}>
            <Ic n="pause" />
          </button>
          <button className="btn" aria-label="Jatka" onClick={(e) => spCtl('jatka', 'jatka', e.currentTarget)}>
            <Ic n="play" />
          </button>
          <button className="btn" aria-label="Seuraava kappale" onClick={(e) => spCtl('seuraava', 'seuraava', e.currentTarget)}>
            <Ic n="next" />
          </button>
          <button className="btn" onClick={(e) => spCtl('nyt', 'mikä soi', e.currentTarget)}>
            NYT
          </button>
        </div>
        {spRes ? <p className="note">{spRes}</p> : null}
      </Pnl>
    </div>
  )
}

// ---------------------------------------------------------------- TURVA & IMURI
function Joystick({ onDir, disabled }: { onDir: (d: string, el: Element) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLElement>(null)
  const st = useRef({ on: false, cx: 0, cy: 0, last: '' })
  const dirOf = (x: number, y: number) => (Math.hypot(x, y) < 14 ? '' : Math.abs(x) > Math.abs(y) ? (x > 0 ? 'oikea' : 'vasen') : y > 0 ? 'alas' : 'ylös')
  const move = (e: { clientX: number; clientY: number }) => {
    const s = st.current
    if (!s.on) return
    let x = e.clientX - s.cx, y = e.clientY - s.cy
    const m = Math.hypot(x, y), lim = 38
    if (m > lim) {
      x *= lim / m
      y *= lim / m
    }
    if (knob.current) knob.current.style.transform = `translate(${x}px,${y}px)`
    const d = dirOf(x, y)
    if (d && d !== s.last) {
      s.last = d
      hap(5)
    }
  }
  const up = () => {
    const s = st.current
    if (!s.on) return
    s.on = false
    if (knob.current) knob.current.style.transform = ''
    if (s.last && ref.current) onDir(s.last, ref.current)
    s.last = ''
  }
  return (
    <div
      ref={ref}
      className={`joy${disabled ? ' dis' : ''}`}
      aria-label="Kääntö"
      onPointerDown={(e) => {
        if (disabled) return
        st.current.on = true
        e.currentTarget.setPointerCapture(e.pointerId)
        const r = e.currentTarget.getBoundingClientRect()
        st.current.cx = r.left + r.width / 2
        st.current.cy = r.top + r.height / 2
        move(e)
      }}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <i ref={knob} />
      <span style={{ left: '50%', top: 4, transform: 'translateX(-50%)' }}>YLÖS</span>
      <span style={{ left: '50%', bottom: 4, transform: 'translateX(-50%)' }}>ALAS</span>
    </div>
  )
}

function CamTime() {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setT(new Date()), 1000)
    return () => window.clearInterval(id)
  }, [])
  return <span>{`${hhmm(t)}:${pad(t.getSeconds())}`}</span>
}

export function TurvaPage({ home, active }: { home: Home; active: boolean }) {
  const { k, camOpen, setCamOpen } = home
  const names = k?.kamera.kamerat ?? []
  const [cam, setCam] = useState('')
  const [live, setLive] = useState<{ key: string; n: number } | null>(null)
  const [fail, setFail] = useState<string | null>(null)
  const [vacMore, setVacMore] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const camName = cam || names[0] || ''
  const camOk = Boolean(k?.kamera.asennettu && names.length)
  const v = k?.imuri
  const vacOk = Boolean(v?.asennettu)

  // Stream only while the page is visible and the user asked for it.
  useEffect(() => {
    if (!active || !camOpen || !camOk) {
      if (imgRef.current) imgRef.current.src = ''
      setLive(null)
      return
    }
    let gone = false
    setFail(null)
    void request<Reply>('laite', { tyokalu: 'kamera_tila', args: {} }, 20_000)
      .then((r) => {
        if (!gone) setLive({ key: r.avain ?? '', n: Date.now() })
      })
      .catch((e) => !gone && setFail(`Kamera ei auennut: ${errText(e)}`))
    return () => {
      gone = true
      if (imgRef.current) imgRef.current.src = ''
    }
  }, [active, camOpen, camOk, camName])

  const VAC_NOW: Record<string, { tila: string; siivoaa: boolean } | undefined> = {
    aloita: { tila: 'siivoaa', siivoaa: true },
    jatka: { tila: 'siivoaa', siivoaa: true },
    tauko: { tila: 'tauolla', siivoaa: false },
    kotiin: { tila: 'palaa telakkaan', siivoaa: false },
  }
  const vac = (toiminto: string, label: string, el: HTMLElement) => {
    const now = VAC_NOW[toiminto]
    void home.command('imuri', 'imuri', { toiminto }, { label, fx: 'vac', el, key: 'vac', ms: 110_000 }, now ? (p) => ({ ...p, imuri: { ...p.imuri, ...now } }) : undefined)
  }
  const bat = v?.akku
  return (
    <div className="pgi g-turva">
      <Pnl n="10" title={`KAMERA${camName ? ` · ${camName.toUpperCase()}` : ''}`} right={live ? <span className="live">LIVE</span> : <span>SULJETTU</span>} i={0}>
        <div className={`camf${live ? '' : ' closed'}`}>
          {live ? (
            <img
              key={live.n}
              ref={imgRef}
              src={`${BRIDGE_HTTP_URL}/kamera.mjpg?nimi=${encodeURIComponent(camName)}&t=${encodeURIComponent(live.key)}&n=${live.n}`}
              alt={`Kameran ${camName} elävä kuva`}
              onError={() => (setLive(null), setCamOpen(false), setFail('Kuvaa ei saatu. Onko kamera päällä ja samassa wifissä (tai yksityisyystila päällä)?'))}
            />
          ) : (
            <div className="camoff">
              <div>{!k ? 'HAETAAN…' : camOk ? 'KAMERA SULJETTU' : 'KAMERAA EI OLE ASENNETTU'}</div>
              {camOk ? null : <small>tyokalut\asenna_kamera.bat</small>}
            </div>
          )}
          <div className="scan" />
          <div className="xh" />
          <span className="br b1" />
          <span className="br b2" />
          <span className="br b3" />
          <span className="br b4" />
          <div className="ov">
            <span className="rec">{live ? '● REC' : '○'}</span>
            <CamTime />
            <span>{camName.toUpperCase().slice(0, 14)}</span>
          </div>
        </div>
        <div className="camctl">
          <Joystick disabled={!camOk} onDir={(d, el) => void runTool('kamera_kaanna', { nimi: camName, suunta: d }, { label: `Kamera ${d}`, fx: 'scan', el, key: 'ptz', ms: 20_000 })} />
          <div style={{ display: 'grid', gap: 10, alignContent: 'start' }}>
            <button
              className={`btn${camOpen ? '' : ' pri'}`}
              disabled={!camOk}
              onClick={(e) => {
                fx(camOpen ? 'key' : 'snap', e.currentTarget)
                setCamOpen(!camOpen)
              }}
            >
              <Ic n="cam" />
              {camOpen ? 'SULJE KUVA' : 'AVAA ELÄVÄ KUVA'}
            </button>
            {names.length > 1 ? (
              <div className="chips">
                {names.map((n) => (
                  <button key={n} className="chip" aria-pressed={n === camName} onClick={() => (hap(), setCam(n))}>
                    {n}
                  </button>
                ))}
              </div>
            ) : null}
            {fail ? <p className="note warn">{fail}</p> : null}
          </div>
        </div>
      </Pnl>
      <Pnl n="11" title="IMURI" right={<span>{vacOk ? (v?.tila || '—').toUpperCase().slice(0, 18) : '—'}</span>} i={1}>
        {k && !vacOk ? <p className="note">Imuria ei ole yhdistetty: tyokalut\asenna_imuri.bat</p> : null}
        <div className="vacrow">
          <MiniGauge frac={(bat ?? 0) / 100} txt={bat != null ? `${bat}%` : '—'} label="AKKU" sub={v?.siivoaa ? 'SIIVOAA' : ''} color={(bat ?? 100) < 20 ? 'var(--red)' : (bat ?? 100) < 40 ? 'var(--amb)' : undefined} style={{ maxWidth: 110 }} />
          <div>
            <div className="big" style={{ fontSize: 26 }}>
              {!k ? 'HAETAAN…' : vacOk ? (v?.siivoaa ? 'SIIVOAA' : (v?.tila || '—').toUpperCase()) : 'EI YHDISTETTY'}
            </div>
            {v?.virhe ? <div className="sub">Huom: {v.virhe}</div> : null}
            <Age home={home} part={v} />
          </div>
        </div>
        <div className="vacbtns">
          <button className="btn pri" disabled={!vacOk} onClick={(e) => vac('aloita', 'Imuri: siivoa koko koti', e.currentTarget)}>
            SIIVOA KOKO KOTI
          </button>
          <button className="btn" disabled={!vacOk} onClick={(e) => vac('tauko', 'Imuri tauolle', e.currentTarget)}>
            <Ic n="pause" />
            TAUKO
          </button>
          <button className="btn" disabled={!vacOk} onClick={(e) => vac('jatka', 'Imuri jatkaa', e.currentTarget)}>
            <Ic n="play" />
            JATKA
          </button>
          <button className="btn" disabled={!vacOk} onClick={(e) => vac('kotiin', 'Imuri telakkaan', e.currentTarget)}>
            <Ic n="home" />
            TELAKKAAN
          </button>
          <button className="btn" disabled={!vacOk} aria-expanded={vacMore} onClick={() => (hap(), setVacMore(!vacMore))}>
            {vacMore ? 'PIILOTA' : '⋯ LISÄÄ'}
          </button>
          {vacMore ? (
            <>
              <button className="btn" disabled={!vacOk} onClick={(e) => vac('etsi', 'Imuri piippaa', e.currentTarget)}>
                PAIKANNA
              </button>
              <button className="btn" disabled={!vacOk} onClick={(e) => (fx('scan', e.currentTarget), void home.load({ laite: 'imuri', pakota: true }))}>
                PÄIVITÄ TILA
              </button>
            </>
          ) : null}
        </div>
      </Pnl>
    </div>
  )
}
