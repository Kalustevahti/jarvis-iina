/**
 * Myyjien CRM-käyttö (Elias 10.11.2026: "haluan tietää tarkemmin myyjien aktiivisuuden ja mitä tekevät siellä").
 * Data: CRM:n funktio jarvis_seller_usage (tyokalut/CRM_muutospyynto_kayttoloki.md) — kirjautumiset, aktiivinen aika,
 * katsotut sivut, avatut liidit/yritykset ja tehdyt toimet (activity_log). Vain myyjät, säilytys 90 pv CRM:n päässä.
 * Tämä tiedosto on puhdas (ei verkkoa): aikaväli ja suomenkielinen raportti. crm.mjs hakee, tämä muotoilee.
 */

const TZ = 'Europe/Helsinki'
const ymd = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
/** Helsinki UTC offset at instant d, e.g. "+02:00". */
function offsetAt(d) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' }).formatToParts(d).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT+2'
  const m = p.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/)
  return m ? `${m[1]}${m[2].padStart(2, '0')}:${m[3] ?? '00'}` : '+02:00'
}

/** Days 1 = today from 00.00 Helsinki time, 7 = this and the 6 previous days. → { from, to } ISO. */
export function usageRange(paivat = 1, now = new Date()) {
  const n = Math.max(1, Math.min(90, Math.round(Number(paivat) || 1)))
  const start = new Date(now.getTime() - (n - 1) * 86400_000)
  const day = ymd(start)
  const from = new Date(`${day}T00:00:00${offsetAt(start)}`)
  return { from: from.toISOString(), to: now.toISOString(), days: n }
}

