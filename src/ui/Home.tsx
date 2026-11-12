/**
 * Koti (JARVIS 2.0, 8.11.2026): Reaktori-tyylinen etusivu puhelimelle ja koneelle.
 *
 * Laatat ohjaavat oikeita laitteita suoraan bridgen 'laite'-pyynnöillä (ei kielimallia → nopea, ei krediittejä).
 * Laatan painallus = päätoiminto (päälle/pois, imuri aloita/kotiin). "Pikatoiminnot" avaa laitteen napit.
 * Jokaisella laitteella on oma tehtäväefekti: painallus näyttää mitä on tapahtumassa (valon välähdys, lämpöaalto,
 * valokeila, tutkapulssi, kuvaputken syttyminen, sulkimen kehys) ja päällä olevassa laitteessa efekti jatkuu.
 * Tila haetaan koti_tila-pyynnöllä (koti.mjs) minuutin välein ja jokaisen toiminnon jälkeen.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { request } from '../lib/brain'
import { BRIDGE_HTTP_URL } from '../config'
import './home.css'

type Part = { asennettu: boolean; virhe?: string }
type Lamp = { nimi: string; online: boolean; paalla: boolean | null; kirkkaus?: number | null; vari?: boolean }
type Koti = {
  at: number
  valot: Part & { lista?: Lamp[] }
  projektori: Part & { tila?: string; sovellus?: string; toisto?: string; aani?: number | null }
  samsung: Part & { tila?: string }
  imuri: Part & { tila?: string; akku?: number | null; siivoaa?: boolean; virhe?: string }
  ilp: Part & { virta?: boolean | null; lampotila?: number; tila?: string; puhallus?: string; at?: number }
  kamera: Part & { kamerat?: string[] }
}
type Reply = { text: string; koti?: Koti; kamerat?: string[]; avain?: string }
type DevId = 'valot' | 'ilp' | 'projektori' | 'imuri' | 'samsung' | 'kamera'

const errText = (err: unknown) => String((err as Error)?.message ?? err)
const dev = (tyokalu: string, args: Record<string, unknown> = {}, ms = 60_000) => request<Reply>('laite', { tyokalu, args }, ms)

const ICON: Record<DevId, string> = {
  valot: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.8.8 1 1.5 1 2.5h6c0-1 .2-1.7 1-2.5A6 6 0 0 0 12 3z',
  ilp: 'M4 8h12a3 3 0 1 0-3-3M4 12h16a3 3 0 1 1-3 3M4 16h7',
  projektori: 'M2 8h20v9H2zM16 12.5m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M6 12.5h4',
  imuri: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 3v3',
  samsung: 'M3 4h18v12H3zM8 20h8M12 16v4',
  kamera: 'M3 7h3l2-3h8l2 3h3v12H3zM12 13m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
}
const NAME: Record<DevId, string> = { valot: 'Valot', ilp: 'Lämpöpumppu', projektori: 'Projektori', imuri: 'Imuri', samsung: 'Samsung TV', kamera: 'Kamera' }
const ORDER: DevId[] = ['valot', 'ilp', 'projektori', 'imuri', 'samsung', 'kamera']

const ROUTINES = [
  { id: 'leffailta', label: 'Leffailta', fx: 'film', hint: 'Projektori + Netflix, valot pois' },
  { id: 'hyvaa_yota', label: 'Hyvää yötä', fx: 'stars', hint: 'Iltarutiini' },
  { id: 'huomenta', label: 'Huomenta', fx: 'sun', hint: 'Päivän katsaus' },
  { id: 'nukkumaan', label: 'Nukkumaan', fx: 'lock', hint: 'Kaikki laitteet kiinni, kone lukkoon' },
] as const

function Icon({ id, size = 22 }: { id: DevId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[id]} />
    </svg>
  )
}

/** Laitteen näkymä laatassa: onko päällä, mitä tilarivi ja isot luvut sanovat. */
function view(id: DevId, k: Koti | null) {
  const none = { on: false, ok: false, state: 'Haetaan…', value: '' }
  if (!k) return none
  const p = k[id] as Part
  if (!p?.asennettu) return { on: false, ok: false, state: 'Ei yhdistetty', value: '' }
  if (p.virhe) return { on: false, ok: true, state: 'Ei vastaa juuri nyt', value: '' }
  switch (id) {
    case 'valot': {
      const l = k.valot.lista ?? []
      const on = l.filter((x) => x.paalla)
      const b = on.map((x) => x.kirkkaus).filter((x): x is number => typeof x === 'number')
      return { on: on.length > 0, ok: true, state: on.length ? on.map((x) => x.nimi).slice(0, 2).join(', ') : l.length ? 'Kaikki pois' : 'Ei lamppuja', value: on.length ? (b.length ? `${Math.max(...b)} %` : 'Päällä') : 'Pois' }
    }
    case 'ilp': {
      const a = k.ilp
      if (a.virta == null) return { on: false, ok: true, state: 'Ei vielä asetettu täältä', value: '—' }
      return { on: !!a.virta, ok: true, state: a.virta ? `${cap(a.tila ?? 'auto')} · viimeksi asetettu` : 'Pois · viimeksi asetettu', value: a.virta ? `${a.lampotila ?? 21} °C` : 'Pois' }
    }
    case 'projektori': {
      const t = k.projektori.tila
      return { on: t === 'paalla', ok: true, state: t === 'paalla' ? k.projektori.toisto || k.projektori.sovellus || 'Päällä' : t === 'valmiustila' ? 'Valmiustila' : 'Pois tai syvä valmiustila', value: t === 'paalla' ? 'Päällä' : 'Pois' }
    }
    case 'imuri': {
      const v = k.imuri
      return { on: !!v.siivoaa, ok: true, state: v.virhe ? v.virhe : cap(v.tila ?? ''), value: v.siivoaa ? 'Siivoaa' : v.akku != null ? `${v.akku} %` : '—' }
    }
    case 'samsung': {
      const t = k.samsung.tila
      return { on: t === 'paalla', ok: true, state: t === 'paalla' ? 'Päällä' : t === 'valmiustila' ? 'Valmiustila' : 'Pois', value: t === 'paalla' ? 'Päällä' : 'Pois' }
    }
    case 'kamera':
      return { on: false, ok: true, state: (k.kamera.kamerat ?? []).join(', ') || 'Kamera', value: 'Live' }
  }
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

export function HomeView({ onChat, onRemote }: { onChat: () => void; onRemote: () => void }) {
  const [k, setK] = useState<Koti | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null) // device id or routine id while a command runs
  const [press, setPress] = useState<{ id: string; n: number } | null>(null)
  const [sheet, setSheet] = useState<DevId | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [live, setLive] = useState<{ cam: string; key: string; n: number } | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)
  const [tvSong, setTvSong] = useState('')
  const sheetRef = useRef<HTMLDivElement | null>(null)
  /** Ohjainpaneeli auki/kiinni; avautuessa vieritetään näkyviin (puhelimessa paneeli on laattojen alla). */
  const openSheet = (id: DevId | null) => {
    setSheet(id)
    if (id) window.setTimeout(() => sheetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60)
  }
  /** Samsungin kaukosäädinnäppäin: suoraan, ilman painallusefektiä ja tilan uudelleenhakua (nopea navigointi). */
  const tvKey = (nappi: string) => {
    void dev('samsung_nappain', { nappi }, 15_000).then(
      (r) => (/^Painettu/.test(r.text) ? undefined : say(r.text)),
      (e) => say(`Ei onnistunut: ${errText(e)}`),
    )
  }

  const load = useCallback(async (pakota = false) => {
    try {
      const r = await dev('koti_tila', { pakota }, 40_000)
      if (r.koti) setK(r.koti)
      setErr(null)
    } catch (e) {
      setErr(/Tuntematon|kotitoiminto/i.test(errText(e)) ? 'Koti-näkymä vaatii JARVISin uudelleenkäynnistyksen ("uudelleen").' : `Tilaa ei saatu: ${errText(e)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = window.setInterval(() => void load(), 60_000)
    const onUp = () => void load()
    window.addEventListener('jarvis-connected', onUp)
    return () => {
      window.clearInterval(t)
      window.removeEventListener('jarvis-connected', onUp)
      window.clearTimeout(toastTimer.current)
    }
  }, [load])

  const say = (s: string) => {
    setToast(s)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 7000)
  }

  /** Runs one command: press effect at once, busy scan while it runs, result as a toast, then fresh state. */
  const act = async (id: string, tyokalu: string, args: Record<string, unknown> = {}, ms = 60_000, after?: () => void) => {
    if (busy) return
    setPress({ id, n: Date.now() })
    setBusy(id)
    try {
      const r = await dev(tyokalu, args, ms)
      say(r.text?.split('\n')[0]?.slice(0, 220) || 'Tehty.')
      // Lämpöpumppu: valinta näkyy heti (IR ei kerro tilaa, joten näytetään lähetetty asetus).
      if (tyokalu === 'ir_lampopumppu' && /IR ei kerro laitteen todellista tilaa/.test(r.text ?? '') && !/virhe:/i.test(r.text ?? '')) {
        setK((prev) => {
          if (!prev) return prev
          const a = { ...prev.ilp }
          if (typeof args.virta === 'boolean') a.virta = args.virta
          else a.virta = true
          if (args.lampotila != null) a.lampotila = Number(args.lampotila)
          if (args.tila) a.tila = String(args.tila)
          if (args.puhallus) a.puhallus = String(args.puhallus)
          return { ...prev, ilp: a }
        })
      }
      after?.()
    } catch (e) {
      say(`Ei onnistunut: ${errText(e)}`)
    } finally {
      setBusy(null)
      window.setTimeout(() => void load(true), 1500)
    }
  }

  const openLive = async (on: boolean) => {
    if (!on) return setLive(null)
    try {
      const r = await dev('kamera_tila', {}, 20_000)
      const cam = r.kamerat?.[0]
      if (!cam) return say('Kameraa ei ole asennettu.')
      setPress({ id: 'kamera', n: Date.now() })
      setLive({ cam, key: r.avain ?? '', n: Date.now() })
    } catch (e) {
      say(`Kamera ei auennut: ${errText(e)}`)
    }
  }

  const primary = (id: DevId) => {
    const v = view(id, k)
    if (!k || !(k[id] as Part)?.asennettu) return openSheet(id)
    switch (id) {
      case 'valot':
        return void act(id, 'valo_aseta', { paalle: !v.on }, 30_000)
      case 'ilp':
        return void act(id, 'ir_lampopumppu', { virta: !v.on }, 30_000)
      case 'projektori':
        return void act(id, 'projektori_virta', { tila: v.on ? 'pois' : 'paalle' }, 110_000)
      case 'imuri':
        return void act(id, 'imuri', { toiminto: v.on ? 'kotiin' : 'aloita' }, 110_000)
      case 'samsung':
        return void act(id, 'samsung_virta', { tila: v.on ? 'pois' : 'paalle' }, 40_000)
      case 'kamera':
        openSheet('kamera')
        return void openLive(!live)
    }
  }

  const ac = k?.ilp
  const acTemp = ac?.lampotila ?? 21
  const routineBusy = ROUTINES.some((r) => r.id === busy)
  const onCount = ORDER.filter((id) => view(id, k).on).length

  return (
    <div className="h-root">
      <header className="h-head">
        <div className={`h-reactor${busy ? ' is-busy' : ''}`} aria-hidden="true">
          <span className="h-reactor__ring" />
          <span className="h-reactor__core" />
        </div>
        <div className="h-head__text">
          <h1 className="h-title">Koti</h1>
          <p className="h-status">
            <span className={`h-led${err ? ' is-warn' : ''}`} aria-hidden="true" />
            {err ? err : !k ? 'Haetaan laitteiden tilaa…' : onCount ? `${onCount} laitetta päällä` : 'Kaikki laitteet pois'}
          </p>
        </div>
        <button className="h-icon-btn" onClick={() => void load(true)} aria-label="Päivitä tila" title="Päivitä tila">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /></svg>
        </button>
      </header>

      <section className="h-sec" aria-label="Rutiinit">
        <h2 className="h-h2">Rutiinit</h2>
        <div className="h-routines">
          {ROUTINES.map((r) => (
            <button
              key={r.id}
              className={`h-routine${busy === r.id ? ' is-run' : ''}`}
              disabled={!!busy && busy !== r.id}
              aria-busy={busy === r.id}
              title={r.hint}
              onClick={() => void act(r.id, 'rutiini', { nimi: r.id }, 240_000)}
            >
              {busy === r.id || press?.id === r.id ? <span key={press?.n} className={`h-rfx h-rfx--${r.fx}`} aria-hidden="true" /> : null}
              <span className="h-routine__label">{r.label}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="h-sec" aria-label="Laitteet">
        <h2 className="h-h2">Laitteet</h2>
        <div className="h-grid">
          {ORDER.map((id) => {
            const v = view(id, k)
            const on = id === 'kamera' ? !!live : v.on
            const running = busy === id
            return (
              <div key={id} className={`h-tile${on ? ' is-on' : ''}${running ? ' is-busy' : ''}${sheet === id ? ' is-open' : ''}`}>
                <button className="h-tile__main" onClick={() => primary(id)} disabled={!!busy && !running} aria-pressed={on} aria-busy={running}>
                  {on ? (
                    <span className={`h-fx h-fx--${id}`} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : null}
                  {press?.id === id ? <span key={press.n} className={`h-press h-press--${id}`} aria-hidden="true" /> : null}
                  {running ? <span className="h-scan" aria-hidden="true" /> : null}
                  <span className="h-tile__top">
                    <Icon id={id} />
                    <span className={`h-dot${on ? ' is-on' : ''}`} aria-hidden="true" />
                  </span>
                  <span className="h-tile__name">{NAME[id]}</span>
                  <span className="h-tile__state">{running ? 'Lähetetään…' : v.state}</span>
                  <span className="h-tile__value">{v.value}</span>
                </button>
                {/* Ohjaimet erillisenä alapalkkina (8.11.: pieni ⋯-nappi laatan sisällä johti vahinkopainalluksiin). */}
                <button className="h-tile__more" onClick={() => openSheet(sheet === id ? null : id)} aria-expanded={sheet === id} aria-label={`${NAME[id]}: ${sheet === id ? 'sulje ohjaimet' : 'ohjaimet'}`}>
                  <span>{sheet === id ? 'Sulje' : 'Ohjaimet'}</span>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: sheet === id ? 'rotate(180deg)' : undefined }}><path d="m6 9 6 6 6-6" /></svg>
                </button>
              </div>
            )
          })}
        </div>

        {sheet ? (
          <div ref={sheetRef} className="h-sheet" role="region" aria-label={`${NAME[sheet]}: pikatoiminnot`}>
            <div className="h-sheet__head">
              <span className="h-sheet__title">
                <Icon id={sheet} size={18} /> {NAME[sheet]}
              </span>
              <button className="h-btn h-sheet__close" onClick={() => openSheet(null)}>Sulje ohjaimet</button>
            </div>
            {k && !(k[sheet] as Part)?.asennettu ? (
              <p className="h-note">
                {NAME[sheet]} ei ole vielä yhdistetty JARVISiin. Asennus: tyokalut\{sheet === 'valot' || sheet === 'ilp' ? 'asenna_valot.bat' : sheet === 'projektori' ? 'asenna_projektori.bat' : sheet === 'samsung' ? 'asenna_telkkari.bat' : sheet === 'imuri' ? 'asenna_imuri.bat' : 'asenna_kamera.bat'}
              </p>
            ) : sheet === 'valot' ? (
              <>
                <div className="h-row">
                  <Btn on={() => void act('valot', 'valo_aseta', { paalle: true }, 30_000)} busy={busy}>Päälle</Btn>
                  <Btn on={() => void act('valot', 'valo_aseta', { paalle: false }, 30_000)} busy={busy}>Pois</Btn>
                  <Btn on={() => void act('valot', 'valo_aseta', { kirkkaus: 30 }, 30_000)} busy={busy}>Himmeä 30 %</Btn>
                  <Btn on={() => void act('valot', 'valo_aseta', { kirkkaus: 100 }, 30_000)} busy={busy}>Kirkas 100 %</Btn>
                </div>
                <div className="h-row">
                  {[
                    ['lämmin', 'Lämmin', '#ffcf8a'],
                    ['kylmä', 'Kylmä', '#d8f0ff'],
                    ['punainen', 'Punainen', '#ff5a5a'],
                    ['sininen', 'Sininen', '#4f8bff'],
                    ['violetti', 'Violetti', '#b07cff'],
                  ].map(([vari, label, c]) => (
                    <Btn key={vari} on={() => void act('valot', 'valo_aseta', { vari }, 30_000)} busy={busy}>
                      <span className="h-swatch" style={{ background: c }} aria-hidden="true" />
                      {label}
                    </Btn>
                  ))}
                </div>
                {(k?.valot.lista?.length ?? 0) > 1 ? (
                  <div className="h-list">
                    {k!.valot.lista!.map((l) => (
                      <div key={l.nimi} className="h-list__row">
                        <span>{l.nimi}</span>
                        <span className="h-muted">{!l.online ? 'offline' : l.paalla ? `päällä${l.kirkkaus != null ? ` ${l.kirkkaus} %` : ''}` : 'pois'}</span>
                        <Btn small on={() => void act('valot', 'valo_aseta', { nimi: l.nimi, paalle: !l.paalla }, 30_000)} busy={busy}>{l.paalla ? 'Pois' : 'Päälle'}</Btn>
                      </div>
                    ))}
                  </div>
                ) : null}
              </>
            ) : sheet === 'ilp' ? (
              <>
                <div className="h-temp">
                  <Btn on={() => void act('ilp', 'ir_lampopumppu', { lampotila: Math.max(16, acTemp - 1) }, 30_000)} busy={busy} label="Lämpötila alas">−</Btn>
                  <span className="h-temp__val">{acTemp} °C</span>
                  <Btn on={() => void act('ilp', 'ir_lampopumppu', { lampotila: Math.min(30, acTemp + 1) }, 30_000)} busy={busy} label="Lämpötila ylös">+</Btn>
                </div>
                <div className="h-row">
                  <Btn on={() => void act('ilp', 'ir_lampopumppu', { virta: true }, 30_000)} busy={busy}>Päälle</Btn>
                  <Btn on={() => void act('ilp', 'ir_lampopumppu', { virta: false }, 30_000)} busy={busy}>Pois</Btn>
                </div>
                <div className="h-row" aria-label="Tila">
                  {['lämmitys', 'jäähdytys', 'auto', 'puhallus', 'kuivaus'].map((t) => (
                    <Btn key={t} sel={ac?.tila === t} on={() => void act('ilp', 'ir_lampopumppu', { tila: t }, 30_000)} busy={busy}>{cap(t)}</Btn>
                  ))}
                </div>
                <div className="h-row" aria-label="Puhallus">
                  {['auto', 'hiljainen', 'keski', 'kova'].map((f) => (
                    <Btn key={f} sel={ac?.puhallus === f} on={() => void act('ilp', 'ir_lampopumppu', { puhallus: f }, 30_000)} busy={busy}>Puhallus {f}</Btn>
                  ))}
                </div>
                <p className="h-note">IR on yksisuuntainen: JARVIS näkee vain sen, mitä viimeksi lähetettiin, ei pumpun todellista tilaa.</p>
              </>
            ) : sheet === 'projektori' ? (
              <>
                <div className="h-row">
                  <Btn on={() => void act('projektori', 'projektori_virta', { tila: 'paalle' }, 110_000)} busy={busy}>Päälle</Btn>
                  <Btn on={() => void act('projektori', 'projektori_virta', { tila: 'pois' }, 60_000)} busy={busy}>Valmiustilaan</Btn>
                  <Btn on={() => void act('projektori', 'projektori_nappain', { nappi: 'tarkenna' }, 30_000)} busy={busy}>Tarkenna</Btn>
                  <Btn on={() => void act('projektori', 'projektori_toisto', { toiminto: 'toista_tauko' }, 30_000)} busy={busy}>Toista / tauko</Btn>
                </div>
                <div className="h-row">
                  {['Netflix', 'YouTube', 'Yle Areena', 'Disney+', 'Spotify'].map((a) => (
                    <Btn key={a} on={() => void act('projektori', 'projektori_avaa', { sovellus: a }, 180_000)} busy={busy}>{a}</Btn>
                  ))}
                </div>
                <div className="h-row">
                  <Btn on={() => void act('projektori', 'projektori_aani', { muutos: -10 }, 30_000)} busy={busy}>Ääni −</Btn>
                  <Btn on={() => void act('projektori', 'projektori_aani', { muutos: 10 }, 30_000)} busy={busy}>Ääni +</Btn>
                  <button className="h-ghost" onClick={onRemote}>Koko kaukosäädin</button>
                </div>
              </>
            ) : sheet === 'imuri' ? (
              <div className="h-row">
                {[
                  ['aloita', 'Aloita siivous'],
                  ['tauko', 'Tauko'],
                  ['jatka', 'Jatka'],
                  ['kotiin', 'Telakkaan'],
                  ['etsi', 'Etsi (äänimerkki)'],
                ].map(([t, l]) => (
                  <Btn key={t} on={() => void act('imuri', 'imuri', { toiminto: t }, 110_000)} busy={busy}>{l}</Btn>
                ))}
              </div>
            ) : sheet === 'samsung' ? (
              <>
                <div className="h-row">
                  <Btn on={() => void act('samsung', 'samsung_virta', { tila: 'paalle' }, 40_000)} busy={busy}>Päälle</Btn>
                  <Btn on={() => void act('samsung', 'samsung_virta', { tila: 'pois' }, 40_000)} busy={busy}>Pois</Btn>
                  {['Spotify', 'Netflix', 'YouTube', 'Yle Areena', 'Disney+'].map((a) => (
                    <Btn key={a} on={() => void act('samsung', 'samsung_avaa', { sovellus: a }, 30_000)} busy={busy}>{a}</Btn>
                  ))}
                </div>
                <form
                  className="h-search"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const q = tvSong.trim()
                    if (q) void act('samsung', 'spotify_soita', { haku: q, laite: 'samsung' }, 60_000, () => setTvSong(''))
                  }}
                >
                  <input className="h-input" value={tvSong} onChange={(e) => setTvSong(e.target.value)} placeholder="Soita Spotifystä: kappale, artisti tai soittolista" aria-label="Spotify-haku Samsungille" />
                  <button className="h-btn" type="submit" disabled={!!busy || !tvSong.trim()}>Soita</button>
                </form>
                <div className="h-row" aria-label="Spotify">
                  <Btn on={() => void act('samsung', 'spotify_ohjaa', { toiminto: 'edellinen', laite: 'samsung' }, 30_000)} busy={busy} label="Edellinen kappale">⏮</Btn>
                  <Btn on={() => void act('samsung', 'spotify_ohjaa', { toiminto: 'tauko', laite: 'samsung' }, 30_000)} busy={busy}>Tauko</Btn>
                  <Btn on={() => void act('samsung', 'spotify_ohjaa', { toiminto: 'jatka', laite: 'samsung' }, 30_000)} busy={busy}>Jatka</Btn>
                  <Btn on={() => void act('samsung', 'spotify_ohjaa', { toiminto: 'seuraava', laite: 'samsung' }, 30_000)} busy={busy} label="Seuraava kappale">⏭</Btn>
                  <Btn on={() => void act('samsung', 'spotify_ohjaa', { toiminto: 'nyt' }, 30_000)} busy={busy}>Mikä soi</Btn>
                </div>
                {/* Kaukosäädin: liikkuminen missä tahansa sovelluksessa (Spotify, Netflix, valikot). Nopea: ei efektiä joka painallukselle. */}
                <div className="h-remote">
                  <div className="h-remote__pad">
                    <RKey k="ylös" label="Ylös" cls="up" tv={tvKey}>▲</RKey>
                    <RKey k="vasen" label="Vasen" cls="left" tv={tvKey}>◀</RKey>
                    <RKey k="ok" label="OK" cls="ok" tv={tvKey}>OK</RKey>
                    <RKey k="oikea" label="Oikea" cls="right" tv={tvKey}>▶</RKey>
                    <RKey k="alas" label="Alas" cls="down" tv={tvKey}>▼</RKey>
                  </div>
                  <div className="h-remote__side">
                    <RKey k="takaisin" label="Takaisin" tv={tvKey}>Takaisin</RKey>
                    <RKey k="koti" label="Koti" tv={tvKey}>Koti</RKey>
                    <RKey k="lähde" label="Lähde" tv={tvKey}>Lähde</RKey>
                    <RKey k="playpause" label="Toista tai tauko" tv={tvKey}>⏯</RKey>
                    <RKey k="ääni-" label="Ääni hiljemmalle" tv={tvKey}>Ääni −</RKey>
                    <RKey k="ääni+" label="Ääni kovemmalle" tv={tvKey}>Ääni +</RKey>
                    <RKey k="mykistä" label="Mykistä" tv={tvKey}>Mykistä</RKey>
                  </div>
                </div>
                <p className="h-note">Kappaleen haku ja soitto vaativat Spotify-yhteyden (tyokalut\asenna_spotify.bat, Spotify Premium). Kaukosäädin toimii ilman sitä.</p>
              </>
            ) : (
              <>
                <div className="h-row">
                  <Btn on={() => void openLive(!live)} busy={null}>{live ? 'Sulje kuva' : 'Avaa elävä kuva'}</Btn>
                  {(['vasen', 'ylös', 'alas', 'oikea'] as const).map((s) => (
                    <Btn key={s} on={() => void act('kamera', 'kamera_kaanna', { nimi: live?.cam, suunta: s }, 20_000)} busy={busy} label={`Käännä ${s}`}>
                      {s === 'vasen' ? '◀' : s === 'ylös' ? '▲' : s === 'alas' ? '▼' : '▶'}
                    </Btn>
                  ))}
                </div>
                {live ? (
                  <figure className="h-cam">
                    <img
                      key={live.n}
                      src={`${BRIDGE_HTTP_URL}/kamera.mjpg?nimi=${encodeURIComponent(live.cam)}&t=${encodeURIComponent(live.key)}&n=${live.n}`}
                      alt={`Kameran ${live.cam} elävä kuva`}
                      onError={() => (setLive(null), say('Kuvaa ei saatu. Onko kamera päällä ja yksityisyystila pois?'))}
                    />
                    <span className="h-cam__rec" aria-hidden="true">REC</span>
                  </figure>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </section>

      <section className="h-sec" aria-label="Keskustelu">
        <button className="h-ask" onClick={onChat}>
          <span className="h-ask__dot" aria-hidden="true" />
          Kysy JARVISilta: leffavinkit, sää, muistutukset…
        </button>
      </section>

      {toast || routineBusy ? (
        <div className="h-toast" role="status" aria-live="polite">
          {routineBusy && !toast ? 'Rutiini käynnissä… (projektorin herätys voi kestää minuutin)' : toast}
        </div>
      ) : null}
    </div>
  )
}

function Btn({ on, busy, sel, small, label, children }: { on: () => void; busy: string | null; sel?: boolean; small?: boolean; label?: string; children: ReactNode }) {
  return (
    <button className={`h-btn${sel ? ' is-sel' : ''}${small ? ' h-btn--small' : ''}`} disabled={!!busy} aria-pressed={sel} aria-label={label} onClick={on}>
      {children}
    </button>
  )
}

// ---- Työ (KalustoVahti) -------------------------------------------------------------------------------------
type WorkMeeting = { id: string; at: string; org: string; contact: string; type: string }
type WorkTask = { id: string; label: string; hint: string; fx: string; run: () => void }

const fiWhen = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : new Intl.DateTimeFormat('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
}

/**
 * Työ-tilan etusivu: tapaamiset, palattavat asiat ja työn pikatehtävät Reaktori-tyylillä.
 * Jokaisella tehtävällä oma efekti (tutka, asiakirjan skannaus, kirjoitusrivi, nousevat palkit, puhelun soitto,
 * kilpi) ennen kuin JARVIS aloittaa sen keskustelussa tai näkymä vaihtuu.
 */
export function WorkView({
  meetings,
  issues,
  leads,
  loaded,
  onAsk,
  onLeads,
  onPractice,
  onMeeting,
}: {
  meetings: WorkMeeting[]
  issues: string[]
  leads: number
  loaded: boolean
  onAsk: (text: string) => void
  onLeads: () => void
  onPractice: () => void
  onMeeting: () => void
}) {
  const [press, setPress] = useState<{ id: string; n: number } | null>(null)
  const go = (id: string, fn: () => void) => {
    setPress({ id, n: Date.now() })
    window.setTimeout(fn, 650)
  }
  const tasks: WorkTask[] = [
    { id: 'next', label: 'Mitä teen seuraavaksi', hint: 'CRM:stä tärkein ensin', fx: 'radar', run: () => onAsk('Katso CRM ja kerro mitä minun kannattaa tehdä myynnissä seuraavaksi, tärkein ensin. Perustele lyhyesti.') },
    { id: 'prep', label: 'Valmistele tapaaminen', hint: 'Valmistelukortti seuraavaan', fx: 'scan', run: () => onAsk('Valmistele seuraava tapaaminen. Kirjoita valmistelukortti kokonaan.') },
    { id: 'log', label: 'Kirjaa tapaamisen tulos', hint: 'Esikatselu ennen kirjausta', fx: 'write', run: () => onAsk('Haluan kirjata tapaamisen tuloksen CRM:ään. Kysy minulta yritys, tulos ja seuraava askel, ja näytä esikatselu ennen kirjausta.') },
    { id: 'week', label: 'Viikon luvut', hint: 'Mitä luvut kertovat', fx: 'bars', run: () => onAsk('Kerro tämän viikon myynnin luvut ja mitä ne kertovat.') },
    { id: 'practice', label: 'Harjoituspuhelu', hint: 'JARVIS esittää asiakasta', fx: 'ring', run: onPractice },
    { id: 'objection', label: 'Harjoittele vastaväite', hint: 'Arvio sinun tavallasi', fx: 'shield', run: () => onAsk('Esitä minulle yksi tyypillinen asiakkaan vastaväite Kalustovahdista ja arvioi vastaukseni minun myyntitapani mukaan.') },
    { id: 'leads', label: 'Liidit', hint: leads ? `${leads} tarkastettavana` : 'Hae uusia', fx: 'radar', run: onLeads },
    { id: 'meeting', label: 'Kokous tai koulutus', hint: 'JARVIS kuuntelee ja vinkkaa', fx: 'scan', run: onMeeting },
  ]
  return (
    <div className="h-root">
      <header className="h-head">
        <div className="h-reactor" aria-hidden="true">
          <span className="h-reactor__ring" />
          <span className="h-reactor__core" />
        </div>
        <div className="h-head__text">
          <h1 className="h-title">Työ</h1>
          <p className="h-status">
            <span className="h-led" aria-hidden="true" />
            KalustoVahti · oma keskustelu, erillään vapaa-ajasta
          </p>
        </div>
      </header>

      <section className="h-sec" aria-label="Pikatehtävät">
        <h2 className="h-h2">Tehtävät</h2>
        <div className="h-grid">
          {tasks.map((t) => (
            <div key={t.id} className={`h-tile h-tile--task${press?.id === t.id ? ' is-on' : ''}`}>
              <button className="h-tile__main" onClick={() => go(t.id, t.run)}>
                {press?.id === t.id ? (
                  <span key={press.n} className={`h-fx h-wfx--${t.fx}`} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                ) : null}
                <span className="h-tile__name">{t.label}</span>
                <span className="h-tile__state">{t.hint}</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="h-sec" aria-label="Tapaamiset">
        <h2 className="h-h2">Tulevat tapaamiset</h2>
        <div className="h-list h-list--panel">
          {!loaded ? (
            <p className="h-note">Haetaan CRM:stä…</p>
          ) : meetings.length ? (
            meetings.slice(0, 5).map((m) => (
              <div key={m.id} className="h-list__row">
                <span>
                  <strong>{m.org}</strong>
                  <span className="h-muted"> {fiWhen(m.at)}{m.contact ? `, ${m.contact}` : ''}</span>
                </span>
                <span className="h-muted">{m.type}</span>
                <button className="h-btn h-btn--small" onClick={() => onAsk(`Valmistele tapaaminen: ${m.org} (${fiWhen(m.at)}). Kirjoita valmistelukortti kokonaan.`)}>Valmistele</button>
              </div>
            ))
          ) : (
            <p className="h-note">Ei tulevia tapaamisia CRM:ssä.</p>
          )}
        </div>
      </section>

      {issues.length ? (
        <section className="h-sec" aria-label="Palaa näihin">
          <h2 className="h-h2">Palaa näihin</h2>
          <div className="h-list h-list--panel">
            {issues.slice(0, 5).map((x) => (
              <div key={x} className="h-list__row h-list__row--2">
                <span>{x}</span>
                <button className="h-btn h-btn--small" onClick={() => onAsk(`Kerro lisää ja ehdota seuraava askel: ${x}`)}>Kysy</button>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function RKey({ k, label, cls, tv, children }: { k: string; label: string; cls?: string; tv: (k: string) => void; children: ReactNode }) {
  return (
    <button type="button" className={`h-rkey${cls ? ` h-rkey--${cls}` : ''}`} aria-label={label} onClick={() => tv(k)}>
      {children}
    </button>
  )
}
