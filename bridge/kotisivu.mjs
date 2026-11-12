/**
 * Kotisivun (kalustovahti.fi) yhteydenotot -> Telegram heti. VAIN LUKU.
 *
 * Lomake tallentaa pyynnön Supabasen tauluun contact_requests ja vasta sitten lähettää
 * sähköpostin myynnille. Jos tietokanta on paussilla (ilmainen Supabase pysäyttää
 * käyttämättömän projektin), lomake kaatuu eikä sähköpostia lähde. Siksi tämä moduuli
 *   1) ilmoittaa jokaisesta uudesta yhteydenotosta puhelimeen (ja tarkistaa onko yritys jo CRM:ssä
 *      sekä hakee Y-tunnuksen ja toimialan YTJ:stä),
 *   2) hälyttää kerran päivässä, jos tietokanta ei vastaa,
 *   3) pitää kyselyillään projektin todennäköisesti hereillä.
 *
 * Asetukset ~/.jarvis/kotisivu.json { url, avain } — kirjoitetaan asenna_kotisivu.bat-skriptillä
 * suoraan kotisivuprojektin .env-tiedostosta (avain ei kulje kenenkään kautta).
 * Turva: vain GET, vain contact_requests, avain ei koskaan lokiin tai työkalujen vastauksiin.
 */
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { searchCompanies } from './ytj.mjs'

const DIR = join(homedir(), '.jarvis')
const CONFIG = join(DIR, 'kotisivu.json')
const STATE = join(DIR, 'kotisivu_tila.json')
const POLL_MS = 5 * 60_000

const loadJson = (p, f) => {
  try {
    return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : f
  } catch {
    return f
  }
}
const saveJson = (p, v) => {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    writeFileSync(p, JSON.stringify(v, null, 2))
  } catch {
    /* ei kriittinen */
  }
}
function cfg() {
  const c = loadJson(CONFIG, {})
  const url = String(c.url ?? '').trim().replace(/\/+$/, '')
  return { url: /^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url) ? url : '', key: String(c.avain ?? '').trim() }
}
export const websiteConfigured = () => {
  const c = cfg()
  return Boolean(c.url && c.key)
}

