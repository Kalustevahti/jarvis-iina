/**
 * PRH:n avoin YTJ-rajapinta (v3) — viralliset yritystiedot, ilmainen, CC BY 4.0.
 * https://avoindata.prh.fi/opendata-ytj-api/v3  (lähde: Patentti- ja rekisterihallitus)
 *
 * Käyttö: tapaamisvalmistelu (yrityksen perustiedot Y-tunnuksella) ja liidikone
 * (yritykset toimialan ja paikkakunnan mukaan). Vain GET, ei avaimia.
 */
const BASE = 'https://avoindata.prh.fi/opendata-ytj-api/v3'

/** Kalustovahdin kohdetoimialat (TOL 2008), liiketoimintasuunnitelman mukaan. */
export const TARGET_LINES = [
  { code: '43220', label: 'LVI-asennus' },
  { code: '43210', label: 'sähköasennus' },
  { code: '81100', label: 'kiinteistöhuolto' },
  { code: '43', label: 'erikoistunut rakentaminen (saneeraus, maanrakennus ym.)' },
  { code: '41200', label: 'talonrakentaminen' },
  { code: '49410', label: 'tieliikenteen tavarankuljetus' },
  { code: '53200', label: 'jakelu ja kuriiripalvelut' },
  { code: '81300', label: 'viherrakentaminen ja maisemanhoito' },
]
/** Liiketoimintasuunnitelma: 1) pääkaupunkiseutu, 2) Turku ja Varsinais-Suomi. */
export const TARGET_CITIES = ['Helsinki', 'Espoo', 'Vantaa', 'Turku', 'Kaarina', 'Raisio', 'Naantali', 'Lieto', 'Kerava', 'Kauniainen']
/** "Koko Suomi": suurimmat kaupungit (YTJ hakee paikkakunnittain). */
export const FINLAND_CITIES = [
  'Helsinki', 'Espoo', 'Tampere', 'Vantaa', 'Oulu', 'Turku', 'Jyväskylä', 'Kuopio', 'Lahti', 'Pori', 'Kouvola', 'Joensuu',
  'Lappeenranta', 'Hämeenlinna', 'Vaasa', 'Seinäjoki', 'Rovaniemi', 'Mikkeli', 'Kotka', 'Salo', 'Porvoo', 'Kokkola',
  'Hyvinkää', 'Lohja', 'Järvenpää', 'Rauma', 'Kajaani', 'Kerava', 'Nokia', 'Kangasala',
]

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
  if (res.status === 429) throw new Error('YTJ: liikaa pyyntöjä, yritetään myöhemmin')
  if (!res.ok) throw new Error(`YTJ HTTP ${res.status}`)
  return res.json()
}

const fi = (descs) => (Array.isArray(descs) ? descs.find((d) => d.languageCode === '1')?.description ?? descs[0]?.description ?? '' : '')

/** Yksinkertaistettu yritys. */
export function simplify(c) {
  const name = (c.names ?? []).find((n) => String(n.version) === '1' && !n.endDate)?.name ?? c.names?.[0]?.name ?? ''
  const addr = (c.addresses ?? []).find((a) => String(a.type) === '1') ?? c.addresses?.[0]
  const city = addr?.postOffices?.find((p) => p.languageCode === '1')?.city ?? addr?.postOffices?.[0]?.city ?? ''
  const form = (c.companyForms ?? []).find((f) => !f.endDate)
  const troubled = (c.companySituations ?? []).some((s) => !s.endDate) // saneeraus, selvitystila, konkurssi
  const entries = c.registeredEntries ?? []
  const activeIn = (reg, type) => entries.some((e) => String(e.register) === reg && (!type || String(e.type) === type) && !e.endDate)
  const since = (reg) => entries.find((e) => String(e.register) === reg && !e.endDate)?.registrationDate ?? ''
  return {
    businessId: c.businessId?.value ?? '',
    name,
    line: c.mainBusinessLine?.type ?? '',
    lineText: fi(c.mainBusinessLine?.descriptions),
    city: city ? city.charAt(0) + city.slice(1).toLowerCase() : '',
    street: addr?.street ? `${addr.street} ${addr.buildingNumber ?? ''}`.trim() : '',
    postCode: addr?.postCode ?? '',
    website: c.website?.url ?? '',
    registered: c.registrationDate ?? c.businessId?.registrationDate ?? '',
    form: fi(form?.descriptions) || form?.type || '',
    active: !c.endDate && !troubled && String(c.tradeRegisterStatus ?? '1') === '1',
    /** Työnantajarekisteri (REK 7): maksaa säännöllisesti palkkoja = on henkilöstöä. */
    employer: activeIn('7'),
    employerSince: since('7'),
    /** Arvonlisäverovelvollinen liiketoiminnasta (REK 6, tyyppi 80). */
    vat: activeIn('6', '80'),
    addressCount: (c.addresses ?? []).length,
  }
}

export async function companyById(businessId) {
  const id = String(businessId ?? '').trim()
  if (!/^\d{7}-\d$/.test(id)) return null
  const j = await getJson(`${BASE}/companies?businessId=${encodeURIComponent(id)}`)
  return j.companies?.[0] ? simplify(j.companies[0]) : null
}

export async function searchCompanies({ line, city, name, page = 1 } = {}) {
  const p = new URLSearchParams()
  if (line) p.set('mainBusinessLine', line)
  if (city) p.set('location', city)
  if (name) p.set('name', name)
  if (page > 1) p.set('page', String(page))
  const j = await getJson(`${BASE}/companies?${p}`)
  return { total: Number(j.totalResults) || 0, companies: (j.companies ?? []).map(simplify) }
}

/** Linkki yrityksen koon (liikevaihto, henkilöstö) tarkistamiseen. */
export const sizeLink = (businessId) => `https://www.finder.fi/search?what=${encodeURIComponent(businessId)}`
export const ytjLink = (businessId) => `https://tietopalvelu.ytj.fi/yritys/${encodeURIComponent(businessId)}`
