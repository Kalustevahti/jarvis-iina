/**
 * Työ pages (TYÖPÄIVÄ, LIIDIT, KOKOUS & KOULUTUS) on the data Desk already loads ('tanaan': meetings, issues,
 * pipeline counts, leads). The full old views (lead search/approval, meeting and training mode) are embedded
 * as-is so nothing they do is lost.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { request } from '../../lib/bridge'
import { fx, hap } from './core'
import { Pnl, Seg } from './controls'
import { Ic } from './icons'
import { CLOSED, eur, firstName, heat, rows, sellers, summarize, valueText, type Pipe, type Sum } from './pipeline'

export type WorkMeeting = { id: string; at: string; org: string; contact: string; seller: string; type: string; location: string }
type Draft = { style: string; label: string; text: string }
/** Myynnin aamupaketti (bridge aamupaketti.mjs): myyjittäin 3 tehtävää + luonnos ja vaihtoehto. */
export type MorningPack = {
  day: string
  count: number
  sellers: Array<{
    id: string
    name: string
    items: Array<{ n: number; type: string; typeLabel: string; company: string; why: string; todo: string; draft: Draft; alt: Draft; used: null | { how: string; variant: string } }>
  }>
}

const SELLER_KEY = 'jv2.myyja'
/** The view's own seller choice, shared by TYÖPÄIVÄ and LIIDIT (remembered in this browser). */
function useSellerChoice() {
  const [seller, setRaw] = useState<string>(() => {
    try {
      return localStorage.getItem(SELLER_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const set = (v: string) => {
    setRaw(v)
    try {
      localStorage.setItem(SELLER_KEY, v)
    } catch {
      /* no storage */
    }
  }
  return [seller, set] as const
}

/** Clipboard API needs a secure context; the LAN page may be plain http, so fall back to a hidden textarea. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall back */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

function MorningPanel({ pack, loaded, onCopied, onAsk }: { pack: MorningPack | null; loaded: boolean; onCopied: (n: number, v: 'a' | 'b') => void; onAsk: (t: string) => void }) {
  const [seller, setSeller] = useSellerChoice()
  const [copied, setCopied] = useState<string>('')
  const [showAlt, setShowAlt] = useState<Record<number, boolean>>({})
  const people = pack?.sellers ?? []
  const sel = people.some((p) => p.id === seller) ? seller : ''
  const shown = sel ? people.filter((p) => p.id === sel) : people
  const copy = async (n: number, v: 'a' | 'b', text: string) => {
    hap()
    if (await copyText(text)) {
      setCopied(`${n}${v}`)
      onCopied(n, v)
      window.setTimeout(() => setCopied((c) => (c === `${n}${v}` ? '' : c)), 2500)
    }
  }
  return (
    <Pnl n="A1" title="AAMUPAKETTI · 3 TÄRKEINTÄ" right={<span>{pack ? `${shown.reduce((k, s) => k + s.items.length, 0)} TEHTÄVÄÄ` : ''}</span>} className="wide" i={1}>
      {!pack ? <p className="sub">{loaded ? 'Aamupakettia ei saatu CRM:stä.' : 'Haetaan CRM:stä…'}</p> : null}
      {pack && people.length > 1 ? (
        <div className="chips sellers" role="group" aria-label="Myyjä">
          <button className="chip" aria-pressed={!sel} onClick={() => (hap(), setSeller(''))}>
            Kaikki <em>{pack.count}</em>
          </button>
          {people.map((p) => (
            <button key={p.id} className="chip" aria-pressed={sel === p.id} onClick={() => (hap(), setSeller(p.id))}>
              {firstName(p.name)} <em>{p.items.length}</em>
            </button>
          ))}
        </div>
      ) : null}
      {pack && !pack.count ? <p className="sub">Ei tehtäviä tänään: tulokset kirjattu, tarjoukset ja seurannat ajallaan.</p> : null}
      {shown.map((s) => (
        <div key={s.id}>
          {!sel && people.length > 1 ? <div className="lbl">{firstName(s.name).toUpperCase()}</div> : null}
          <ul className="list q morning">
            {s.items.map((x) => {
              const alt = showAlt[x.n] && x.alt.style !== x.draft.style
              const d = alt ? x.alt : x.draft
              const v: 'a' | 'b' = alt ? 'b' : 'a'
              return (
                <li key={x.n}>
                  <span className="st c">{x.typeLabel.toUpperCase()}</span>
                  <b>
                    {x.n}. {x.company}
                  </b>
                  <small>{x.why}</small>
                  <small>{x.todo}</small>
                  <blockquote className="draft">
                    <small>
                      {alt ? `VAIHTOEHTO ${x.n}b` : 'LUONNOS'} · {d.label}
                    </small>
                    {d.text}
                  </blockquote>
                  <span className="row">
                    <button className="btn pri sm" onClick={() => void copy(x.n, v, d.text)}>
                      {copied === `${x.n}${v}` ? 'KOPIOITU ✓' : 'KOPIOI VIESTI'}
                    </button>
                    {x.alt.style !== x.draft.style ? (
                      <button className="btn sm" aria-pressed={Boolean(showAlt[x.n])} onClick={() => (hap(), setShowAlt((m) => ({ ...m, [x.n]: !m[x.n] })))}>
                        {alt ? 'PÄÄLUONNOS' : 'VAIHTOEHTO'}
                      </button>
                    ) : null}
                    <button className="btn sm" onClick={() => onAsk(`Aamupaketin tehtävä ${x.n}: ${x.company} (${x.typeLabel}). ${x.why} Muokkaa luonnosta tilanteeseen sopivaksi ja kerro, mitä kirjaan CRM:ään.`)}>
                      KYSY NEUVOA
                    </button>
                    {x.used ? <span className="who">{x.used.how === 'lahetin' ? 'LÄHETETTY' : 'KOPIOITU'}</span> : null}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </Pnl>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
const fiDay = new Intl.DateTimeFormat('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric' })
const fiWhen = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? at : new Intl.DateTimeFormat('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d)
}

function useNow(ms = 1000) {
  const [t, setT] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setT(new Date()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return t
}

function BigClock() {
  const d = useNow(1000)
  return (
    <>
      <div className="sub">{d.toLocaleDateString('fi-FI', { weekday: 'long', day: 'numeric', month: 'long' }).toUpperCase()}</div>
      <div className="bigclock">
        {pad(d.getHours())}
        <span>:</span>
        {pad(d.getMinutes())}
      </div>
    </>
  )
}

export function TyopaivaPage({
  meetings,
  issues,
  leads,
  pack,
  onCopied,
  loaded,
  dashErr,
  onAsk,
  onLeads,
  onRefresh,
}: {
  meetings: WorkMeeting[]
  issues: string[]
  leads: number
  pack: MorningPack | null
  onCopied: (n: number, v: 'a' | 'b') => void
  loaded: boolean
  dashErr: string | null
  onAsk: (t: string) => void
  onLeads: () => void
  onRefresh: () => void
}) {
  const now = useNow(30_000)
  const sorted = useMemo(() => [...meetings].sort((a, b) => +new Date(a.at) - +new Date(b.at)), [meetings])
  const next = sorted.find((m) => +new Date(m.at) > now.getTime())
  const mins = next ? Math.round((+new Date(next.at) - now.getTime()) / 60_000) : 0
  const groups = useMemo(() => {
    const g: Array<{ day: string; items: WorkMeeting[] }> = []
    const today = dayKey(new Date())
    for (const m of sorted) {
      const d = new Date(m.at)
      const label = dayKey(d) === today ? 'TÄNÄÄN' : fiDay.format(d).toUpperCase()
      const x = g.find((y) => y.day === label)
      if (x) x.items.push(m)
      else g.push({ day: label, items: [m] })
    }
    return g
  }, [sorted])
  const go = (el: HTMLElement, fn: () => void) => {
    hap()
    fx('scan', el)
    window.setTimeout(fn, 300)
  }
  const tasks: Array<{ id: string; label: string; hint: string; run: () => void }> = [
    { id: 'next', label: 'Mitä teen seuraavaksi', hint: 'CRM:stä tärkein ensin', run: () => onAsk('Katso CRM ja kerro mitä minun kannattaa tehdä myynnissä seuraavaksi, tärkein ensin. Perustele lyhyesti.') },
    { id: 'prep', label: 'Valmistele tapaaminen', hint: 'Valmistelukortti seuraavaan', run: () => onAsk('Valmistele seuraava tapaaminen. Kirjoita valmistelukortti kokonaan.') },
    { id: 'log', label: 'Kirjaa tapaamisen tulos', hint: 'Esikatselu ennen kirjausta', run: () => onAsk('Haluan kirjata tapaamisen tuloksen CRM:ään. Kysy minulta yritys, tulos ja seuraava askel, ja näytä esikatselu ennen kirjausta.') },
    { id: 'week', label: 'Viikon luvut', hint: 'Mitä luvut kertovat', run: () => onAsk('Kerro tämän viikon myynnin luvut ja mitä ne kertovat.') },
    { id: 'leads', label: 'Liidit', hint: leads ? `${leads} tarkastettavana` : 'Putki ja tarjoukset', run: onLeads },
  ]
  return (
    <div className="pgi g-day">
      <Pnl n="T1" title="KALUSTOVAHTI · TÄNÄÄN" right={<span className="live">LIVE</span>} i={0}>
        <BigClock />
        <div className="cd">
          <span className="sub">SEURAAVA</span>
          {next ? (
            <>
              <b>{mins >= 60 * 24 ? fiWhen(next.at) : mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`}</b>
              <span className="sub">{next.org}</span>
            </>
          ) : (
            <>
              <b>VAPAA</b>
              <span className="sub">{loaded ? 'Ei tulevia tapaamisia 7 päivään' : 'Haetaan CRM:stä…'}</span>
            </>
          )}
        </div>
      </Pnl>
      <MorningPanel pack={pack} loaded={loaded} onCopied={onCopied} onAsk={onAsk} />
      <Pnl n="T2" title="TAPAAMISET · 7 PV" right={<button className="btn sm" onClick={onRefresh}>PÄIVITÄ</button>} i={2}>
        {dashErr ? <p className="note warn">{dashErr}</p> : null}
        {!loaded ? <p className="sub">Haetaan CRM:stä…</p> : !sorted.length ? <p className="sub">Ei sovittuja tapaamisia.</p> : null}
        {groups.map((g) => (
          <div key={g.day}>
            <div className="lbl">{g.day}</div>
            <ul className="tline">
              {g.items.map((m) => {
                const t = new Date(m.at)
                const past = t.getTime() <= now.getTime()
                return (
                  <li key={m.id} className={`${past ? 'past' : ''}${m === next ? ' next' : ''}`}>
                    <time>{`${pad(t.getHours())}:${pad(t.getMinutes())}`}</time>
                    <div>
                      <b>{m.org}</b>
                      <small>
                        {m.type}
                        {m.contact ? ` · ${m.contact}` : ''}
                        {m.seller && m.seller !== '—' ? ` · ${m.seller.split(' ')[0]}` : ''}
                        {m.location ? ` · ${m.location}` : ''}
                      </small>
                    </div>
                    <button className="btn sm" onClick={() => onAsk(`Valmistele tapaaminen: ${m.org} (${fiWhen(m.at)}). Kirjoita valmistelukortti kokonaan.`)}>
                      VALMISTELE
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        ))}
      </Pnl>
      <Pnl n="T3" title="PALAA NÄIHIN" right={<span>{issues.length ? `${issues.length} AVOINNA` : ''}</span>} className="wide" i={3}>
        {loaded && !issues.length ? <p className="sub">Putki on kunnossa.</p> : null}
        <ul className="list q">
          {issues.map((t, i) => (
            <li key={i}>
              <span className="st c">{/kirjaamatta/.test(t) ? 'TULOS' : /Tarjous|Tilaus/.test(t) ? 'TARJOUS' : /Liidi/.test(t) ? 'LIIDI' : 'SEURANTA'}</span>
              <b>{t}</b>
              <span className="row">
                {/kirjaamatta/.test(t) ? (
                  <button className="btn sm" onClick={() => onAsk(`Kirjaa CRM:ään tulos tälle tapaamiselle: ${t}. Kysy minulta ensin tulos ja seuraava askel, näytä esikatselu ennen kirjausta.`)}>
                    KIRJAA TULOS
                  </button>
                ) : null}
                <button className="btn sm" onClick={() => onAsk(`Mitä teen tälle: ${t}`)}>
                  KYSY NEUVOA
                </button>
              </span>
            </li>
          ))}
        </ul>
      </Pnl>
      <Pnl n="T4" title="PIKATEHTÄVÄT" className="wide" i={4}>
        <div className="tasks">
          {tasks.map((t) => (
            <button key={t.id} className="rt" onClick={(e) => go(e.currentTarget, t.run)}>
              <b>{t.label}</b>
              <small>{t.hint}</small>
            </button>
          ))}
        </div>
      </Pnl>
    </div>
  )
}

const OFFER_GROUPS = [
  { v: 'sent', label: 'Lähetetty', match: (s: string) => s === 'sent' || s === 'awaiting_approval' },
  { v: 'accepted', label: 'Hyväksytty', match: (s: string) => s === 'accepted' },
  { v: 'rejected', label: 'Hylätty', match: (s: string) => s === 'rejected' },
] as const
const LIST_STEP = 12

/** bridge 'myyjien_kaytto' (crm.mjs sellerUsage → kaytto.mjs normalizeUsage). */
type Usage = {
  missing?: boolean
  /** 'toimet' = no usage log in the CRM yet: only actions from the CRM's own timestamps. */
  source?: 'loki' | 'toimet'
  logMissing?: boolean
  enabled?: boolean
  days?: number
  sellers?: Array<{
    id: string
    name: string
    logins: number
    activeMin: number
    firstSeen: string | null
    lastSeen: string | null
    pages: Array<{ page: string; views: number }>
    opened: Array<{ type: string; name: string; times: number }>
    actions: Array<{ at: string; action: string; text?: string; entity_name?: string }>
  }>
}
const hmFmt = new Intl.DateTimeFormat('fi-FI', { hour: 'numeric', minute: '2-digit' })
const dmFmt = new Intl.DateTimeFormat('fi-FI', { day: 'numeric', month: 'numeric' })
/** Intl throws on an invalid date: a bad timestamp from the CRM must not break the page. */
const fmt = (f: Intl.DateTimeFormat, iso: string | null | undefined) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? f.format(d) : ''
}
const minText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`)

/** MYYJIEN AKTIIVISUUS: CRM-käyttö myyjittäin (vain Eliakselle; tiedot CRM:n käyttölokista). */
function UsagePanel({ sel, i }: { sel: string; i: number }) {
  const [days, setDays] = useState<1 | 7>(1)
  const [data, setData] = useState<Usage | null>(null)
  const [err, setErr] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setErr('')
    request<Usage>('myyjien_kaytto', { paivat: days })
      .then((d) => live && setData(d))
      .catch((e) => live && setErr(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [days])
  const list = (data?.sellers ?? []).filter((s) => !sel || s.id === sel).sort((a, b) => b.activeMin - a.activeMin || b.actions.length - a.actions.length)
  return (
    <Pnl n="T7" title="MYYJIEN AKTIIVISUUS" right={<span>{days === 1 ? 'TÄNÄÄN' : '7 PV'}</span>} className="wide" i={i}>
      <Seg
        opts={[
          { v: 1, label: 'Tänään' },
          { v: 7, label: '7 päivää' },
        ]}
        value={days}
        label="Aikaväli"
        onChange={(v) => (hap(), setDays(v as 1 | 7))}
      />
      {err ? <p className="sub" style={{ marginTop: 10 }}>Ei saatu: {err}</p> : null}
      {!data && !err ? <p className="sub" style={{ marginTop: 10 }}>Haetaan CRM:stä…</p> : null}
      {data?.missing ? <p className="sub" style={{ marginTop: 10 }}>CRM:ssä ei ole vielä käyttölokia (muutospyyntö: tyokalut\CRM_muutospyynto_kayttoloki.md).</p> : null}
      {data?.logMissing ? <p className="sub" style={{ marginTop: 10 }}>Kirjatut toimet CRM:stä. Kirjautumiset, aktiivinen aika ja sivut tulevat, kun CRM:n käyttöloki on käytössä.</p> : null}
      {data && !data.missing && data.enabled === false ? <p className="sub" style={{ marginTop: 10 }}>Seuranta on CRM:ssä pois päältä — Iina kytkee sen asetuksista, kun on kertonut myyjille.</p> : null}
      {data && !data.missing && !list.length ? <p className="sub" style={{ marginTop: 10 }}>Ei tietoja tältä ajalta.</p> : null}
      <ul className="list deals">
        {list.map((s) => {
          const seen = s.logins || s.activeMin || s.actions.length
          const open = openId === s.id
          const onlyActions = data?.source === 'toimet'
          const n = s.actions.length
          const span = n ? `${fmt(hmFmt, s.actions[n - 1].at)}–${fmt(hmFmt, s.actions[0].at)}` : ''
          return (
            <li key={s.id}>
              <b>{firstName(s.name)}</b>
              <span className="st c">{onlyActions ? (n ? `${n} ${n === 1 ? 'TOIMI' : 'TOINTA'}` : 'EI TOIMIA') : seen ? minText(s.activeMin).toUpperCase() : 'EI KÄYNYT'}</span>
              <span className="val">
                {onlyActions
                  ? n
                    ? `${days > 1 ? `${fmt(dmFmt, s.actions[0].at)} viimeksi · ` : ''}${span}`
                    : '—'
                  : seen
                  ? `${s.logins} ${s.logins === 1 ? 'kirjautuminen' : 'kirjautumista'} · ${s.actions.length} ${s.actions.length === 1 ? 'toimi' : 'toimea'}${s.firstSeen && s.lastSeen ? ` · ${days > 1 ? `${fmt(dmFmt, s.lastSeen)} ` : ''}${fmt(hmFmt, s.firstSeen)}–${fmt(hmFmt, s.lastSeen)}` : ''}`
                  : '—'}
              </span>
              {seen ? (
                <span className="row">
                  <span className="who">{onlyActions ? (s.actions[0] ? `${s.actions[0].entity_name ? `${s.actions[0].entity_name} – ` : ''}${s.actions[0].text ?? ''}` : '') : s.pages.slice(0, 3).map((p) => `${p.page} ${p.views}`).join(' · ')}</span>
                  <button className="btn sm" aria-expanded={open} onClick={() => (hap(), setOpenId(open ? null : s.id))}>
                    {open ? 'PIILOTA' : 'TARKEMMIN'}
                  </button>
                </span>
              ) : null}
              {open ? (
                <div className="sub" style={{ marginTop: 6 }}>
                  {s.opened.length ? <p>Avasi: {s.opened.slice(0, 12).map((o) => `${o.name}${o.times > 1 ? ` (${o.times})` : ''}`).join(', ')}</p> : null}
                  {s.actions.length ? (
                    <ul className="tl">
                      {s.actions
                        .slice(0, 40)
                        .reverse()
                        .map((a, k) => (
                          <li key={k}>
                            {days > 1 ? `${fmt(dmFmt, a.at)} ` : ''}
                            {fmt(hmFmt, a.at)} {a.entity_name ? <b>{a.entity_name}</b> : null}
                            {a.entity_name ? ' – ' : ''}
                            {a.text || String(a.action ?? '').replaceAll('_', ' ')}
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <p>Ei kirjattuja toimia.</p>
                  )}
                </div>
              ) : null}
            </li>
          )
        })}
      </ul>
    </Pnl>
  )
}

function MoneyLine({ s, big }: { s: Sum; big?: boolean }) {
  return (
    <span className={`money${big ? ' big' : ''}`}>
      <b>{eur(s.eur)}/kk</b>
      <small>
        ~{eur(s.eur * 12)}/v{s.est ? ' · sis. arvioita' : ''}
        {s.unknown ? ` · ${s.unknown} ilman autoja` : ''}
      </small>
    </span>
  )
}

export function LiiditPage({ pipe, loaded, open, leadsView, onAsk }: { pipe: Pipe | null; loaded: boolean; open: number; leadsView: ReactNode; onAsk: (t: string) => void }) {
  const [seller, setSeller] = useSellerChoice()
  const [view, setView] = useState<'liidit' | 'tarjoukset'>('liidit')
  const [stage, setStage] = useState<string | null>(null)
  const [offerGroup, setOfferGroup] = useState<(typeof OFFER_GROUPS)[number]['v']>('sent')
  const [limit, setLimit] = useState(LIST_STEP)
  const [machine, setMachine] = useState(false)

  const all = useMemo(() => (pipe ? rows(pipe) : []), [pipe])
  const people = useMemo(() => (pipe ? sellers(pipe, all) : []), [pipe, all])
  // A remembered seller that no longer exists in the CRM falls back to "Kaikki".
  const sel = people.some((p) => p.id === seller) ? seller : ''
  const mine = useMemo(() => (sel ? all.filter((r) => r.seller === sel) : all), [all, sel])
  const sum = useMemo(() => (pipe ? summarize(pipe, mine) : null), [pipe, mine])
  const name = (id: string | null) => (id ? firstName(pipe?.people[id] ?? '—') : '—')
  const stageLabel = (k: string) => pipe?.stages.find((s) => s.key === k)?.label ?? k

  const list = useMemo(
    () =>
      mine
        .filter((r) => (stage ? r.org.stage === stage : !CLOSED.has(r.org.stage)))
        .sort((a, b) => heat(a.org.stage) - heat(b.org.stage) || (b.value.eur ?? -1) - (a.value.eur ?? -1) || a.org.name.localeCompare(b.org.name, 'fi')),
    [mine, stage],
  )
  const offers = useMemo(() => (pipe?.offers ?? []).filter((o) => !sel || o.seller === sel), [pipe, sel])
  const group = OFFER_GROUPS.find((g) => g.v === offerGroup)!
  const groupRows = offers.filter((o) => group.match(o.status))
  const groupSum = groupRows.reduce((n, o) => n + (o.cents ?? 0) / 100, 0)
  const mx = Math.max(1, ...(sum?.stages ?? []).map((s) => s.sum.n))

  if (!pipe) {
    return (
      <div className="pgi g-leads">
        <Pnl n="T4" title="PUTKI" i={0}>
          <p className="sub">{loaded ? 'CRM ei ole yhdistetty tai putken tiedot puuttuvat — lähetä "uudelleen".' : 'Haetaan CRM:stä…'}</p>
        </Pnl>
        <Pnl n="T6" title="LIIDIKONE" right={<span>{open ? `${open} TARKASTETTAVANA` : ''}</span>} className="wide" i={1}>
          <div className="hx-legacy">{leadsView}</div>
        </Pnl>
      </div>
    )
  }

  return (
    <div className="pgi g-leads">
      <Pnl n="T4" title="PUTKI" right={<span>{sel ? name(sel).toUpperCase() : 'KAIKKI MYYJÄT'}</span>} i={0}>
        <div className="chips sellers" role="group" aria-label="Myyjä">
          <button className="chip" aria-pressed={!sel} onClick={() => (hap(), setSeller(''), setLimit(LIST_STEP))}>
            Kaikki <em>{all.filter((r) => !CLOSED.has(r.org.stage)).length}</em>
          </button>
          {people.map((p) => (
            <button key={p.id} className="chip" aria-pressed={sel === p.id} onClick={() => (hap(), setSeller(p.id), setLimit(LIST_STEP))}>
              {firstName(p.name)} <em>{p.open}</em>
            </button>
          ))}
        </div>
        <div className="openrow">
          <span className="sub">AVOINNA</span>
          <b className="n">{sum!.open.n}</b>
          <MoneyLine s={sum!.open} big />
        </div>
        <ul className="pipe2">
          {sum!.stages.map((s) => (
            <li key={s.key}>
              <button aria-pressed={stage === s.key} disabled={!s.sum.n} onClick={() => (hap(), setStage(stage === s.key ? null : s.key), setView('liidit'), setLimit(LIST_STEP))}>
                <span className="nm">{s.label}</span>
                <b className="n">{s.sum.n}</b>
                {s.sum.eur ? <MoneyLine s={s.sum} /> : <span className="money" />}
                <i style={{ width: `${((s.sum.n / mx) * 100).toFixed(0)}%` }} className={s.key === 'customer' ? 'won' : s.key === 'lost' ? 'lost' : ''} />
              </button>
            </li>
          ))}
        </ul>
      </Pnl>

      <Pnl
        n="T5"
        title={view === 'liidit' ? (stage ? stageLabel(stage).toUpperCase() : 'AVOIMET LIIDIT') : 'TARJOUKSET'}
        right={<span>{view === 'liidit' ? `${list.length} KPL` : `${offers.length} KPL`}</span>}
        className="wide"
        i={1}
      >
        <Seg
          opts={[
            { v: 'liidit', label: 'Liidit' },
            { v: 'tarjoukset', label: 'Tarjoukset' },
          ]}
          value={view}
          label="Näkymä"
          onChange={(v) => (setView(v as 'liidit' | 'tarjoukset'), setLimit(LIST_STEP))}
        />
        {view === 'liidit' ? (
          <>
            {stage ? (
              <button className="btn sm" style={{ marginTop: 10 }} onClick={() => (hap(), setStage(null), setLimit(LIST_STEP))}>
                ✕ {stageLabel(stage)} · NÄYTÄ AVOIMET
              </button>
            ) : null}
            {!list.length ? <p className="sub" style={{ marginTop: 10 }}>Ei liidejä tällä valinnalla.</p> : null}
            <ul className="list deals">
              {list.slice(0, limit).map((r) => (
                <li key={r.org.id}>
                  <b>{r.org.name}</b>
                  <span className="st c">{stageLabel(r.org.stage).toUpperCase()}</span>
                  <span className={`val${r.value.est ? ' est' : ''}${r.value.eur == null ? ' none' : ''}`}>{valueText(r.value)}</span>
                  <span className="row">
                    <span className="who">{name(r.seller)}</span>
                    <button className="btn sm" onClick={() => onAsk(`Kerro lyhyesti yrityksen ${r.org.name} tilanne CRM:stä ja mitä teen seuraavaksi.`)}>
                      SEURAAVA ASKEL
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            {list.length > limit ? (
              <button className="btn wide" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 50)}>
                NÄYTÄ LISÄÄ ({list.length - limit})
              </button>
            ) : null}
          </>
        ) : (
          <>
            <Seg
              className="offseg"
              opts={OFFER_GROUPS.map((g) => ({ v: g.v, label: `${g.label} ${offers.filter((o) => g.match(o.status)).length}` }))}
              value={offerGroup}
              label="Tarjouksen tila"
              onChange={(v) => (setOfferGroup(v), setLimit(LIST_STEP))}
            />
            <div className="openrow">
              <span className="sub">{group.label.toUpperCase()}</span>
              <b className="n">{groupRows.length}</b>
              <MoneyLine s={{ n: groupRows.length, eur: groupSum, est: false, unknown: 0 }} big />
            </div>
            {!groupRows.length ? <p className="sub">Ei tarjouksia.</p> : null}
            <ul className="list deals">
              {groupRows.slice(0, limit).map((o) => (
                <li key={o.id}>
                  <b>{o.orgName}</b>
                  <span className="st c">{o.at ? fiDay.format(new Date(o.at)).toUpperCase() : '—'}</span>
                  <span className="val">
                    {o.fleet ? `${o.fleet} autoa · ` : ''}
                    {o.cents ? `${eur(o.cents / 100)}/kk` : 'hinta puuttuu'}
                    {o.status === 'awaiting_approval' ? ' · odottaa hyväksyntää' : ''}
                  </span>
                  <span className="row">
                    <span className="who">{name(o.seller)}</span>
                  </span>
                </li>
              ))}
            </ul>
            {groupRows.length > limit ? (
              <button className="btn wide" style={{ marginTop: 10 }} onClick={() => setLimit(limit + 50)}>
                NÄYTÄ LISÄÄ ({groupRows.length - limit})
              </button>
            ) : null}
          </>
        )}
      </Pnl>

      <UsagePanel sel={sel} i={2} />

      <Pnl
        n="T6"
        title="LIIDIKONE"
        right={
          <button className="btn sm" aria-expanded={machine} onClick={() => (hap(), setMachine(!machine))}>
            {machine ? 'PIILOTA' : 'AVAA'}
          </button>
        }
        className="wide"
        i={3}
      >
        {/* Stays mounted while hidden so a running search keeps its result. */}
        <div className="hx-legacy" hidden={!machine}>
          {leadsView}
        </div>
        {machine ? null : <p className="sub">{open ? `${open} uutta liidiä odottaa hyväksyntää.` : 'Hae uusia liidejä yritysrekisteristä.'}</p>}
      </Pnl>
    </div>
  )
}

const DRILLS = ['Kylmäsoitto rakennusliikkeelle', 'Hinnan vastaväite', '"Kilpailija on halvempi"', 'Kaupan päättäminen']

export function KokousPage({ meetingView, meetingOn, onPractice, onAsk, onLearn }: { meetingView: (kind: 'asiakas' | 'koulutus') => ReactNode; meetingOn: boolean; onPractice: () => void; onAsk: (t: string) => void; onLearn: () => void }) {
  const [kind, setKind] = useState<'asiakas' | 'koulutus'>('asiakas')
  const [diff, setDiff] = useState<number[]>([2, 3, 4, 3])
  return (
    <div className="pgi g-meet">
      <Pnl n="T6" title="KOKOUS & KOULUTUS" right={meetingOn ? <span className="live">KÄYNNISSÄ</span> : <span>VALMIS</span>} className="wide" i={0}>
        <Seg
          opts={[
            { v: 'asiakas', label: 'Asiakastapaaminen' },
            { v: 'koulutus', label: 'Koulutus' },
          ]}
          value={kind}
          label="Tyyppi"
          onChange={(v) => setKind(v as 'asiakas' | 'koulutus')}
        />
        <div className="hx-legacy">{meetingView(kind)}</div>
      </Pnl>
      <Pnl n="T7" title="MYYNTIHARJOITUS" i={1}>
        <ul className="list">
          <li>
            <b>Harjoituspuhelu</b>
            <button className="btn pri sm" onClick={onPractice}>
              SOITA
            </button>
          </li>
          {DRILLS.map((d, i) => (
            <li key={d}>
              <b>{d}</b>
              <button className="btn sm" onClick={() => onAsk(`Aloitetaan harjoitus: ${d}, vaikeus ${diff[i]}/5. Ole sinä asiakas.`)}>
                ALOITA
              </button>
              <small>
                VAIKEUS{' '}
                <span className="diff">
                  {[1, 2, 3, 4, 5].map((k) => (
                    <button key={k} aria-pressed={k <= diff[i]} aria-label={`Vaikeus ${k}`} onClick={() => (hap(), setDiff((x) => x.map((y, j) => (j === i ? k : y))))} />
                  ))}
                </span>
              </small>
            </li>
          ))}
          <li>
            <b>Aiemmat harjoitukset</b>
            <button className="btn sm" onClick={() => onAsk('Miten harjoitukset ovat menneet?')}>
              KYSY
            </button>
          </li>
        </ul>
      </Pnl>
      <Pnl n="T8" title="MUISTI & MYYNTIOPPI" i={2}>
        <button className="btn wide" onClick={onLearn}>
          <Ic n="core" />
          AVAA MUISTI JA OPIT
        </button>
      </Pnl>
    </div>
  )
}