// Intl throws on an invalid date: a bad timestamp from the CRM becomes '' instead of breaking the report.
const fmtAt = (opts) => (iso) => {
  const d = iso ? new Date(iso) : null
  return d && !Number.isNaN(d.getTime()) ? new Intl.DateTimeFormat('fi-FI', { timeZone: TZ, ...opts }).format(d) : ''
}
const hm = fmtAt({ hour: 'numeric', minute: '2-digit' })
const dmFull = fmtAt({ weekday: 'short', day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' })
const dm = fmtAt({ day: 'numeric', month: 'numeric' })
const first = (s) => String(s ?? '').trim().split(/\s+/)[0] || '—'
const mins = (m) => {
  const n = Math.round(Number(m) || 0)
  return n >= 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`
}

// activity_log action codes → Finnish verb (unknown codes are shown as they are).
const ACTION_FI = {
  note: 'muistiinpano',
  lead_claimed: 'otti liidin',
  lead_contacted: 'kontaktoi',
  lead_converted: 'teki yritykseksi',
  lead_rejected: 'hylkäsi liidin',
  lead_opening_set: 'avauslause',
  stage_changed: 'vaihtoi vaiheen',
  meeting_booked: 'sopi tapaamisen',
  meeting_result: 'kirjasi tapaamisen tuloksen',
  offer_created: 'teki tarjouksen',
  offer_sent: 'lähetti tarjouksen',
  contact_added: 'lisäsi yhteyshenkilön',
  follow_up_set: 'asetti seurannan',
}
const actionText = (a) => {
  const verb = a.text || ACTION_FI[a.action] || String(a.action ?? '').replaceAll('_', ' ')
  return `${hm(a.at)} ${a.entity_name ? `${a.entity_name} – ` : ''}${verb}`
}

const TYPE_FI = { mapping: 'kartoitus', first_meeting: 'ensitapaaminen', decision_meeting: 'päätöstapaaminen', offer_negotiation: 'tarjousneuvottelu', offer_presentation: 'tarjouksen esittely', follow_up: 'seurantatapaaminen', other: 'tapaaminen' }
const TYPE_GEN = { mapping: 'kartoituksen', first_meeting: 'ensitapaamisen', decision_meeting: 'päätöstapaamisen', offer_negotiation: 'tarjousneuvottelun', offer_presentation: 'tarjouksen esittelyn', follow_up: 'seurantatapaamisen', other: 'tapaamisen' }
const RESULT_FI = { offered: 'tarjous', interested_pending: 'kiinnostunut, harkitsee', won: 'kauppa', not_interested: 'ei kiinnostunut', missed: 'ei toteutunut' }
const OUTCOME_FI = { interested: 'kiinnostunut', no_reply: 'ei vastannut', not_interested: 'ei kiinnostunut', meeting_booked: 'tapaaminen sovittu', call_back: 'soita myöhemmin' }
const CHANNEL_FI = { phone: 'puhelimella', email: 'sähköpostilla', linkedin: 'LinkedInissä', visit: 'käynnillä', sms: 'tekstiviestillä' }
const USER_COLS = ['user_id', 'actor_user_id', 'actor_id', 'created_by', 'performed_by', 'profile_id', 'author_id']
const detailText = (d) => {
  if (d == null) return ''
  if (typeof d === 'string') return d
  if (typeof d === 'object') return String(d.text ?? d.note ?? d.message ?? d.content ?? d.summary ?? d.description ?? '')
  return String(d)
}
const clip = (t, n = 90) => {
  const x = String(t ?? '').replace(/\s+/g, ' ').trim()
  return x.length > n ? `${x.slice(0, n - 1)}…` : x
}

/**
 * Pure: "what each seller did" from data the CRM already stores (no usage log needed): leads claimed/contacted,
 * meetings booked/held, offers made/sent/accepted, notes and other activity_log rows with a user column.
 * rows = { people, orgs, leads, meetings, offers, activity }, range { from, to } ISO, exclude = names (owner, JARVIS).
 * → sellers in the normalizeUsage shape (logins/activeMin 0), actions newest first, everyone in people listed.
 */
export function timelineFromRows(rows, { from, to, exclude = [] } = {}) {
  const t0 = Date.parse(from)
  const t1 = Date.parse(to)
  const inRange = (iso) => {
    const t = Date.parse(iso)
    return Number.isFinite(t) && t >= t0 && t <= t1
  }
  const orgName = new Map((rows.orgs ?? []).map((o) => [o.id, o.name]))
  const skip = exclude.map((x) => String(x).toLowerCase()).filter(Boolean)
  const people = (rows.people ?? []).filter((p) => p.id && p.name && !skip.some((x) => p.name.toLowerCase().includes(x)) && !/jarvis/i.test(p.name))
  const by = new Map(people.map((p) => [p.id, []]))
  const add = (uid, at, text, entity, kind) => {
    if (!uid || !by.has(uid) || !inRange(at)) return
    by.get(uid).push({ at, action: kind, text, entity_name: entity || '' })
  }
  for (const l of rows.leads ?? []) {
    add(l.claimed_by_user_id, l.claimed_at, 'otti liidin', l.name, 'lead_claimed')
    const how = [CHANNEL_FI[l.contact_channel] ?? '', l.contact_outcome ? `→ ${OUTCOME_FI[l.contact_outcome] ?? l.contact_outcome}` : ''].filter(Boolean).join(' ')
    add(l.claimed_by_user_id, l.contacted_at, `kontaktoi${how ? ` ${how}` : ''}`, l.name, 'lead_contacted')
  }
  for (const m of rows.meetings ?? []) {
    const what = TYPE_FI[m.meeting_type] ?? 'tapaaminen'
    const day = dmFull(m.starts_at)
    add(m.seller_user_id, m.created_at, `sopi ${TYPE_GEN[m.meeting_type] ?? 'tapaamisen'} ${day}`, orgName.get(m.organization_id), 'meeting_booked')
    if (m.meeting_status === 'cancelled') continue
    add(m.seller_user_id, m.starts_at, `${what}${m.meeting_result ? ` → ${RESULT_FI[m.meeting_result] ?? m.meeting_result}` : m.meeting_status === 'completed' ? ' pidetty' : ' (tulos kirjaamatta)'}`, orgName.get(m.organization_id), 'meeting')
  }
  for (const o of rows.offers ?? []) {
    const price = o.monthly_price_cents ? ` ${Math.round(o.monthly_price_cents / 100)} €/kk` : ''
    const fleet = o.fleet_size ? `, ${o.fleet_size} autoa` : ''
    add(o.seller_user_id, o.created_at, `teki tarjouksen${price}${fleet}`, orgName.get(o.organization_id), 'offer_created')
    if (o.sent_at && Math.abs(Date.parse(o.sent_at) - Date.parse(o.created_at)) > 120_000) add(o.seller_user_id, o.sent_at, 'lähetti tarjouksen', orgName.get(o.organization_id), 'offer_sent')
    add(o.seller_user_id, o.accepted_at, 'tarjous hyväksytty', orgName.get(o.organization_id), 'offer_accepted')
  }
  const col = USER_COLS.find((c) => (rows.activity ?? []).some((a) => a && a[c]))
  if (col) {
    for (const a of rows.activity ?? []) {
      if (!a || a.action === 'lead_opening_set') continue
      const entity = orgName.get(a.organization_id) ?? ''
      const list = by.get(a[col])
      if (!list) continue
      // Same thing already from the tables above (within 3 min, same company): keep only real notes.
      const dup = a.action !== 'note' && list.some((e) => e.entity_name === entity && Math.abs(Date.parse(e.at) - Date.parse(a.created_at)) < 180_000)
      if (dup) continue
      const base = ACTION_FI[a.action] || String(a.action ?? '').replaceAll('_', ' ')
      const det = clip(detailText(a.details))
      add(a[col], a.created_at, a.action === 'note' && det ? `muistiinpano: "${det}"` : det && det.length < 60 ? `${base} (${det})` : base, entity, a.action)
    }
  }
  return people.map((p) => ({
    id: p.id,
    name: p.name,
    logins: 0,
    activeMin: 0,
    firstSeen: null,
    lastSeen: null,
    sessions: [],
    pages: [],
    opened: [],
    actions: by.get(p.id).sort((a, b) => String(b.at).localeCompare(String(a.at))),
  }))
}

/** Normalizes the RPC answer (missing fields → empty) so the text and the UI never crash on a partial CRM reply. */
export function normalizeUsage(raw) {
  const sellers = Array.isArray(raw?.sellers) ? raw.sellers : []
  return {
    source: raw?.source === 'toimet' ? 'toimet' : 'loki',
    enabled: raw?.enabled !== false,
    from: raw?.from ?? null,
    to: raw?.to ?? null,
    sellers: sellers.map((s) => ({
      id: String(s.user_id ?? s.id ?? ''),
      name: String(s.name ?? '—'),
      logins: Number(s.logins) || 0,
      activeMin: Number(s.active_minutes ?? s.activeMin) || 0,
      firstSeen: s.first_seen ?? s.firstSeen ?? null,
      lastSeen: s.last_seen ?? s.lastSeen ?? null,
      sessions: (Array.isArray(s.sessions) ? s.sessions : []).map((x) => ({ start: x.start, end: x.end, min: Number(x.active_minutes) || 0 })),
      pages: (Array.isArray(s.pages) ? s.pages : []).map((p) => ({ page: String(p.page ?? ''), views: Number(p.views) || 0 })).sort((a, b) => b.views - a.views),
      opened: (Array.isArray(s.opened) ? s.opened : []).map((o) => ({ type: o.type === 'organization' ? 'yritys' : 'liidi', name: String(o.name ?? ''), times: Number(o.times) || 1, last: o.last_at ?? null })).sort((a, b) => b.times - a.times),
      actions: (Array.isArray(s.actions) ? s.actions : []).map((a) => ({ at: a.at ?? a.created_at, action: a.action, text: a.text, entity_name: a.entity_name })).sort((a, b) => String(b.at).localeCompare(String(a.at))),
    })),
  }
}

/**
 * Telegram text. Most active first; sellers who did not visit are listed last on one line.
 * opts: { days, seller (name part), now }
 */
export function usageText(data, { days = 1, seller = '' } = {}) {
  const d = normalizeUsage(data)
  const span = days <= 1 ? `tänään${d.to ? ` (${dm(d.to)})` : ''}` : `${days} pv${d.from ? ` (${dm(d.from)}–${dm(d.to)})` : ''}`
  const onlyActions = d.source === 'toimet'
  const lines = [onlyActions ? `Myyjien CRM-toimet ${span}` : `CRM-käyttö ${span}`]
  if (onlyActions) lines.push('(Kirjatut toimet CRM:n aikaleimoista. Kirjautumiset ja aktiivinen aika tulevat, kun CRM:n käyttöloki on käytössä.)')
  if (!d.enabled) lines.push('Käyttöseuranta on CRM:ssä vielä pois päältä (Asetukset → Myyjien käyttöseuranta). Iina kytkee sen päälle, kun on kertonut myyjille.')
  const q = String(seller).trim().toLowerCase()
  const list = d.sellers.filter((s) => !q || s.name.toLowerCase().includes(q))
  if (!list.length) {
    lines.push(q ? `Myyjää "${seller}" ei löytynyt.` : 'Ei myyjiä tai ei tietoja tältä ajalta.')
    return lines.join('\n')
  }
  const active = list.filter((s) => s.logins || s.activeMin || s.actions.length).sort((a, b) => b.activeMin - a.activeMin || b.actions.length - a.actions.length)
  const idle = list.filter((s) => !active.includes(s))
  for (const s of active) {
    lines.push('')
    const when = s.firstSeen ? ` (${days > 1 ? `viimeksi ${dm(s.lastSeen)} ` : ''}${hm(s.firstSeen)}–${hm(s.lastSeen)})` : ''
    if (onlyActions) {
      const span2 = s.actions.length ? ` (${days > 1 ? `${dm(s.actions.at(-1).at)} ` : ''}${hm(s.actions.at(-1).at)}–${days > 1 ? `${dm(s.actions[0].at)} ` : ''}${hm(s.actions[0].at)})` : ''
      lines.push(`${first(s.name)}: ${s.actions.length} ${s.actions.length === 1 ? 'toimi' : 'tointa'}${span2}`)
      // Tarkempi kuvaus: every action on its own line, in time order (Elias 10.11. "tarkempi kuvaelma").
      const shown = s.actions.slice(0, 25).reverse()
      if (s.actions.length > 25) lines.push(`• … ${s.actions.length - 25} aiempaa`)
      for (const a of shown) lines.push(`• ${days > 1 ? `${dm(a.at)} ` : ''}${actionText(a)}`)
      continue
    }
    lines.push(`${first(s.name)}: ${s.logins} ${s.logins === 1 ? 'kirjautuminen' : 'kirjautumista'}, aktiivinen ${mins(s.activeMin)}${when}`)
    if (s.pages.length) lines.push(`• Sivut: ${s.pages.slice(0, 6).map((p) => `${p.page} ${p.views}`).join(', ')}`)
    if (s.opened.length) lines.push(`• Avasi: ${s.opened.slice(0, 6).map((o) => `${o.name}${o.times > 1 ? ` (${o.times})` : ''}`).join(', ')}${s.opened.length > 6 ? ` +${s.opened.length - 6}` : ''}`)
    // Newest 8, read in time order.
    if (s.actions.length) lines.push(`• Teki (${s.actions.length}): ${s.actions.length > 8 ? '… ' : ''}${s.actions.slice(0, 8).reverse().map(actionText).join(' · ')}`)
    else if (s.activeMin >= 15) lines.push('• Ei kirjattuja toimia — katseli, mutta ei kirjannut mitään.')
  }
  if (idle.length) lines.push('', `${onlyActions ? 'Ei kirjattuja toimia' : 'Ei käynyt CRM:ssä'}: ${idle.map((s) => first(s.name)).join(', ')}.`)
  return lines.join('\n')
}
