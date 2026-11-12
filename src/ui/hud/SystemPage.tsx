/**
 * JÄRJESTELMÄ (both modes): only real status the UI already receives — bridge connection, model and limits
 * ('tanaan' system block), device integrations (koti_tila) — plus local display settings and shortcuts.
 */
import { useState, type ReactNode } from 'react'
import { note, useHud, type Fx } from './core'
import { Pnl, Range, Seg, Tog } from './controls'
import { Ic } from './icons'
import type { Koti } from './HomePages'

export type SystemInfo = { model: string; fast: string; limited: boolean; phone: boolean; telegram: boolean; meeting: boolean }

type Svc = { n: string; d: string; s: 'ok' | 'a' | 'r' }

export function SystemPage({
  work,
  connected,
  phase,
  system,
  k,
  onAsk,
  onDevices,
  onLearn,
  onNewChat,
  theme,
  onTheme,
  extra,
}: {
  work: boolean
  connected: boolean
  phase: string
  system: SystemInfo | null
  k: Koti | null
  onAsk: (t: string) => void
  onDevices: () => void
  onLearn: () => void
  onNewChat: () => void
  theme: 'dark' | 'light'
  onTheme: () => void
  extra?: ReactNode
}) {
  const st = useHud((s) => s.settings)
  const set = useHud((s) => s.set)
  const [open, setOpen] = useState(false)
  const svcs: Svc[] = [
    { n: 'Silta', d: connected ? `Yhdistetty · ${phase}` : 'Ei yhteyttä', s: connected ? 'ok' : 'r' },
  ]
  if (system) {
    svcs.push({ n: 'Malli', d: `${system.model.replace('claude-', '')} · kevyt ${system.fast.replace('claude-', '')}`, s: system.limited ? 'a' : 'ok' })
    svcs.push({ n: 'Säästötila', d: system.limited ? 'Päällä: käyttöraja täynnä' : 'Pois', s: system.limited ? 'a' : 'ok' })
    svcs.push({ n: 'Telegram', d: system.telegram ? 'Yhdistetty' : 'Pois', s: system.telegram ? 'ok' : 'a' })
    svcs.push({ n: 'Puhelin', d: system.phone ? 'Ilmoitukset käytössä' : 'Pois', s: system.phone ? 'ok' : 'a' })
    svcs.push({ n: 'Kokous', d: system.meeting ? 'Käynnissä' : 'Ei käynnissä', s: 'ok' })
  }
  if (k) {
    const dev = (n: string, p: { asennettu: boolean; virhe?: string } | undefined, okText: string) =>
      svcs.push({ n, d: !p?.asennettu ? 'Ei yhdistetty' : p.virhe ? `Ei vastaa: ${p.virhe.slice(0, 60)}` : okText, s: !p?.asennettu ? 'a' : p.virhe ? 'r' : 'ok' })
    dev('Valot', k.valot, `${k.valot.lista?.length ?? 0} lamppua (Tuya)`)
    dev('IR / ILP', k.ilp, 'IR-ohjain (viimeksi asetettu)')
    dev('Projektori', k.projektori, 'ADB')
    dev('Samsung', k.samsung, 'Lähiverkko')
    dev('Imuri', k.imuri, 'Roborock')
    dev('Kamera', k.kamera, (k.kamera.kamerat ?? []).join(', ') || 'Tapo')
  }
  return (
    <div className="pgi g-sys">
      <Pnl n="12" title="PALVELUT" right={<span>TOSIAIKAINEN TILA</span>} className="wide" i={0}>
        <div className="svcs">
          {svcs.map((s) => (
            <div key={s.n} className="svc">
              <span className={`dot ${s.s === 'ok' ? '' : s.s}`} />
              <b>{s.n}</b>
              <small>{s.d}</small>
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn" onClick={() => onAsk('Tarkista palvelut ja kerro mikä ei toimi.')}>
            TARKISTA PALVELUT
          </button>
          <button className="btn" onClick={() => onAsk('Mitä päivityksiä sinuun on tehty?')}>
            MITÄ UUTTA?
          </button>
          <button className="btn" onClick={() => onAsk('Mitä vikoja olet kirjannut itsestäsi ja mitkä ovat vielä auki?')}>
            VIAT & OPIT
          </button>
        </div>
      </Pnl>
      <Pnl n="13" title="TYÖKALUT" i={1}>
        <div className="list">
          <button className="btn wide" onClick={onDevices}>
            <Ic n="tv" />
            LAITTEET: KAIKKI OHJAIMET
          </button>
          <button className="btn wide" onClick={onLearn}>
            <Ic n="core" />
            MUISTI JA OPIT
          </button>
          <button className="btn wide" onClick={onNewChat}>
            <Ic n="undo" />
            UUSI KESKUSTELU
          </button>
        </div>
      </Pnl>
      <Pnl n="14" title="TILA" i={2}>
        <p className="sub">{work ? 'Työ-tila: oma keskustelu, erillään vapaa-ajasta ja Telegramista.' : 'Koti-tila: sama keskustelu kuin Telegramissa.'}</p>
        {extra}
      </Pnl>
      <Pnl
        n="15"
        title="NÄYTTÖ & SUORITUSKYKY"
        right={
          <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'PIILOTA' : <><Fps /> · ASETUKSET</>}
          </button>
        }
        className="wide"
        i={3}
      >
        <div className="setgrid" hidden={!open}>
          <div>
            <div className="lbl" style={{ marginTop: 0 }}>
              EFEKTIT
            </div>
            <Seg
              opts={[
                { v: 2, label: 'Täysi' },
                { v: 1, label: 'Kevyt' },
                { v: 0, label: 'Pois' },
              ]}
              value={st.fx}
              label="Efektit"
              onChange={(v) => (set('fx', v as Fx), note('Efektit: ' + ['Pois', 'Kevyt', 'Täysi'][v as number], 'paikallinen asetus'))}
            />
          </div>
          <div>
            <div className="lbl" style={{ marginTop: 0 }}>
              MAAPALLON TARKKUUS
            </div>
            <Seg
              opts={[
                { v: 0, label: 'Kevyt' },
                { v: 1, label: 'Normaali' },
                { v: 2, label: 'Tarkka' },
              ]}
              value={st.q}
              label="Maapallon tarkkuus"
              onChange={(v) => (set('q', v as 0 | 1 | 2), note('Maapallo: ' + ['Kevyt', 'Normaali', 'Tarkka'][v as number], `${[1400, 2600, 4000][v as number]} pistettä`))}
            />
          </div>
          <div>
            <div className="lbl" style={{ marginTop: 0 }}>
              KOROSTUSVÄRI (KOTI) <b>{st.hue}°</b>
            </div>
            <Range className="hue" min={0} max={360} value={st.hue} label="Korostusväri" onInput={(v) => set('hue', v)} onCommit={(v) => set('hue', v)} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignSelf: 'end' }}>
            <span className="sub">VÄRINÄPALAUTE (ANDROID)</span>
            <Tog on={st.hap} label="Värinäpalaute" onChange={(v) => set('hap', v)} />
          </div>
          <div className="row" style={{ justifyContent: 'space-between', alignSelf: 'end' }}>
            <span className="sub">VAALEA TEEMA (LOMAKENÄKYMÄT)</span>
            <Tog on={theme === 'light'} label="Vaalea teema" onChange={onTheme} />
          </div>
        </div>
      </Pnl>
      <LatencyPanel />
    </div>
  )
}