async function getRequests(params) {
  const c = cfg()
  const qs = new URLSearchParams({ select: 'id,name,company,email,phone,vehicle_count,message,created_at', ...params })
  const res = await fetch(`${c.url}/rest/v1/contact_requests?${qs}`, {
    method: 'GET',
    headers: { apikey: c.key, Authorization: `Bearer ${c.key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).replaceAll(c.key, '***').slice(0, 160)
    const err = new Error(`HTTP ${res.status} ${body}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

const fiTime = (iso) =>
  new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

async function enrich(r, findOrganization) {
  const [crm, ytj] = await Promise.all([
    findOrganization ? findOrganization(r.company).catch(() => null) : null,
    searchCompanies({ name: r.company })
      .then((x) => x.companies.find((c) => c.active) ?? null)
      .catch(() => null),
  ])
  return { crm, ytj }
}

function describe(r, { crm, ytj } = {}) {
  return [
    `${r.company} – ${r.name}`,
    r.vehicle_count ? `Autoja: ${r.vehicle_count}` : '',
    r.phone ? `Puh: ${r.phone}` : '',
    `Sähköposti: ${r.email}`,
    r.message ? `Viesti: ${String(r.message).slice(0, 600)}` : '',
    ytj ? `YTJ: ${ytj.businessId} · ${ytj.lineText} · ${ytj.city}${ytj.registered ? ` · per. ${ytj.registered.slice(0, 4)}` : ''}` : 'YTJ: ei löytynyt nimellä',
    crm ? `CRM: jo olemassa (${crm.display_name || crm.legal_name})` : 'CRM: uusi yritys — lisää CRM:ään ja soita tänään, kun asia on tuore.',
    `Saapui ${fiTime(r.created_at)}`,
  ]
    .filter(Boolean)
    .join('\n')
}

/** notify({ title, body, speech }) */
export function watchWebsite(notify, { findOrganization } = {}) {
  let stopped = false
  const tick = async () => {
    if (stopped || !websiteConfigured()) return
    const st = loadJson(STATE, {})
    try {
      if (!st.last) {
        // Ensimmäinen ajo: ei vanhoja ilmoituksia, vain merkki talteen.
        const latest = await getRequests({ order: 'created_at.desc', limit: '1' })
        st.last = latest[0]?.created_at ?? new Date().toISOString()
        console.log('[jarvis] kotisivu: yhteydenottojen seuranta alkoi')
      } else {
        const rows = await getRequests({ created_at: `gt.${st.last}`, order: 'created_at.asc', limit: '20' })
        for (const r of rows) {
          const extra = await enrich(r, findOrganization)
          await notify({
            title: `Uusi yhteydenotto kotisivulta: ${r.company}`,
            body: describe(r, extra),
            speech: `Johtaja, uusi yhteydenotto kotisivulta: ${r.company}${r.vehicle_count ? `, ${r.vehicle_count} autoa` : ''}.`,
          })
          st.last = r.created_at
        }
      }
      if (st.downSince) {
        await notify({ title: 'Kotisivun tietokanta toimii taas', body: 'Yhteydenottolomake tallentaa taas normaalisti.' })
        delete st.downSince
        delete st.downNotified
      }
    } catch (err) {
      st.downSince ??= new Date().toISOString()
      const day = new Date().toISOString().slice(0, 10)
      if (st.downNotified !== day) {
        st.downNotified = day
        const paused = err.status >= 500 || err.status === 0 || /fetch failed|ENOTFOUND|timeout|paused|540/i.test(String(err.message))
        await notify({
          title: 'Kotisivun lomake ei todennäköisesti toimi',
          body:
            `Kotisivun tietokanta ei vastaa (${String(err.message).slice(0, 120)}). Lomake tallentaa yhteydenoton ensin tietokantaan, ` +
            `joten asiakkaat näkevät virheen eikä myynti@ saa sähköpostia.` +
            (paused ? `\n\nKorjaus: supabase.com → projekti "kalustovahti Website" → Restore project.` : ''),
          speech: 'Johtaja, kotisivun yhteydenottolomake ei näytä toimivan. Tiedot puhelimessa.',
        })
      }
      console.warn('[jarvis] kotisivu:', err?.message ?? err)
    }
    saveJson(STATE, st)
  }
  const timer = setInterval(() => void tick(), POLL_MS)
  timer.unref?.()
  setTimeout(() => void tick(), 8_000)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

const ok = (text) => ({ content: [{ type: 'text', text }] })

export function websiteServer({ findOrganization } = {}) {
  return createSdkMcpServer({
    name: 'jarvis_kotisivu',
    version: '1.0.0',
    instructions: 'Kotisivun (kalustovahti.fi) yhteydenottopyynnöt, vain luku.',
    alwaysLoad: true,
    tools: [
      tool(
        'kotisivu_yhteydenotot',
        'Kotisivun yhteydenottolomakkeen pyynnöt (nimi, yritys, autot, puhelin, sähköposti, viesti) ja tieto, onko yritys jo CRM:ssä. Käytä kun kysytään "onko tullut yhteydenottoja", "kuka otti yhteyttä kotisivulta".',
        { paivia: z.number().optional().describe('Montako päivää taaksepäin, oletus 14') },
        async (a) => {
          if (!websiteConfigured()) return ok('Kotisivun yhteyttä ei ole asetettu: aja koneella asenna_kotisivu.bat.')
          try {
            const since = new Date(Date.now() - Math.max(1, Math.min(365, a.paivia ?? 14)) * 86400_000).toISOString()
            const rows = await getRequests({ created_at: `gte.${since}`, order: 'created_at.desc', limit: '30' })
            if (!rows.length) return ok('Ei yhteydenottoja tällä aikavälillä.')
            const out = []
            for (const r of rows.slice(0, 10)) out.push(describe(r, await enrich(r, findOrganization)))
            return ok(out.join('\n\n———\n\n') + (rows.length > 10 ? `\n\n(+${rows.length - 10} vanhempaa)` : ''))
          } catch (err) {
            return ok(`Kotisivun tietokanta ei vastaa (${String(err.message).slice(0, 100)}). Se voi olla paussilla: supabase.com → "kalustovahti Website" → Restore.`)
          }
        },
      ),
    ],
  })
}
