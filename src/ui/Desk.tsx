/**
 * JARVIS — sovellus.
 *
 * Valikko: Keskustelu (sama keskustelu kuin Telegramissa + Tänään-palsta), Liidit, Kokous,
 * Koulutus ja Myyntioppi. Kaikki muu kuin itse keskustelu toimii suorilla bridge-pyynnöillä
 * ilman kielimallia, joten näkymät eivät kuluta krediittejä — paitsi liidien pisteytys
 * (Opus, kerran per haku) ja kokouksen yhteenveto.
 */
import { Fragment, lazy, memo, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import { useStore, type Turn } from '../store'
import { request } from '../lib/brain'
import { sanitisePanelHtml } from './sanitise'
import { BRIDGE_HTTP_URL, MODE } from '../config'
import './hud/hud.css'
import { Shell, useNav, type PageDef } from './hud/Shell'
import { log as hudLog } from './hud/core'
import { IlmaPage, KotiPage, TurvaPage, ViihdePage, useHome, type Home } from './hud/HomePages'
import { SystemPage } from './hud/SystemPage'
import type { Pipe } from './hud/pipeline'
import type { MorningPack } from './hud/WorkPages'

// Loaded only when needed (9.11.2026, nopeus): NÄYTTÖ when that page is first approached, the Työ pages only in
// Työ mode — the Koti first paint does not download or parse them.
const ScreenPage = lazy(() => import('./hud/ScreenPage').then((m) => ({ default: memo(m.ScreenPage) })))
const TyopaivaPage = lazy(() => import('./hud/WorkPages').then((m) => ({ default: m.TyopaivaPage })))
const LiiditPage = lazy(() => import('./hud/WorkPages').then((m) => ({ default: m.LiiditPage })))
const KokousPage = lazy(() => import('./hud/WorkPages').then((m) => ({ default: m.KokousPage })))
import { Ic } from './hud/icons'
import { logout } from '../lib/bridge'

type Meeting = { id: string; at: string; org: string; contact: string; seller: string; type: string; location: string }
type Contact = { name: string; title: string; phone: string; phoneIsPersonal?: boolean; email: string; linkedin: string; companyLinkedin: string; source: string }
type Lead = {
  n: number
  name: string
  businessId: string
  city: string
  line: string
  score: number | null
  fleet: string
  reasons: string[]
  risk: string
  website: string
  below: boolean
  rejected: boolean
  approved: boolean
  contact: Contact | null
  need?: number | null
  deep?: boolean
  evidence?: { fact: string; url: string }[]
}
type Leads = { list: Lead[]; stats: string }
type Dash = {
  crm: null | { at: string; meetings: Meeting[]; issues: string[]; counts: Record<string, number>; leads: Leads; pipe?: Pipe | null }
  aamupaketti?: MorningPack | null
  system: { model: string; fast: string; limited: boolean; phone: boolean; telegram: boolean; meeting: boolean }
}
type Props = {
  onSend: (text: string) => void
  onMic: () => void
  onStop: () => void
  onNewChat: () => void
  onShareAudio: () => void
  audioShared: boolean
  speakOn: boolean
  onSpeak: (on: boolean) => void
  voiceReady: boolean
  onPracticeStart: () => void
  onPracticeSay: (text: string) => void
}

const PHASE: Record<string, string> = {
  offline: 'Yhdistää',
  boot: 'Yhdistää',
  dormant: 'Valmis',
  waking: 'Kuuntelee',
  listening: 'Kuuntelee',
  thinking: 'Miettii',
  tooling: 'Hakee',
  speaking: 'Vastaa',
}

// Tila (8.11.2026): Koti = vapaa-aika, Työ = KalustoVahti. JARVIS 2.0 (9.11.): näkymät ovat HUD-sivuja (Desk alla).
const HOME_QUICK: Array<{ label: string; text: string }> = [
  { label: 'Leffavinkki tälle illalle', text: 'Mitä kannattaisi katsoa tänä iltana? Anna kolme vaihtoehtoa eri tunnelmiin.' },
  { label: 'Sää huomenna', text: 'Millainen sää on huomenna?' },
  { label: 'Mitä laitteita on päällä', text: 'Mitkä kodin laitteet ovat nyt päällä?' },
  { label: 'Muistuta minua', text: 'Haluan asettaa muistutuksen. Kysy mitä ja milloin.' },
]

const QUICK: Array<{ label: string; text: string }> = [
  { label: 'Mitä teen seuraavaksi', text: 'Katso CRM ja kerro mitä minun kannattaa tehdä myynnissä seuraavaksi, tärkein ensin. Perustele lyhyesti.' },
  { label: 'Valmistele tapaaminen', text: 'Valmistele seuraava tapaaminen. Kirjoita valmistelukortti kokonaan.' },
  { label: 'Kirjaa tapaamisen tulos', text: 'Haluan kirjata tapaamisen tuloksen CRM:ään. Kysy minulta yritys, tulos ja seuraava askel, ja näytä esikatselu ennen kirjausta.' },
  { label: 'Viikon luvut', text: 'Kerro tämän viikon myynnin luvut ja mitä ne kertovat.' },
  { label: 'Harjoituspuhelu', text: 'Aloitetaan harjoituspuhelu: esitä asiakasta, minä myyn.' },
  { label: 'Harjoittele vastaväite', text: 'Esitä minulle yksi tyypillinen asiakkaan vastaväite Kalustovahdista ja arvioi vastaukseni minun myyntitapani mukaan.' },
]

const LINES = [
  { code: '', label: 'Kaikki kohdetoimialat' },
  { code: '81100', label: 'Kiinteistöhuolto' },
  { code: '43220', label: 'LVI-asennus' },
  { code: '43210', label: 'Sähköasennus' },
  { code: '43', label: 'Rakentaminen (saneeraus, maanrakennus)' },
  { code: '41200', label: 'Talonrakentaminen' },
  { code: '49410', label: 'Kuljetus' },
  { code: '53200', label: 'Jakelu ja kuriiri' },
  { code: '81300', label: 'Viherrakentaminen' },
]
const CITIES = ['Helsinki', 'Espoo', 'Vantaa', 'Turku', 'Kaarina', 'Raisio', 'Naantali', 'Lieto', 'Kerava', 'Tampere', 'Pori']
const REJECT_REASONS = ['liian pieni', 'ei autoja', 'väärä toimiala', 'liian iso', 'muu']

const fiDay = new Intl.DateTimeFormat('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', timeZone: 'Europe/Helsinki' })
const fiTime = new Intl.DateTimeFormat('fi-FI', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Helsinki' })
const clock = (d: Date) => fiTime.format(d).replace(':', '.')
const errText = (err: unknown) => String((err as Error)?.message ?? err)

// ---------------------------------------------------------------------------------------------
// Pienet palat
// ---------------------------------------------------------------------------------------------

/** Pelkkä teksti + klikattavat linkit. Ei innerHTML:ää: mallin teksti ei pääse DOMiin merkintöinä. */
function Rich({ text }: { text: string }) {
  const lines = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .split('\n')
  return (
    <>
      {lines.map((line, i) => (
        <Fragment key={i}>
          {linkify(line)}
          {i < lines.length - 1 ? <br /> : null}
        </Fragment>
      ))}
    </>
  )
}

function linkify(line: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(https?:\/\/[^\s<>"')\]]+)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) {
    if (m.index > last) out.push(line.slice(last, m.index))
    const url = m[1]
    out.push(
      <a key={m.index} href={url} target="_blank" rel="noopener noreferrer">
        {url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 48)}
      </a>,
    )
    last = m.index + url.length
  }
  if (last < line.length) out.push(line.slice(last))
  return out
}

function Message({ turn }: { turn: Turn }) {
  const tg = turn.channel === 'telegram'
  return (
    <div className={`d-msg d-msg--${turn.role}${tg ? ' d-msg--tg' : ''}`}>
      <div className="d-msg__who">
        {turn.role === 'user' ? 'Sinä' : 'JARVIS'}
        {tg ? <span className="d-msg__ch">Telegram</span> : null}
      </div>
      <div className="d-msg__text">{turn.text ? <Rich text={turn.text} /> : <span className="d-dots">···</span>}</div>
    </div>
  )
}

function Html({ html }: { html: string }) {
  return <div className="d-card__body" dangerouslySetInnerHTML={{ __html: sanitisePanelHtml(html) }} />
}

function LeadCard({ l, onDone, setNote }: { l: Lead; onDone: () => void; setNote: (s: string) => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [busy, setBusy] = useState(false)
  const approve = async () => {
    setBusy(true)
    try {
      const r = await request<{ inserted: number; skipped: number; names: string[] }>('liidit_hyvaksy', { numerot: [l.n] })
      setNote(r.inserted ? `${r.names.join(', ')} lisätty CRM:n Liidit-näkymään myyjille.` : 'Liidi oli jo CRM:ssä.')
      onDone()
    } catch (err) {
      setNote(`Hyväksyntä epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const reject = async (why: string) => {
    setBusy(true)
    setRejecting(false)
    try {
      await request('liidit_hylkaa', { numerot: [l.n], syy: why })
      setNote(`${l.name} hylätty (${why}). Liidikone oppii tästä.`)
      onDone()
    } catch (err) {
      setNote(`Hylkäys epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`d-lead${l.below ? ' d-lead--below' : ''}`}>
      <div className="d-lead__head">
        <span className="d-score" title="Liidikoneen pisteet 0–100">{l.score ?? '–'}</span>
        <div>
          <b>{l.name}</b>
          <span className="d-muted">
            {l.line} · {l.city} · autoja {l.fleet || '?'}
            {l.need != null ? ` · tarve ${l.need}/100` : ''}
            {l.deep ? ' · tutkittu verkosta' : ''}
            {l.below ? ' · alle kynnyksen' : ''}
          </span>
        </div>
      </div>
      {l.reasons.length ? (
        <div className="d-lead__why">
          {l.reasons.map((r) => (
            <p key={r}>{r}</p>
          ))}
        </div>
      ) : null}
      {l.evidence?.length ? (
        <details className="d-lead__src">
          <summary>Lähteet ({l.evidence.length})</summary>
          <ul>
            {l.evidence.map((e) => (
              <li key={e.fact}>
                {e.fact}
                {e.url ? (
                  <>
                    {' '}
                    <a href={e.url} target="_blank" rel="noreferrer">
                      {(() => {
                        try {
                          return new URL(e.url).hostname.replace(/^www\./, '')
                        } catch {
                          return 'linkki'
                        }
                      })()}
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {l.risk ? <p className="d-lead__risk">⚠ {l.risk}</p> : null}
      <p className="d-lead__contact">
        {l.contact ? (
          <>
            {l.contact.name ? `${l.contact.name}${l.contact.title ? `, ${l.contact.title}` : ''}` : 'Yleinen'}
            {l.contact.phone ? (
              <>
                {' · '}
                <a href={`tel:${l.contact.phone.replace(/\s/g, '')}`}>{l.contact.phone}</a>
              </>
            ) : null}
            {l.contact.email ? (
              <>
                {' · '}
                <a href={`mailto:${l.contact.email}`}>{l.contact.email}</a>
              </>
            ) : null}
            {l.contact.linkedin ? (
              <>
                {' · '}
                <a href={l.contact.linkedin} target="_blank" rel="noopener noreferrer">
                  LinkedIn
                </a>
              </>
            ) : null}
          </>
        ) : (
          <span className="d-muted">Yhteyshenkilöä ei löytynyt sivuilta</span>
        )}
      </p>
      {rejecting ? (
        <div className="d-reasons">
          {REJECT_REASONS.map((r) => (
            <button key={r} onClick={() => void reject(r)}>
              {r}
            </button>
          ))}
          <button className="d-link" onClick={() => setRejecting(false)}>
            peru
          </button>
        </div>
      ) : (
        <div className="d-lead__actions">
          <button className="d-yes" disabled={busy} onClick={() => void approve()}>
            Hyväksy CRM:ään
          </button>
          <button className="d-no" disabled={busy} onClick={() => setRejecting(true)}>
            Hylkää
          </button>
          {l.website ? (
            <a href={l.website.startsWith('http') ? l.website : `https://${l.website}`} target="_blank" rel="noopener noreferrer">
              Sivut
            </a>
          ) : null}
          <a href={`https://www.finder.fi/search?what=${encodeURIComponent(l.businessId)}`} target="_blank" rel="noopener noreferrer">
            Koko
          </a>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Näkymät
// ---------------------------------------------------------------------------------------------

function TodayRail({ dash, dashErr, load, send, goLeads }: { dash: Dash | null; dashErr: string | null; load: () => void; send: (t: string) => void; goLeads: () => void }) {
  const [note, setNote] = useState<string | null>(null)
  const meetingsByDay = useMemo(() => {
    const groups: Array<{ day: string; items: Meeting[] }> = []
    for (const m of dash?.crm?.meetings ?? []) {
      const day = fiDay.format(new Date(m.at))
      const g = groups.find((x) => x.day === day)
      if (g) g.items.push(m)
      else groups.push({ day, items: [m] })
    }
    return groups
  }, [dash])
  const openLeads = (dash?.crm?.leads.list ?? []).filter((l) => !l.rejected && !l.approved)

  return (
    <aside className="d-rail" aria-label="Tänään">
      <section className="d-block">
        <h2>
          Tapaamiset <small>7 pv</small>
        </h2>
        {dashErr ? <p className="d-muted">{dashErr}</p> : null}
        {dash && !dash.crm ? <p className="d-muted">CRM ei ole yhdistetty.</p> : null}
        {dash?.crm && !meetingsByDay.length ? <p className="d-muted">Ei sovittuja tapaamisia.</p> : null}
        {meetingsByDay.map((g) => (
          <div key={g.day} className="d-day">
            <div className="d-day__label">{g.day}</div>
            {g.items.map((m) => (
              <button key={m.id} className="d-row" onClick={() => send(`Valmistele tapaaminen: ${m.org}. Kirjoita valmistelukortti kokonaan.`)} title="Valmistele tämä tapaaminen">
                <span className="d-row__time">{clock(new Date(m.at))}</span>
                <span className="d-row__main">
                  <b>{m.org}</b>
                  <span>
                    {m.type}
                    {m.contact ? ` · ${m.contact}` : ''}
                    {m.seller && m.seller !== '—' ? ` · ${m.seller.split(' ')[0]}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        ))}
      </section>

      <section className="d-block">
        <h2>Palaa näihin</h2>
        {dash?.crm && !dash.crm.issues.length ? <p className="d-muted">Putki on kunnossa.</p> : null}
        {(dash?.crm?.issues ?? []).map((t, i) => (
          <div key={i} className="d-issue">
            <span>{t}</span>
            <span className="d-issue__actions">
              {/kirjaamatta/.test(t) ? (
                <button className="d-chip" onClick={() => send(`Kirjaa CRM:ään tulos tälle tapaamiselle: ${t}. Kysy minulta ensin tulos ja seuraava askel, näytä esikatselu ennen kirjausta.`)}>
                  Kirjaa tulos
                </button>
              ) : null}
              <button className="d-chip" onClick={() => send(`Mitä teen tälle: ${t}`)}>
                Kysy neuvoa
              </button>
            </span>
          </div>
        ))}
      </section>

      <section className="d-block">
        <h2>
          Liidit tarkastettavana <small>{openLeads.length || ''}</small>
        </h2>
        {note ? <p className="d-note">{note}</p> : null}
        {dash?.crm && !openLeads.length ? (
          <p className="d-muted">
            Ei tarkastettavia.{' '}
            <button className="d-link" onClick={goLeads}>
              Hae uusia
            </button>
          </p>
        ) : null}
        {openLeads.slice(0, 3).map((l) => (
          <LeadCard key={l.businessId} l={l} onDone={load} setNote={setNote} />
        ))}
        {openLeads.length > 3 ? (
          <button className="d-link" onClick={goLeads}>
            Kaikki {openLeads.length} liidiä →
          </button>
        ) : null}
      </section>

      <footer className="d-sys">
        {dash?.system ? (
          <>
            <span>
              Malli {dash.system.model.replace('claude-', '')} · kevyt {dash.system.fast}
            </span>
            <span>Telegram {dash.system.telegram ? 'yhdistetty' : 'pois'}</span>
          </>
        ) : (
          <span>Yhdistetään…</span>
        )}
        <button className="d-link" onClick={load}>
          Päivitä
        </button>
      </footer>
    </aside>
  )
}

function LeadsView({ dash, load }: { dash: Dash | null; load: () => void }) {
  const [line, setLine] = useState('')
  const [city, setCity] = useState('')
  const [count, setCount] = useState(5)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [rule, setRule] = useState('')
  const [leads, setLeads] = useState<Leads | null>(null)
  const shown = leads ?? dash?.crm?.leads ?? null
  const open = (shown?.list ?? []).filter((l) => !l.rejected && !l.approved)
  const done = (shown?.list ?? []).filter((l) => l.rejected || l.approved)

  const search = async () => {
    setBusy(true)
    setNote('Haetaan PRH:n rekisteristä, tutkitaan yritysten sivut ja pisteytetään (Opus). Kestää 1–3 minuuttia…')
    try {
      const r = await request<Leads & { found: number }>('liidit_hae', { toimiala: line || undefined, kaupunki: city || undefined, maara: count }, 900_000)
      setLeads(r)
      setNote(r.found ? `Löytyi ${r.found}. Tarkasta alla: hyväksy CRM:ään tai hylkää syyn kanssa.` : 'Ei riittävän hyviä liidejä tällä haulla — kokeile toista toimialaa tai kaupunkia.')
      load()
    } catch (err) {
      setNote(`Haku epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const refresh = () => {
    setLeads(null)
    load()
  }
  const saveRule = async () => {
    try {
      await request('liidisaanto', { saanto: rule })
      setNote(`Sääntö tallennettu liidioppiin: ${rule}`)
      setRule('')
    } catch (err) {
      setNote(`Sääntöä ei tallennettu: ${errText(err)}`)
    }
  }

  return (
    <div className="d-page">
      <h1>Liidit</h1>
      <p className="d-lede">Liidikone hakee yritysrekisteristä kohdetoimialan osakeyhtiöt, joilla on palkattua henkilöstöä ja joita ei vielä ole CRM:ssä, tutkii niiden sivut ja etsii päättäjän yhteystiedot. Sinä hyväksyt ennen kuin mikään menee myyjille.</p>
      <form
        className="d-form"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <label>
          Toimiala
          <select value={line} onChange={(e) => setLine(e.target.value)}>
            {LINES.map((x) => (
              <option key={x.code} value={x.code}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Kaupunki
          <input list="d-cities" value={city} placeholder="Kaikki kohdekaupungit" onChange={(e) => setCity(e.target.value)} />
          <datalist id="d-cities">
            {CITIES.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label>
          Määrä
          <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
            {[3, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <button className="d-send" type="submit" disabled={busy}>
          {busy ? 'Haetaan…' : 'Hae liidit'}
        </button>
      </form>
      {note ? <p className="d-note">{note}</p> : null}
      <div className="d-grid">
        {open.map((l) => (
          <LeadCard key={l.businessId} l={l} onDone={refresh} setNote={setNote} />
        ))}
      </div>
      {!open.length && !busy ? <p className="d-muted">Ei tarkastettavia liidejä.</p> : null}
      {done.length ? (
        <p className="d-muted d-small">
          Käsitelty tältä listalta: {done.map((l) => `${l.name} (${l.approved ? 'hyväksytty' : 'hylätty'})`).join(', ')}
        </p>
      ) : null}
      {shown?.stats ? <p className="d-muted d-small">{shown.stats}</p> : null}

      <section className="d-block d-block--inline">
        <h2>Opeta liidikonetta</h2>
        <p className="d-muted">Oma sääntö, jota pisteytys noudattaa aina. Esim. "kiinteistöhuoltoyhtiöt ovat parhaita" tai "älä ehdota alle 5 hengen sähköfirmoja".</p>
        <div className="d-inline">
          <input value={rule} placeholder="Kirjoita sääntö…" onChange={(e) => setRule(e.target.value)} />
          <button className="d-ghost" disabled={rule.trim().length < 5} onClick={() => void saveRule()}>
            Tallenna sääntö
          </button>
        </div>
      </section>
    </div>
  )
}

type MemoryRow = { at: string; kind: string; topic: string; orgName: string | null; outcome: string | null; outcomeDetail?: string; learned: boolean }
const OUTCOME_FI: Record<string, string> = { kauppa: 'Kauppa', hävitty: 'Hävitty', tarjous: 'Tarjous', avoin: 'Avoin' }

function MeetingView({ kind, active, blade, onChange, send }: { kind: 'asiakas' | 'koulutus'; active: boolean; blade?: { html?: string; title: string }; onChange: () => void; send: (text: string) => void }) {
  const [memory, setMemory] = useState<MemoryRow[] | null>(null)
  const [topic, setTopic] = useState('')
  const [people, setPeople] = useState('')
  const [goal, setGoal] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const training = kind === 'koulutus'
  const loadMemory = useCallback(async () => {
    try {
      const r = await request<{ kokoukset: MemoryRow[] }>('kokousmuisti')
      setMemory(r.kokoukset.filter((m) => m.kind === kind).slice(0, 8))
    } catch {
      setMemory(null)
    }
  }, [kind])
  useEffect(() => {
    void loadMemory()
  }, [loadMemory, active])

  const start = async () => {
    setBusy(true)
    setSummary(null)
    try {
      await request('kokous_aloita', { tyyppi: kind, aihe: topic, osallistujat: people, tavoite: goal })
      onChange()
      setNote('Pieni JARVIS-ikkuna aukeaa näytön oikeaan alakulmaan ja kuuntelee. Jos puhelu on kuulokkeissa, paina siinä "Jaa puhelun ääni" ja valitse Koko näyttö + Jaa järjestelmän ääni.')
    } catch (err) {
      setNote(`Aloitus epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const stop = async () => {
    setBusy(true)
    setNote(training ? 'Tehdään yhteenveto ja tallennetaan opit (Opus) — kestää hetken…' : 'Tehdään yhteenveto ja CRM-kirjaus — kestää hetken…')
    try {
      const r = await request<{ summary: string }>('kokous_lopeta', {}, 240_000)
      setSummary(r.summary)
      onChange()
      void loadMemory()
      setNote(training ? 'Valmis. Opit on tallennettu myyntioppiin, ja yhteenveto lähti puhelimeen.' : 'Valmis. Yhteenveto lähti myös puhelimeen.')
    } catch (err) {
      setNote(`Lopetus epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="d-page">
      <h1>{training ? 'Koulutustila' : 'Kokoustila'}</h1>
      <p className="d-lede">
        {training
          ? 'Kun koulutat myyjää (tai selität omaa tapaasi myydä), JARVIS kuuntelee keskeyttämättä ja oppii. Välivinkkejä ei tule — väliyhteenveto 5 min välein ja lopuksi opit tallentuvat myyntioppiin, jota JARVIS käyttää kaikessa.'
          : 'Asiakastapaamisessa JARVIS kuuntelee ja antaa hiljaiset vinkit pieneen kulmaikkunaan: mitä kysyä seuraavaksi, vastausehdotukset ja käsittelemättä jääneet asiat. Lopuksi valmis CRM-kirjaus.'}
      </p>
      {!active ? (
        <form
          className="d-form d-form--stack"
          onSubmit={(e) => {
            e.preventDefault()
            void start()
          }}
        >
          <label>
            {training ? 'Aihe' : 'Asiakas ja aihe'}
            <input value={topic} placeholder={training ? 'Esim. Nicolaksen myyntikoulutus: ensitapaaminen' : 'Esim. Lännen Palveluyhtiöt, kartoitus'} onChange={(e) => setTopic(e.target.value)} />
          </label>
          <label>
            Osallistujat
            <input value={people} placeholder={training ? 'Esim. Myyjä2, uusi myyjä' : 'Esim. Kalle Kivelä, toimitusjohtaja'} onChange={(e) => setPeople(e.target.value)} />
          </label>
          <label>
            <span>
              Tavoite <span className="d-muted">(valinnainen)</span>
            </span>
            <input value={goal} placeholder={training ? 'Esim. opettaa kartoituskysymykset' : 'Esim. sopia kartoituskäynti'} onChange={(e) => setGoal(e.target.value)} />
          </label>
          <button className="d-send" type="submit" disabled={busy}>
            {training ? 'Aloita koulutus' : 'Aloita kokous'}
          </button>
        </form>
      ) : (
        <div className="d-live">
          <div className="d-live__bar">
            <span className="d-signal d-signal--listen" /> {training ? 'Koulutus käynnissä — JARVIS kuuntelee' : 'Kokous käynnissä — vinkit kulmaikkunassa'}
            <span className="d-muted d-small">Mikrofoni ja "Jaa puhelun ääni" ovat kulmaikkunassa.</span>
            <button className="d-send d-send--stop" disabled={busy} onClick={() => void stop()}>
              {busy ? 'Tehdään yhteenvetoa…' : 'Lopeta ja tee yhteenveto'}
            </button>
          </div>
          {blade?.html ? (
            <div className="d-card d-card--wide">
              <div className="d-card__title">{blade.title}</div>
              <Html html={blade.html} />
            </div>
          ) : null}
        </div>
      )}
      {note ? <p className="d-note">{note}</p> : null}
      {summary ? (
        <div className="d-card d-card--wide">
          <div className="d-card__title">Yhteenveto</div>
          <div className="d-card__body">
            <Rich text={summary} />
          </div>
          {!training ? (
            <div className="d-card__actions">
              <button
                className="d-chip"
                onClick={() =>
                  send(
                    `Kirjaa CRM:ään juuri päättyneen tapaamisen tulos${topic ? ` (${topic})` : ''} tämän yhteenvedon perusteella. Näytä esikatselu ennen kirjausta.\n\n${summary.slice(0, 3000)}`,
                  )
                }
              >
                Kirjaa CRM:ään
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {memory?.length ? (
        <div className="d-card d-card--wide">
          <div className="d-card__title">{training ? 'Aiemmat koulutukset' : 'Aiemmat tapaamiset ja mihin ne johtivat'}</div>
          <ul className="d-memory">
            {memory.map((m) => (
              <li key={m.at}>
                <span className="d-muted d-small">{new Date(m.at).toLocaleDateString('fi-FI', { day: 'numeric', month: 'numeric' })}</span>
                <span className="d-memory__name">{m.orgName ?? m.topic ?? 'Kokous'}</span>
                {m.outcome ? <span className={`d-outcome d-outcome--${m.outcome === 'hävitty' ? 'lost' : m.outcome === 'kauppa' ? 'won' : 'open'}`}>{OUTCOME_FI[m.outcome] ?? m.outcome}{m.outcomeDetail ? ` · ${m.outcomeDetail}` : ''}</span> : null}
                {!training && !m.orgName ? <span className="d-muted d-small">ei yhdistetty CRM-yritykseen</span> : null}
                {m.learned ? <span className="d-muted d-small">opittu</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}


// --- Laitteet: projektori, kone ja kotiverkko suorilla napeilla (ei kielimallia → nopea, ei krediittejä) ----
type DevReply = { text: string; image?: { data: string; mime: string } | null }
type NetDevice = { ip: string; mac: string; name: string; kind: string; host: string; services: string[]; title: string; router: boolean }

async function dev(tyokalu: string, args: Record<string, unknown> = {}, timeoutMs = 60_000) {
  return request<DevReply>('laite', { tyokalu, args }, timeoutMs)
}

function useDev() {
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [img, setImg] = useState<{ data: string; mime: string } | null>(null)
  const run = async (label: string, tyokalu: string, args: Record<string, unknown> = {}, timeoutMs?: number) => {
    setBusy(label)
    try {
      const r = await dev(tyokalu, args, timeoutMs)
      setMsg(r.text)
      if (r.image) setImg(r.image)
      return r
    } catch (err) {
      setMsg(`Ei onnistunut: ${errText(err)}`)
      return null
    } finally {
      setBusy(null)
    }
  }
  return { busy, msg, img, setImg, run }
}

const PROJ_APPS = ['Netflix', 'YouTube', 'Yle Areena', 'Disney+', 'Prime Video', 'Spotify']

function ProjectorCard() {
  const { busy, msg, img, setImg, run } = useDev()
  const [link, setLink] = useState('')
  const [tapText, setTapText] = useState('')
  const key = (nappi: string, maara?: number) => void run(nappi, 'projektori_nappain', { nappi, maara })
  // Virtanappi: sama kuin säätimessä, päälle tai valmiustilaan tilan mukaan.
  const power = async () => {
    const st = await run('tila', 'projektori_tila')
    const on = /on päällä/.test(st?.text ?? '')
    await run(on ? 'valmiustilaan' : 'päälle', 'projektori_virta', { tila: on ? 'pois' : 'paalle' }, 110_000)
  }
  // Asennusikkunassa (hiiren nuoli) nuolinäppäimet muuttuvat äänenvoimakkuudeksi: silloin napautetaan suoraan.
  const refresh = () => setTimeout(() => void run('ruutu', 'projektori_nayta', {}, 40_000), 900)
  const pick = async (teksti: string) => {
    if (await run(teksti, 'projektori_valitse', { teksti })) refresh()
  }
  const tapShot = async (e: ReactMouseEvent<HTMLImageElement>) => {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    const x = Math.round(((e.clientX - r.left) / r.width) * el.naturalWidth)
    const y = Math.round(((e.clientY - r.top) / r.height) * el.naturalHeight)
    if (await run('napautan', 'projektori_napauta', { x, y })) refresh()
  }
  useEffect(() => {
    void run('tila', 'projektori_tila')
  }, [])
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">Projektori · XGIMI Horizon</div>
      <div className="d-dev__row">
        <button className="d-send" disabled={!!busy} onClick={() => void run('päälle (syvästä valmiustilasta IR:llä jopa minuutti)', 'projektori_virta', { tila: 'paalle' }, 110_000)}>Päälle</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('pois', 'projektori_virta', { tila: 'pois' })}>Valmiustilaan</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('tila', 'projektori_tila')}>Tila</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('ruutu', 'projektori_nayta', {}, 40_000)}>Näytä ruutu</button>
      </div>
      <div className="d-dev__apps">
        {PROJ_APPS.map((a) => (
          <button key={a} className="d-chip" disabled={!!busy} onClick={() => void run(a, 'projektori_avaa', { sovellus: a }, 180_000)}>{a}</button>
        ))}
      </div>
      {/* XGIMI-kaukosäädin: samat napit samassa järjestyksessä kuin oikeassa säätimessä. */}
      <div className="d-remote">
        <div className="d-remote__top">
          <button className="d-remote__round d-remote__power" disabled={!!busy} onClick={() => void power()} aria-label="Virta" title="Virta: päälle / valmiustilaan">⏻</button>
          <button className="d-remote__round" onClick={() => key('asetukset')} aria-label="Asetukset" title="Asetukset: kuva, ääni, trapetsikorjaus, 3D">⚙</button>
          <button className="d-remote__round d-remote__assist" onClick={() => key('googleAvustaja')} aria-label="Google-avustaja" title="Google-avustaja (puhe kuullaan projektorin kautta, ei puhelimesta)">
            <span /><span /><span /><span />
          </button>
        </div>
        <div className="d-remote__ring">
          <button className="d-remote__dir d-remote__dir--up" onClick={() => key('ylös')} aria-label="Ylös">▲</button>
          <button className="d-remote__dir d-remote__dir--left" onClick={() => key('vasen')} aria-label="Vasen">◀</button>
          <button className="d-remote__ok" onClick={() => key('ok')} aria-label="OK" />
          <button className="d-remote__dir d-remote__dir--right" onClick={() => key('oikea')} aria-label="Oikea">▶</button>
          <button className="d-remote__dir d-remote__dir--down" onClick={() => key('alas')} aria-label="Alas">▼</button>
        </div>
        <div className="d-remote__row3">
          <button className="d-remote__round" onClick={() => key('takaisin')} aria-label="Takaisin" title="Takaisin">◀</button>
          <button className="d-remote__round" onClick={() => key('valikko')} aria-label="Valikko" title="Valikko: videon asetukset">≡</button>
          <button className="d-remote__round" onClick={() => key('koti')} aria-label="Koti" title="Koti">⌂</button>
        </div>
        <div className="d-remote__vol">
          <button className="d-remote__round" onClick={() => key('ääni-')} aria-label="Hiljemmalle" title="Äänenvoimakkuus −">−</button>
          <button className="d-remote__round" onClick={() => key('ääni+')} aria-label="Kovemmalle" title="Äänenvoimakkuus +">+</button>
        </div>
        <div className="d-remote__extra">
          <button className="d-btn" onClick={() => key('playpause')}>⏯ Toista / tauko</button>
          <button className="d-btn" onClick={() => key('mykistä')}>🔇 Mykistä</button>
          <button className="d-btn" onClick={() => key('autoFokus')} title="Sivunappi: automaattitarkennus (kokeellinen)">◎ Tarkenna</button>
        </div>
      </div>
      <form
        className="d-dev__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (link.trim()) void run('linkki', 'projektori_linkki', { url: link.trim() }).then(() => setLink(''))
        }}
      >
        <input className="d-input" value={link} placeholder="YouTube- tai muu linkki projektorille" onChange={(e) => setLink(e.target.value)} />
        <button className="d-btn" type="submit" disabled={!link.trim() || !!busy}>Avaa</button>
      </form>
      <div className="d-dev__apps">
        <span className="d-muted d-small">Napauta ruudulta (Netflix):</span>
        {['Elias', 'Toista', 'Jatka katselua', 'Haku', 'Asenna', 'Avaa'].map((t) => (
          <button key={t} className="d-chip" disabled={!!busy} onClick={() => void pick(t)}>{t}</button>
        ))}
      </div>
      <form
        className="d-dev__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (tapText.trim()) void pick(tapText.trim()).then(() => setTapText(''))
        }}
      >
        <input className="d-input" value={tapText} placeholder="Napauta tekstiä ruudulla, esim. Download" onChange={(e) => setTapText(e.target.value)} />
        <button className="d-btn" type="submit" disabled={!tapText.trim() || !!busy}>Napauta</button>
      </form>
      {busy ? <p className="d-muted d-small">{busy}…</p> : msg ? <p className="d-dev__msg">{msg}</p> : null}
      {img ? (
        <figure className="d-dev__shot">
          <img src={`data:${img.mime};base64,${img.data}`} alt="Projektorin ruutu" className="d-dev__tap" onClick={(e) => void tapShot(e)} />
          <figcaption className="d-muted d-small">
            Napauta kuvaa: sama kohta napautetaan projektorilla. Netflixissä nuolinapit säätävät vain ääntä (siellä on hiiren nuoli), joten käytä napautusta.
          </figcaption>
          <div className="d-dev__row">
            <button className="d-link" onClick={() => void run('ruutu', 'projektori_nayta', {}, 40_000)}>Päivitä</button>
            <button className="d-link" onClick={() => setImg(null)}>Piilota</button>
          </div>
        </figure>
      ) : null}
    </div>
  )
}

const TV_APPS = ['Netflix', 'YouTube', 'Yle Areena', 'Disney+', 'Prime Video', 'Spotify']

// Samsung-telkkari: Samsungin kaukosäätimen napit + sovellukset + Spotify-haku (soi suoraan telkkarissa).
function SamsungCard() {
  const { busy, msg, run } = useDev()
  const [song, setSong] = useState('')
  const [link, setLink] = useState('')
  const key = (nappi: string, maara?: number) => void run(nappi, 'samsung_nappain', { nappi, maara })
  const power = async () => {
    const st = await run('tila', 'samsung_tila')
    const on = /päällä/.test(st?.text ?? '')
    await run(on ? 'pois' : 'päälle', 'samsung_virta', { tila: on ? 'pois' : 'paalle' }, 40_000)
  }
  useEffect(() => {
    void run('tila', 'samsung_tila')
  }, [])
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">Samsung-telkkari</div>
      <div className="d-dev__apps">
        {TV_APPS.map((a) => (
          <button key={a} className="d-chip" disabled={!!busy} onClick={() => void run(a, 'samsung_avaa', { sovellus: a }, 30_000)}>{a}</button>
        ))}
      </div>
      <form
        className="d-dev__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (song.trim()) void run('soitan', 'spotify_soita', { haku: song.trim(), laite: 'samsung' }, 60_000).then(() => setSong(''))
        }}
      >
        <input className="d-input" value={song} placeholder="Spotify: kappale, artisti tai soittolista" onChange={(e) => setSong(e.target.value)} />
        <button className="d-btn" type="submit" disabled={!song.trim() || !!busy}>Soita</button>
      </form>
      <div className="d-remote">
        <div className="d-remote__top">
          <button className="d-remote__round d-remote__power" disabled={!!busy} onClick={() => void power()} aria-label="Virta" title="Virta">⏻</button>
          <button className="d-remote__round" onClick={() => key('lähde')} aria-label="Lähde" title="Lähde (HDMI, TV)">⇄</button>
          <button className="d-remote__round" onClick={() => key('koti')} aria-label="Koti" title="Koti">⌂</button>
        </div>
        <div className="d-remote__ring">
          <button className="d-remote__dir d-remote__dir--up" onClick={() => key('ylös')} aria-label="Ylös">▲</button>
          <button className="d-remote__dir d-remote__dir--left" onClick={() => key('vasen')} aria-label="Vasen">◀</button>
          <button className="d-remote__ok" onClick={() => key('ok')} aria-label="OK" />
          <button className="d-remote__dir d-remote__dir--right" onClick={() => key('oikea')} aria-label="Oikea">▶</button>
          <button className="d-remote__dir d-remote__dir--down" onClick={() => key('alas')} aria-label="Alas">▼</button>
        </div>
        <div className="d-remote__row3">
          <button className="d-remote__round" onClick={() => key('takaisin')} aria-label="Takaisin" title="Takaisin">↩</button>
          <button className="d-remote__round" onClick={() => key('playpause')} aria-label="Toista / tauko" title="Toista / tauko">⏯</button>
          <button className="d-remote__round" onClick={() => key('mykistä')} aria-label="Mykistä" title="Mykistä">🔇</button>
        </div>
        <div className="d-remote__vol">
          <button className="d-remote__round" onClick={() => key('ääni-')} aria-label="Hiljemmalle" title="Äänenvoimakkuus −">−</button>
          <button className="d-remote__round" onClick={() => key('ääni+')} aria-label="Kovemmalle" title="Äänenvoimakkuus +">+</button>
        </div>
        <div className="d-remote__extra">
          <button className="d-btn" onClick={() => key('kanava-')}>Kanava −</button>
          <button className="d-btn" onClick={() => key('kanava+')}>Kanava +</button>
          <button className="d-btn" onClick={() => void run('seuraava', 'spotify_ohjaa', { toiminto: 'seuraava' })}>⏭ Seuraava biisi</button>
        </div>
      </div>
      <form
        className="d-dev__row"
        onSubmit={(e) => {
          e.preventDefault()
          if (link.trim()) void run('linkki', 'samsung_linkki', { url: link.trim() }, 60_000).then(() => setLink(''))
        }}
      >
        <input className="d-input" value={link} placeholder="YouTube- tai Spotify-linkki Samsungille" onChange={(e) => setLink(e.target.value)} />
        <button className="d-btn" type="submit" disabled={!link.trim() || !!busy}>Avaa</button>
      </form>
      {busy ? <p className="d-muted d-small">{busy}…</p> : msg ? <p className="d-dev__msg">{msg}</p> : null}
    </div>
  )
}

function MachineCard() {
  const { busy, msg, img, setImg, run } = useDev()
  const [confirm, setConfirm] = useState<{ action: 'sammuta' | 'uudelleen' | 'lepotila'; text: string } | null>(null)
  const ask = async (action: 'sammuta' | 'uudelleen' | 'lepotila') => {
    const r = await run('tarkistan', 'kone_virta', { toiminto: action })
    if (r) {
      const t = r.text.replace(/Kysy käyttäjältä vahvistus[\s\S]*$/, '').replace(/^ESIKATSELU \(id v\d+\): /, '').replace(/ — kerro nämä käyttäjälle ja kysy, onko [^:]*:/, ':').trim()
      setConfirm({ action, text: t.charAt(0).toUpperCase() + t.slice(1) })
    }
  }
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">Tietokone</div>
      <div className="d-dev__row">
        <button className="d-btn" disabled={!!busy} onClick={() => void run('tila', 'kone_tila')}>Tila</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('ruutu', 'kone_nayta', {}, 40_000)}>Näytä ruutu</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('lukitse', 'kone_lukitse')}>Lukitse</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void ask('lepotila')}>Lepotila</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void ask('uudelleen')}>Käynnistä uudelleen</button>
        <button className="d-btn d-btn--danger" disabled={!!busy} onClick={() => void ask('sammuta')}>Sammuta</button>
        <button className="d-btn" disabled={!!busy} onClick={() => void run('peru', 'kone_peru')}>Peru sammutus</button>
      </div>
      {confirm ? (
        <div className="d-confirm">
          <p>{confirm.text}</p>
          <div className="d-dev__row">
            <button
              className="d-send d-send--stop"
              onClick={() => {
                const a = confirm.action
                setConfirm(null)
                void run(a, 'kone_virta_suora', { toiminto: a })
              }}
            >
              Kyllä, {confirm.action === 'sammuta' ? 'sammuta' : confirm.action === 'uudelleen' ? 'käynnistä uudelleen' : 'lepotilaan'}
            </button>
            <button className="d-btn" onClick={() => setConfirm(null)}>Peruuta</button>
          </div>
        </div>
      ) : null}
      {busy ? <p className="d-muted d-small">{busy}…</p> : msg && !confirm ? <p className="d-dev__msg">{msg}</p> : null}
      {img ? (
        <figure className="d-dev__shot">
          <img src={`data:${img.mime};base64,${img.data}`} alt="Koneen näyttö" />
          <button className="d-link" onClick={() => setImg(null)}>Piilota</button>
        </figure>
      ) : null}
    </div>
  )
}

function NetworkCard() {
  const [list, setList] = useState<NetDevice[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const scan = async () => {
    setBusy(true)
    setNote('Skannaan kotiverkkoa (20–40 s)…')
    try {
      const r = await request<{ devices: NetDevice[]; me: string; gateway: string }>('laite', { tyokalu: 'verkko_laitteet' }, 120_000)
      setList(r.devices)
      setNote(`${r.devices.length} laitetta. Nimeä tuntemattomat, niin JARVIS muistaa ne.`)
    } catch (err) {
      setNote(`Skannaus epäonnistui: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }
  const rename = async (d: NetDevice) => {
    const nimi = window.prompt(`Nimi laitteelle ${d.ip} (${d.kind || d.mac})`, d.name || '')
    if (!nimi?.trim()) return
    try {
      await request('laite', { tyokalu: 'verkko_nimea', args: { mac: d.mac, nimi } })
      setList(list?.map((x) => (x.mac === d.mac ? { ...x, name: nimi } : x)) ?? null)
    } catch (err) {
      setNote(`Ei tallentunut: ${errText(err)}`)
    }
  }
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">Kotiverkko</div>
      <div className="d-dev__row">
        <button className="d-btn" disabled={busy} onClick={() => void scan()}>{busy ? 'Skannaan…' : 'Skannaa laitteet'}</button>
        <span className="d-muted d-small">Valot, TV:t ja muut laitteet ohjataan keskustelussa: "laita olohuoneen valo päälle".</span>
      </div>
      {note ? <p className="d-dev__msg">{note}</p> : null}
      {list?.length ? (
        <ul className="d-netlist">
          {list.map((d) => (
            <li key={d.mac}>
              <b>{d.name || d.kind || 'tuntematon'}</b>
              <span className="d-muted d-small">
                {d.ip} · {d.mac}
                {d.host ? ` · ${d.host}` : ''}
                {d.services.length ? ` · ${d.services.join(', ')}` : ''}
                {d.router ? ' · reititin' : ''}
              </span>
              <button className="d-link" onClick={() => void rename(d)}>{d.name ? 'Muuta nimeä' : 'Nimeä'}</button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

// --- Kotikamera: elävä kuva bridgeltä (/kamera.mjpg, vain tämä kone), kääntö ONVIF:lla ---------------------------
function CameraCard() {
  const { busy, msg, run } = useDev()
  const [names, setNames] = useState<string[] | null>(null)
  const [cam, setCam] = useState('')
  const [live, setLive] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [fail, setFail] = useState<string | null>(null)
  // Per-start key from the bridge (only over the WebSocket); /kamera.mjpg refuses requests without it.
  const [key, setKey] = useState('')
  const imgRef = useRef<HTMLImageElement | null>(null)
  const status = async () => {
    const r = (await run('kamera', 'kamera_tila')) as (DevReply & { kamerat?: string[]; avain?: string }) | null
    setKey(r?.avain ?? '')
    return r
  }
  useEffect(() => {
    void (async () => {
      const list = (await status())?.kamerat ?? []
      setNames(list)
      if (list.length) setCam(list[0])
    })()
    // Chromium can keep a multipart <img> connection open after unmount: drop the source explicitly.
    return () => {
      if (imgRef.current) imgRef.current.src = ''
    }
  }, [])
  const open = async (on: boolean) => {
    setFail(null)
    if (!on && imgRef.current) imgRef.current.src = ''
    // Bridge may have restarted since the page loaded (new key).
    if (on) await status()
    setLive(on)
    setNonce((n) => n + 1)
  }
  const turn = async (suunta: string) => {
    if (await run(suunta, 'kamera_kaanna', { nimi: cam, suunta }, 20_000)) if (!live) await open(true)
  }
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">Kamera{cam ? ` · ${cam}` : ''}</div>
      {names && !names.length ? (
        <p className="d-muted d-small">Kameraa ei ole asennettu. Luo Tapo-sovelluksessa Kameratili ja aja tyokalut\asenna_kamera.bat, sitten "uudelleen".</p>
      ) : null}
      {names?.length ? (
        <>
          <div className="d-dev__row">
            <button className="d-send" onClick={() => void open(!live)}>{live ? 'Sulje kamera' : 'Avaa kamera'}</button>
            {names.length > 1
              ? names.map((n) => (
                  <button key={n} className="d-chip" onClick={() => (setCam(n), void open(true))}>{n}</button>
                ))
              : null}
            <span className="d-cam__pad">
              <button className="d-btn" disabled={!!busy} onClick={() => void turn('vasen')} aria-label="Käännä vasemmalle">◀</button>
              <button className="d-btn" disabled={!!busy} onClick={() => void turn('ylös')} aria-label="Käännä ylös">▲</button>
              <button className="d-btn" disabled={!!busy} onClick={() => void turn('alas')} aria-label="Käännä alas">▼</button>
              <button className="d-btn" disabled={!!busy} onClick={() => void turn('oikea')} aria-label="Käännä oikealle">▶</button>
            </span>
          </div>
          {live ? (
            <figure className="d-dev__shot d-cam">
              <img
                key={nonce}
                ref={imgRef}
                src={`${BRIDGE_HTTP_URL}/kamera.mjpg?nimi=${encodeURIComponent(cam)}&t=${encodeURIComponent(key)}&n=${nonce}`}
                alt="Kameran elävä kuva"
                onError={() => (setLive(false), setFail('Kuvaa ei saatu. Onko kamera päällä ja samassa wifissä (tai yksityisyystila päällä)?'))}
              />
              <figcaption className="d-muted d-small">Elävä kuva näkyy vain tällä koneella. Kamera sulkeutuu itsestään, kun suljet näkymän.</figcaption>
            </figure>
          ) : null}
        </>
      ) : null}
      {fail ? <p className="d-dev__msg">{fail}</p> : busy ? <p className="d-muted d-small">{busy}…</p> : msg && names?.length && !msg.startsWith('Kamerat:') ? <p className="d-dev__msg">{msg}</p> : null}
    </div>
  )
}

// --- IR-kaukosäätimet (Smart Life): projektorin virta, ilmalämpöpumppu, muut kaukosäädinlaitteet -----------------
type IrRemote = { name: string; online: boolean; ac: boolean; keys: string[] }
function IrCard() {
  const { busy, msg, run } = useDev()
  const [remotes, setRemotes] = useState<IrRemote[] | null>(null)
  const [errs, setErrs] = useState<string[]>([])
  const [temp, setTemp] = useState(22)
  const load = async () => {
    const r = (await run('haetaan kaukosäätimet', 'ir_laitteet', {}, 60_000)) as (DevReply & { remotes?: IrRemote[]; errors?: string[] }) | null
    setRemotes(r?.remotes ?? [])
    setErrs(r?.errors ?? [])
  }
  useEffect(() => {
    void load()
  }, [])
  return (
    <div className="d-card d-dev">
      <div className="d-card__title">IR-kaukosäätimet</div>
      {remotes && !remotes.length ? (
        <p className="d-muted d-small">
          {errs[0] ??
            'Ei kaukosäätimiä. Lisää Nedis-IR-ohjain Smart Life -sovellukseen (sama tili kuin valot) ja sen alle kaukosäätimet: projektorille DIY → opeta virtanappi (nimeksi "Projektori"), ilmalämpöpumpulle Ilmastointilaite → merkki.'}
        </p>
      ) : null}
      {(remotes ?? []).map((r) => (
        <div key={r.name} className="d-ir">
          <div className="d-ir__name">
            {r.name}
            {r.online ? null : <span className="d-muted d-small"> · ohjain offline</span>}
          </div>
          {r.ac ? (
            <div className="d-dev__row">
              <button className="d-send" disabled={!!busy} onClick={() => void run('päälle', 'ir_lampopumppu', { laite: r.name, virta: true })}>Päälle</button>
              <button className="d-btn" disabled={!!busy} onClick={() => void run('pois', 'ir_lampopumppu', { laite: r.name, virta: false })}>Pois</button>
              <button className="d-btn" onClick={() => setTemp((t) => Math.max(16, t - 1))}>−</button>
              <button className="d-btn" disabled={!!busy} onClick={() => void run(`${temp} °C`, 'ir_lampopumppu', { laite: r.name, lampotila: temp })}>Aseta {temp} °C</button>
              <button className="d-btn" onClick={() => setTemp((t) => Math.min(30, t + 1))}>+</button>
              {['lämmitys', 'jäähdytys', 'auto'].map((m) => (
                <button key={m} className="d-chip" disabled={!!busy} onClick={() => void run(m, 'ir_lampopumppu', { laite: r.name, tila: m })}>{m}</button>
              ))}
            </div>
          ) : (
            <div className="d-dev__apps">
              {r.keys.slice(0, 24).map((k) => (
                <button key={k} className="d-chip" disabled={!!busy} onClick={() => void run(k, 'ir_nappi', { laite: r.name, nappi: k })}>{k}</button>
              ))}
              {!r.keys.length ? <span className="d-muted d-small">Ei nappeja — opeta ne Smart Life -sovelluksessa.</span> : null}
            </div>
          )}
        </div>
      ))}
      <div className="d-dev__row">
        <button className="d-link" disabled={!!busy} onClick={() => void load()}>Päivitä lista</button>
      </div>
      {busy ? <p className="d-muted d-small">{busy}…</p> : msg && remotes?.length ? <p className="d-dev__msg">{msg}</p> : null}
    </div>
  )
}

function DevicesView() {
  return (
    <div className="d-page">
      <h1>Laitteet</h1>
      <p className="d-lede">Napit toimivat suoraan ilman kielimallia. Monimutkaisemmat pyynnöt ("etsi Netflixistä…") onnistuvat keskustelussa tai Telegramissa.</p>
      <ProjectorCard />
      <CameraCard />
      <IrCard />
      <SamsungCard />
      <MachineCard />
      <NetworkCard />
    </div>
  )
}

type LearnCard = { tiedosto: string; nimi: string; teksti: string }
type LearnData = { myyntioppi: string; liidioppi: string; muisti?: string; avoimet?: string; kortit?: LearnCard[]; paivakirja?: string; kooste?: string }
type LearnTab = 'myyntioppi' | 'liidioppi' | 'muisti' | 'avoimet' | 'kortit' | 'paivakirja' | 'kooste'
/** JARVISin itse kirjoittamat, johdetut näkymät: luetaan, ei muokata täällä. */
const READONLY_TABS: LearnTab[] = ['paivakirja', 'kooste']
const LEARN_TABS: { id: LearnTab; label: string; hint: string }[] = [
  { id: 'myyntioppi', label: 'Myyntioppi', hint: 'Mitä JARVIS on oppinut tavastasi myydä. Alussa PYSYVÄT PERIAATTEET: ne ovat aina mukana kaikessa, mitä JARVIS tekee.' },
  { id: 'liidioppi', label: 'Liidioppi', hint: 'Liidikoneen säännöt ja päätöksesi.' },
  { id: 'muisti', label: 'Muisti', hint: 'Toiveesi (JARVIS ei poista näitä itse), JARVISin omista virheistä oppimat säännöt ja uudet merkinnät, jotka järjestetään joka yö.' },
  { id: 'avoimet', label: 'Avoimet asiat', hint: 'Lupaukset ja seurannat. Merkitse tehdyksi vaihtamalla [ ] → [x], tai sano JARVISille "tehty".' },
  { id: 'kortit', label: 'Kortit', hint: 'Yksi kortti per ihminen, yritys tai projekti. JARVIS tuo kortin mukaan automaattisesti, kun nimi mainitaan.' },
  { id: 'paivakirja', label: 'Päiväkirja', hint: 'Mitä teit ja sovit, päivä kerrallaan (JARVIS kirjaa yöllä; säilyy, vaikka keskustelut poistuvat 90 päivässä). Vain luku — korjaa sanomalla JARVISille.' },
  { id: 'kooste', label: 'Myynnin kooste', hint: 'JARVISin viikoittainen tiivistelmä koko myyntiopista. Vain luku — muokkaa Myyntioppia, kooste päivittyy siitä.' },
]
const slugName = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

function LearnView() {
  const [tab, setTab] = useState<LearnTab>('myyntioppi')
  const [card, setCard] = useState('')
  const [data, setData] = useState<LearnData | null>(null)
  // Luonnos per tiedosto: välilehden vaihto ei hävitä tallentamattomia muutoksia.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newName, setNewName] = useState('')
  const [unsaved, setUnsaved] = useState<string[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const t = await request<LearnData>('oppi')
      setData(t)
      setNote(null)
    } catch (err) {
      setNote(`Ei saatu luettua: ${errText(err)}`)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const cards = data?.kortit ?? []
  const readOnly = READONLY_TABS.includes(tab)
  const key = readOnly ? '' : tab === 'kortit' ? card : tab
  const original = !data ? '' : readOnly ? String(data[tab as 'paivakirja' | 'kooste'] ?? '') || '(tyhjä — täyttyy yöllisessä ajossa)' : tab === 'kortit' ? cards.find((k) => k.tiedosto === card)?.teksti ?? '' : String(data[tab] ?? '')
  useEffect(() => {
    if (tab === 'kortit' && !card && cards.length) setCard(cards[0].tiedosto)
  }, [tab, card, cards])
  const draft = key && key in drafts ? drafts[key] : original
  const setDraft = (v: string) => {
    if (key) setDrafts((d) => ({ ...d, [key]: v }))
  }
  const dropDraft = (k: string) =>
    setDrafts((d) => {
      const n = { ...d }
      delete n[k]
      return n
    })
  const dirty = Boolean(key) && (draft !== original || unsaved.includes(key))
  const pendingKeys = Object.keys(drafts).filter((k) => {
    const orig = k.startsWith('kortti:') ? cards.find((c) => c.tiedosto === k)?.teksti ?? '' : String((data as Record<string, unknown> | null)?.[k] ?? '')
    return drafts[k] !== orig
  })
  const save = async () => {
    if (!key) return
    setSaving(true)
    try {
      // pohja = teksti sellaisena kuin se ladattiin: bridge hylkää tallennuksen, jos tiedosto on sillä välin muuttunut
      // (paitsi jos perään on vain lisätty — silloin lisäys säilyy).
      await request('oppi_tallenna', { tiedosto: key, teksti: draft, pohja: unsaved.includes(key) ? '' : original })
      setUnsaved((u) => u.filter((x) => x !== key))
      dropDraft(key)
      setNote('Tallennettu (vanha versio jäi varmuuskopioksi muisti/varmuuskopiot). JARVIS käyttää muutosta seuraavasta viestistä alkaen.')
      await load()
    } catch (err) {
      setNote(`Tallennus epäonnistui: ${errText(err)}`)
    } finally {
      setSaving(false)
    }
  }
  const createCard = () => {
    const name = newName.trim()
    const slug = slugName(name)
    if (name.length < 2 || !slug) return
    const k = `kortti:${slug}.md`
    if (cards.some((x) => x.tiedosto === k)) {
      setCard(k)
      setNewName('')
      return
    }
    const template = `# ${name}\ntyyppi: henkilö\naliakset: ${name.split(/\s+/)[0]}\nrooli: \n\n## Tiedot\n- \n\n## Tapahtumat\n- \n`
    setData((d) => (d ? { ...d, kortit: [...(d.kortit ?? []), { tiedosto: k, nimi: name, teksti: '' }] } : d))
    setDrafts((d) => ({ ...d, [k]: template }))
    setUnsaved((u) => [...u, k])
    setCard(k)
    setNewName('')
  }
  const hint = LEARN_TABS.find((t) => t.id === tab)?.hint ?? ''

  return (
    <div className="d-page d-page--full">
      <h1>Muisti ja opit</h1>
      <p className="d-lede">Tämä on se, mitä JARVIS tietää ja on oppinut. Korjaa vapaasti — väärä tieto kannattaa poistaa heti. {hint}</p>
      <div className="d-tabs">
        {LEARN_TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'kortit' && cards.length ? ` (${cards.length})` : ''}
            {pendingKeys.some((k) => (t.id === 'kortit' ? k.startsWith('kortti:') : k === t.id)) ? ' •' : ''}
          </button>
        ))}
        <span className="d-muted d-small">{draft.length.toLocaleString('fi-FI')} merkkiä</span>
      </div>
      {tab === 'kortit' ? (
        <div className="d-inline">
          <select value={card} onChange={(e) => setCard(e.target.value)}>
            {cards.length ? null : <option value="">(ei vielä kortteja — JARVIS luo niitä joka yö)</option>}
            {cards.map((k) => (
              <option key={k.tiedosto} value={k.tiedosto}>
                {k.nimi}
              </option>
            ))}
          </select>
          <input value={newName} placeholder="Uuden kortin nimi" onChange={(e) => setNewName(e.target.value)} />
          <button className="d-ghost" disabled={newName.trim().length < 2} onClick={createCard}>
            Uusi kortti
          </button>
        </div>
      ) : null}
      <textarea className="d-editor" value={draft} spellCheck={false} readOnly={readOnly} disabled={!key && !readOnly} onChange={(e) => setDraft(e.target.value)} />
      <div className="d-inline">
        {readOnly ? null : (
          <button className="d-send" disabled={!dirty || saving} onClick={() => void save()}>
            {saving ? 'Tallennetaan…' : 'Tallenna muutokset'}
          </button>
        )}
        {dirty ? (
          <button className="d-ghost" onClick={() => (key ? dropDraft(key) : undefined)}>
            Peru muutokset
          </button>
        ) : null}
        {note ? <span className="d-note">{note}</span> : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Sovellus
// ---------------------------------------------------------------------------------------------

// ---- Harjoituspuhelu: videopuhelun näköinen näkymä --------------------------------------------
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'
const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function PracticeView({ onStart, onSay, onMic, onHistory, onBack }: { onStart: () => void; onSay: (t: string) => void; onMic: () => void; onHistory: () => void; onBack: () => void }) {
  const practice = useStore((s) => s.practice)
  const turns = useStore((s) => s.turns)
  const phase = useStore((s) => s.phase)
  const level = useStore((s) => s.level)
  const caption = useStore((s) => s.caption)
  const [calling, setCalling] = useState(false)
  const [now, setNow] = useState(Date.now())
  const capRef = useRef<HTMLDivElement>(null)
  const on = Boolean(practice?.on)
  useEffect(() => {
    if (!on) return
    setCalling(false)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  // Soitto ei yhdistynyt (JARVIS ei vastannut): nappi takaisin 40 s jälkeen.
  useEffect(() => {
    if (!calling) return
    const t = setTimeout(() => setCalling(false), 40_000)
    return () => clearTimeout(t)
  }, [calling])
  const lines = on && practice ? turns.slice(practice.from) : []
  useEffect(() => {
    capRef.current?.scrollTo({ top: capRef.current.scrollHeight, behavior: 'smooth' })
  }, [lines.length, lines[lines.length - 1]?.text])

  const first = (practice?.name ?? '').split(' ')[0] || 'Asiakas'
  const speaking = on && phase === 'speaking'
  const listening = phase === 'listening' || phase === 'waking'
  const thinking = phase === 'thinking' || phase === 'tooling'
  const status = !on
    ? calling
      ? 'Soitetaan…'
      : ''
    : speaking
      ? `${first} puhuu`
      : thinking
        ? `${first}…`
        : listening
          ? 'Sinun vuorosi, puhu'
          : 'Mikrofoni kiinni (paina mikkiä)'

  // Puhelu päättyi: palaute.
  if (!on && practice?.ended && !calling) {
    const feedback = turns.slice(practice.endFrom ?? turns.length).filter((t) => t.role === 'jarvis')
    return (
      <div className="d-call d-call--after">
        <div className="d-call__after">
          <div className="d-call__eyebrow">Puhelu päättyi · {practice.name} · {practice.company}</div>
          <h1>Palaute</h1>
          <div className="d-call__feedback">
            {feedback.length ? feedback.map((t) => <Rich key={t.id} text={t.text} />) : <p className="d-muted">JARVIS kokoaa palautetta…</p>}
          </div>
          <div className="d-call__afterbar">
            <button className="d-call__btn d-call__btn--call" onClick={() => { setCalling(true); onStart() }}>Uusi puhelu</button>
            <button className="d-call__btn" onClick={onHistory}>Aiemmat harjoitukset</button>
            <button className="d-call__btn" onClick={onBack}>Keskusteluun</button>
          </div>
        </div>
      </div>
    )
  }

  // Ennen puhelua.
  if (!on) {
    return (
      <div className="d-call d-call--pre">
        <div className="d-call__pre">
          <div className="d-call__avatar d-call__avatar--unknown" aria-hidden="true">?</div>
          <h1>Harjoituspuhelu</h1>
          <p>JARVIS arpoo asiakkaan: toimiala, koko, rooli, luonne ja vastaväitteet. Sinä soitat ja myyt. Lopuksi saat palautteen, ja parhaat vastauksesi tallentuvat myyntioppiin.</p>
          <button className="d-call__btn d-call__btn--call d-call__btn--big" disabled={calling} onClick={() => { setCalling(true); onStart() }}>
            {calling ? 'Soitetaan…' : 'Soita asiakkaalle'}
          </button>
          <button className="d-link" onClick={onHistory}>Aiemmat harjoitukset</button>
        </div>
      </div>
    )
  }

  return (
    <div className="d-call">
      <header className="d-call__top">
        <span className="d-call__rec" aria-hidden="true" />
        <span>Harjoituspuhelu</span>
        <span className="d-call__timer">{mmss(now - (practice?.startedAt ?? now))}</span>
      </header>
      <div className="d-call__stage">
        <div className={`d-call__tile${speaking ? ' is-speaking' : ''}`}>
          <div className="d-call__avatar">{initials(practice?.name ?? '')}</div>
          <div className="d-call__name">{practice?.name}</div>
          <div className="d-call__org">{practice?.company}</div>
          <div className="d-call__status">{status}</div>
        </div>
        <div className={`d-call__self${listening ? ' is-live' : ''}`} style={{ ['--lvl' as string]: String(Math.min(1, level * 3)) }}>
          <div className="d-call__selfdot">Sinä</div>
        </div>
      </div>
      <div className="d-call__captions" ref={capRef} aria-live="polite">
        {lines.map((t) => (
          <div key={t.id} className={`d-call__cap d-call__cap--${t.role}`}>
            <b>{t.role === 'user' ? 'Sinä' : first}</b> {t.text}
          </div>
        ))}
        {listening && caption ? <div className="d-call__cap d-call__cap--user d-call__cap--live"><b>Sinä</b> {caption}</div> : null}
      </div>
      <footer className="d-call__bar">
        <button className={`d-call__ctl${listening ? ' is-on' : ''}`} onClick={onMic} title={listening ? 'Mikki päällä (paina sulkeaksesi)' : 'Avaa mikki'}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
            <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
            {listening ? null : <path d="M4 4l16 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
          </svg>
          <span>{listening ? 'Mikki' : 'Mykistetty'}</span>
        </button>
        <button className="d-call__ctl" onClick={() => onSay('Aikalisä.')} title="JARVIS vastaa omana itsenään">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="7" y="5" width="3.5" height="14" rx="1" fill="currentColor" /><rect x="13.5" y="5" width="3.5" height="14" rx="1" fill="currentColor" /></svg>
          <span>Aikalisä</span>
        </button>
        <button className="d-call__ctl d-call__ctl--end" onClick={() => onSay('Lopeta harjoitus.')} title="Lopeta puhelu ja saa palaute">
          <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M3 14.5c5-4.7 13-4.7 18 0l-2.4 2.6-3.3-1.4v-2.6c-2.2-.7-4.4-.7-6.6 0v2.6l-3.3 1.4z" fill="currentColor" /></svg>
          <span>Lopeta</span>
        </button>
      </footer>
    </div>
  )
}


// ---------------------------------------------------------------------------------------------
// JARVIS 2.0 (HUD, 9.11.2026): sivut pyyhkäistään vaakasuunnassa, mikki dockin keskellä avaa keskustelun.
// Kaikki vanhat näkymät (Keskustelu, Liidit, Kokous, Koulutus, Harjoitus, Muisti, Laitteet) ovat mukana:
// sivuilla upotettuina tai koko ruudun paneeleina.
// ---------------------------------------------------------------------------------------------

type Overlay = 'laitteet' | 'oppi' | 'harjoitus' | null
const KOTI_KEYS = ['koti', 'ilma', 'viihde', 'turva']
const TYO_KEYS = ['tyo', 'liidit', 'kokous']

/** #hash of the other mode → open that mode instead (e.g. #liidit in Koti mode). */
function hashRedirect(): string {
  try {
    const h = window.location.hash.slice(1)
    if (MODE === 'koti' && TYO_KEYS.includes(h)) window.location.replace(`${window.location.pathname}?tila=tyo#${h}`)
    if (MODE === 'tyo' && KOTI_KEYS.includes(h)) window.location.replace(`${window.location.pathname}#${h}`)
    return h
  } catch {
    return ''
  }
}

function ChatSheet({
  open,
  onClose,
  p,
  draft,
  setDraft,
  send,
  logRef,
  inputRef,
  rail,
}: {
  open: boolean
  onClose: () => void
  p: Props
  draft: string
  setDraft: (s: string) => void
  send: (t: string) => void
  logRef: RefObject<HTMLDivElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  rail: ((goLeads: () => void) => ReactNode) | null
}) {
  const nav = useNav()
  const railNode = rail ? rail(() => (onClose(), nav.goKey('liidit'))) : null
  const turns = useStore((s) => s.turns)
  const phase = useStore((s) => s.phase)
  const caption = useStore((s) => s.caption)
  const error = useStore((s) => s.error)
  const panels = useStore((s) => s.panels)
  const blades = useStore((s) => s.blades)
  const looking = useStore((s) => s.looking)
  const activeTool = useStore((s) => s.activeTool)
  const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
  const listening = phase === 'listening' || phase === 'waking'
  const otherBlades = blades.filter((b) => b.id !== 'kokous-vinkit')
  useEffect(() => {
    if (open) logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, panels, caption, open, logRef])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [open, onClose])
  return (
    <div className={`sheet${open ? ' on' : ''}`} role="dialog" aria-label="Keskustelu" aria-hidden={!open}>
      <div className="bd" onClick={onClose} />
      <div className={`box${railNode ? ' box--rail' : ''}`}>
        <div className="ph">
          <b>JARVIS</b> {MODE === 'tyo' ? 'TYÖ-KESKUSTELU (ERILLINEN)' : 'KOTI-KESKUSTELU · SAMA KUIN TELEGRAMISSA'}
          <span className="bar" />
          <button className="btn sq" onClick={onClose} aria-label="Sulje">
            ✕
          </button>
        </div>
        <div className={`wave${listening ? ' on' : busy ? ' busy' : ''}`} aria-hidden="true">
          {Array.from({ length: 28 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 37) % 500}ms` }} />
          ))}
        </div>
        <div className="sheet-body">
          <section className="d-chat hx-legacy" aria-label="Keskustelu">
            <header className="d-chathead">
              <span>
                {PHASE[phase] ?? phase}
                {activeTool ? ` · ${activeTool}` : ''}
              </span>
              <button className="d-ghost" onClick={p.onNewChat} title="Aloittaa uuden keskustelun — vanha historia ei enää kuluta krediittejä">
                Uusi keskustelu
              </button>
            </header>
            <div className="d-log" ref={logRef}>
              {turns.length === 0 ? (
                <div className="d-empty">
                  <p>{MODE === 'tyo' ? 'Kysy mitä vain: myynti, CRM, liidit, tapaamiset.' : 'Kysy mitä vain: laitteet, leffat, sää, arki.'}</p>
                  <div className="d-quick">
                    {(MODE === 'tyo' ? QUICK : HOME_QUICK).map((q) => (
                      <button key={q.label} onClick={() => send(q.text)}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((t) => <Message key={t.id} turn={t} />)
              )}
              {panels.map((panel) => (
                <div key={panel.id} className="d-card">
                  {panel.title ? <div className="d-card__title">{panel.title}</div> : null}
                  <Html html={panel.html} />
                </div>
              ))}
              {otherBlades.map((b) => (
                <div key={b.id} className="d-card">
                  <div className="d-card__title">{b.title}</div>
                  {b.kind === 'markup' && b.html ? (
                    <Html html={b.html} />
                  ) : b.url ? (
                    <a href={b.url} target="_blank" rel="noopener noreferrer">
                      Avaa {b.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60)}
                    </a>
                  ) : null}
                </div>
              ))}
              {caption && listening ? <div className="d-caption">“{caption}”</div> : null}
              {looking ? <div className="d-caption">Kamera: {looking}</div> : null}
            </div>
            {error ? <div className="d-error">{error}</div> : null}
            <form
              className="d-compose"
              onSubmit={(e) => {
                e.preventDefault()
                send(draft)
              }}
            >
              <button type="button" className={`d-mic${listening ? ' d-mic--on' : ''}`} onClick={p.onMic} title={p.voiceReady ? 'Puhu (tai sano "Jarvis")' : 'Ota mikrofoni käyttöön'} aria-label="Mikrofoni">
                <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
                  <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
                  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" />
                </svg>
              </button>
              <textarea
                ref={inputRef}
                value={draft}
                rows={1}
                placeholder={listening ? 'Kuuntelen…' : 'Kirjoita JARVISille…'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send(draft)
                  }
                }}
              />
              {busy ? (
                <button type="button" className="d-send d-send--stop" onClick={p.onStop}>
                  Pysäytä
                </button>
              ) : (
                <button type="submit" className="d-send" disabled={!draft.trim()}>
                  Lähetä
                </button>
              )}
            </form>
            <div className="d-toggles">
              <label className="d-switch">
                <input type="checkbox" checked={p.speakOn} onChange={(e) => p.onSpeak(e.target.checked)} />
                <span>Vastaukset ääneen</span>
              </label>
              <span className="d-hint">Enter lähettää · Välilyönti = puhu · Esc = sulje</span>
            </div>
          </section>
          {railNode ? <div className="sheet-rail hx-legacy">{railNode}</div> : null}
        </div>
      </div>
    </div>
  )
}

function Ovl({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="ovl" role="dialog" aria-label={title}>
      <div className="ph ovl-h">
        <b>JARVIS</b> {title}
        <span className="bar" />
        <button className="btn sq" onClick={onClose} aria-label="Sulje">
          ✕
        </button>
      </div>
      <div className="ovl-body hx-legacy">{children}</div>
    </div>
  )
}

/** TYÖPÄIVÄ with onLeads / onMeeting wired to the page swiper. */
function WorkDay(props: Omit<ComponentProps<typeof TyopaivaPage>, 'onLeads'>) {
  const nav = useNav()
  return <TyopaivaPage {...props} onLeads={() => nav.goKey('liidit')} />
}

/** Loads koti_tila for the JÄRJESTELMÄ page in Työ mode only while that page is open. */
function SystemLoader({ active, home }: { active: boolean; home: Home }) {
  useEffect(() => {
    if (active && MODE === 'tyo') void home.load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])
  return null
}

export function Desk(p: Props) {
  // Only what the frame itself needs: the streamed answer, captions and panels are read inside ChatSheet, so a
  // token arriving does not re-render every page (9.11.2026).
  const phase = useStore((s) => s.phase)
  const error = useStore((s) => s.error)
  const meetingBlade = useStore((s) => s.blades.find((b) => b.id === 'kokous-vinkit'))
  const hasTurns = useStore((s) => s.turns.length > 0)
  const activeTool = useStore((s) => s.activeTool)

  const [startKey] = useState(hashRedirect)
  const [overlay, setOverlay] = useState<Overlay>(() => {
    try {
      return new URLSearchParams(window.location.search).get('harjoitus') === '1' ? 'harjoitus' : null
    } catch {
      return null
    }
  })
  // Harjoituspuhelu alkoi (myös puheella keskustelusta): puhelunäkymä esiin.
  const practiceOn = useStore((s) => Boolean(s.practice?.on))
  useEffect(() => {
    if (practiceOn) setOverlay('harjoitus')
  }, [practiceOn])
  // Teema vanhoille lomakenäkymille (muistetaan selaimessa).
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try {
      return localStorage.getItem('jarvis.teema') === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    try {
      localStorage.setItem('jarvis.teema', next)
    } catch {
      /* ei tallennusta */
    }
  }
  const [chatOpen, setChatOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [dash, setDash] = useState<Dash | null>(null)
  const [dashErr, setDashErr] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const home = useHome(MODE === 'koti')

  const listening = phase === 'listening' || phase === 'waking'

  const load = useCallback(async () => {
    try {
      const d = await request<Dash>('tanaan')
      setDash(d)
      setDashErr(null)
    } catch (err) {
      setDashErr(/ajoissa|Vaatii/.test(errText(err)) ? 'Tiedot vaativat JARVISin uudelleenkäynnistyksen (kaynnista_uudelleen.bat).' : `Tietoja ei saatu: ${errText(err)}`)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 3 * 60_000)
    // Yhteys syntyi myöhemmin (JARVIS käynnistyi vasta): haetaan heti.
    const onUp = () => {
      hudLog('Yhteys JARVISiin')
      void load()
    }
    window.addEventListener('jarvis-connected', onUp)
    return () => {
      clearInterval(t)
      window.removeEventListener('jarvis-connected', onUp)
    }
  }, [load])
  const lastPhase = useRef(phase)
  useEffect(() => {
    if (lastPhase.current !== 'dormant' && phase === 'dormant' && hasTurns) void load()
    lastPhase.current = phase
  }, [phase, hasTurns, load])

  const send = useCallback(
    (text: string) => {
      const t = text.trim()
      if (!t) return
      setChatOpen(true)
      p.onSend(t)
      setDraft('')
      setTimeout(() => inputRef.current?.focus(), 0)
    },
    [p],
  )
  const closeChat = useCallback(() => setChatOpen(false), [])
  const closeOverlay = useCallback(() => setOverlay(null), [])

  const meetingOn = Boolean(dash?.system.meeting)
  const openLeads = (dash?.crm?.leads.list ?? []).filter((l) => !l.rejected && !l.approved).length
  const connectedNow = !/katkesi|Yhdistetään|ei vastaa/i.test(error ?? '')
  const link: { dot: '' | 'a' | 'r'; text: string } = !connectedNow
    ? { dot: 'r', text: 'SILTA · EI YHTEYTTÄ' }
    : { dot: phase === 'thinking' || phase === 'tooling' ? 'a' : '', text: `SILTA · ${(PHASE[phase] ?? phase).toUpperCase()}${activeTool ? ' · ' + activeTool.toUpperCase().slice(0, 18) : ''}` }

  const switchMode = () => {
    try {
      sessionStorage.setItem('jv2.flip', '1')
    } catch {
      /* ok */
    }
    window.location.href = MODE === 'tyo' ? `${window.location.pathname}#koti` : `${window.location.pathname}?tila=tyo#tyo`
  }

  const system = (active: boolean) => (
    <>
      <SystemLoader active={active} home={home} />
      <SystemPage
        work={MODE === 'tyo'}
        connected={connectedNow}
        phase={PHASE[phase] ?? phase}
        system={dash?.system ?? null}
        k={home.k}
        onAsk={send}
        onDevices={() => setOverlay('laitteet')}
        onLearn={() => setOverlay('oppi')}
        onNewChat={p.onNewChat}
        theme={theme}
        onTheme={toggleTheme}
        extra={
          <div className="list" style={{ marginTop: 12 }}>
            <a className="btn wide" href={MODE === 'tyo' ? '?#koti' : '?tila=tyo#tyo'} onClick={(e) => (e.preventDefault(), switchMode())}>
              {MODE === 'tyo' ? 'VAIHDA KOTI-TILAAN' : 'VAIHDA TYÖ-TILAAN'}
            </a>
            <button className="btn wide red" onClick={() => window.confirm('Kirjaudutaanko ulos tältä laitteelta? PIN kysytään seuraavalla kerralla.') && logout()}>
              <Ic n="lock" />
              KIRJAUDU ULOS
            </button>
          </div>
        }
      />
    </>
  )

  const pages: PageDef[] =
    MODE === 'tyo'
      ? [
          {
            key: 'tyo',
            title: 'TYÖPÄIVÄ',
            short: 'PÄIVÄ',
            icon: 'case',
            render: () => (
              <WorkDay
                meetings={dash?.crm?.meetings ?? []}
                issues={dash?.crm?.issues ?? []}
                leads={openLeads}
                pack={dash?.aamupaketti ?? null}
                onCopied={(nro, vaihtoehto) => void request('aamupaketti_kopio', { nro, vaihtoehto }).catch(() => {})}
                loaded={Boolean(dash)}
                dashErr={dashErr ?? (dash && !dash.crm ? 'CRM ei ole yhdistetty.' : null)}
                onAsk={send}
                onRefresh={() => void load()}
              />
            ),
          },
          {
            key: 'liidit',
            title: 'LIIDIT',
            short: 'LIIDIT',
            icon: 'target',
            render: () => <LiiditPage pipe={dash?.crm?.pipe ?? null} loaded={Boolean(dash)} open={openLeads} onAsk={send} leadsView={<LeadsView dash={dash} load={() => void load()} />} />,
          },
          {
            key: 'kokous',
            title: 'KOKOUS & KOULUTUS',
            short: 'KOKOUS',
            icon: 'meet',
            render: () => (
              <KokousPage
                meetingOn={meetingOn}
                meetingView={(kind) => <MeetingView kind={kind} active={meetingOn} blade={meetingBlade} onChange={() => void load()} send={send} />}
                onPractice={() => setOverlay('harjoitus')}
                onAsk={send}
                onLearn={() => setOverlay('oppi')}
              />
            ),
          },
          { key: 'naytto', title: 'NÄYTTÖ', short: 'NÄYTTÖ', icon: 'monitor', render: (active) => <ScreenPage active={active} /> },
          { key: 'jarvis', title: 'JÄRJESTELMÄ', short: 'JARVIS', icon: 'core', render: system },
        ]
      : [
          { key: 'koti', title: 'KOTI', short: 'KOTI', icon: 'home', render: () => <KotiPage home={home} onAsk={send} /> },
          { key: 'ilma', title: 'ILMA & VALO', short: 'ILMA', icon: 'air', render: () => <IlmaPage home={home} /> },
          { key: 'viihde', title: 'VIIHDE', short: 'VIIHDE', icon: 'tv', render: () => <ViihdePage home={home} onRemote={() => setOverlay('laitteet')} /> },
          { key: 'turva', title: 'TURVA & IMURI', short: 'TURVA', icon: 'shield', render: (active) => <TurvaPage home={home} active={active} /> },
          { key: 'naytto', title: 'NÄYTTÖ', short: 'NÄYTTÖ', icon: 'monitor', render: (active) => <ScreenPage active={active} /> },
          { key: 'jarvis', title: 'JÄRJESTELMÄ', short: 'JARVIS', icon: 'core', render: system },
        ]

  return (
    <Shell
      work={MODE === 'tyo'}
      pages={pages}
      link={link}
      micOn={listening}
      startKey={startKey}
      still={chatOpen || overlay !== null}
      onSwitchMode={switchMode}
      onMic={() => {
        setChatOpen(true)
        p.onMic()
      }}
    >
      <ChatSheet
        open={chatOpen}
        onClose={closeChat}
        p={p}
        draft={draft}
        setDraft={setDraft}
        send={send}
        logRef={logRef}
        inputRef={inputRef}
        rail={MODE === 'tyo' ? (goLeads) => <TodayRail dash={dash} dashErr={dashErr} load={() => void load()} send={send} goLeads={goLeads} /> : null}
      />
      {overlay === 'laitteet' ? (
        <Ovl title="LAITTEET · KAIKKI OHJAIMET" onClose={closeOverlay}>
          <DevicesView />
        </Ovl>
      ) : overlay === 'oppi' ? (
        <Ovl title="MUISTI JA OPIT" onClose={closeOverlay}>
          <LearnView />
        </Ovl>
      ) : overlay === 'harjoitus' ? (
        <Ovl title="HARJOITUSPUHELU" onClose={closeOverlay}>
          <PracticeView onStart={p.onPracticeStart} onSay={p.onPracticeSay} onMic={p.onMic} onHistory={() => send('Miten harjoitukset ovat menneet?')} onBack={() => (setOverlay(null), setChatOpen(true))} />
        </Ovl>
      ) : null}
    </Shell>
  )
}