/** The globe's frame rate (updates every second — kept out of the page so the page does not re-render). */
function Fps() {
  const fps = useHud((s) => s.fps)
  return <>{fps} FPS</>
}

const DEV_LABEL: Record<string, string> = { valot: 'Valot', projektori: 'Projektori', samsung: 'Samsung', imuri: 'Imuri', ilp: 'Lämpöpumppu', kamera: 'Kamera' }
const msCls = (ms: number, ok = true) => (!ok ? 'bad' : ms > 2500 ? 'bad' : ms > 800 ? 'slow' : '')
const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s} s sitten` : `${Math.round(s / 60)} min sitten`
}

/** VIIVE: last 20 commands (tap → bridge reply), the koti_tila answer time and each device's last update. */
function LatencyPanel() {
  const [open, setOpen] = useState(false)
  return (
    <Pnl
      n="16"
      title="VIIVE"
      className="wide"
      i={4}
      right={
        <button className="btn sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'PIILOTA' : 'LISÄÄ'}
        </button>
      }
    >
      {open ? <LatencyTable /> : <p className="sub">Komentojen ja laitteiden vasteajat tällä laitteella.</p>}
    </Pnl>
  )
}

function LatencyTable() {
  const lat = useHud((s) => s.lat)
  const home = useHud((s) => s.homeLat)
  const dev = useHud((s) => s.devLat)
  const ok = lat.filter((l) => l.ok).map((l) => l.ms).sort((a, b) => a - b)
  const median = ok.length ? ok[Math.floor(ok.length / 2)] : null
  return (
    <div className="setgrid">
      <div>
        <div className="lbl" style={{ marginTop: 0 }}>
          KOMENNOT (VIIMEISET 20){median != null ? <b>MEDIAANI {median} MS</b> : null}
        </div>
        {lat.length ? (
          <table className="lat">
            <tbody>
              {lat.map((l) => (
                <tr key={l.t + l.label}>
                  <td>{l.label}</td>
                  <td className={msCls(l.ms, l.ok)}>{l.ok ? `${l.ms} ms` : `virhe · ${l.ms} ms`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="sub">Ei vielä komentoja tällä kerralla.</p>
        )}
      </div>
      <div>
        <div className="lbl" style={{ marginTop: 0 }}>
          LAITTEIDEN TILA
        </div>
        <table className="lat">
          <tbody>
            <tr>
              <td>koti_tila (vastaus välimuistista)</td>
              <td className={home ? msCls(home.ms) : ''}>{home ? `${home.ms} ms` : '—'}</td>
            </tr>
            {Object.entries(dev).map(([k, d]) => (
              <tr key={k}>
                <td>
                  {DEV_LABEL[k] ?? k} · {ago(d.t)}
                </td>
                <td className={d.kesto != null ? msCls(d.kesto) : ''}>{d.kesto != null ? `${d.kesto} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="sub" style={{ marginTop: 8 }}>
          Laitteen ms = kauanko laite vastasi sillalle (taustalla, ei odota sivua).
        </p>
      </div>
    </div>
  )
}
