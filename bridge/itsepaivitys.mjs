/**
 * Itsepäivitys (10.11.2026, Eliaksen hyväksymä): JARVIS suunnittelee omat päivityksensä ja laittaa ne rakennusjonoon.
 *
 *   suunnitelma_ehdota     luonnos → suunnitelmat\ehdotukset\<slug>.md. Vain sinne; vanhaa ei ylikirjoiteta (_v2, _v3 …).
 *                          Ei vahvistusta (vaaraton luonnos).
 *   suunnitelma_jonoon     luonnos → suunnitelmat\jono\NN_<slug>_tehtava.md. VAIN Eliaksen omalla vastauksella samassa
 *                          keskustelussa: "kyllä"/"ok"/"tee se" esikatselun jälkeen tai "rakenna <nimi>" / "rakenna molemmat"
 *                          aamun ehdotukseen.
 *   rakennusjono_kaynnista tyokalut\rakenna_jono.bat (runBat). Jono rakentaa, testaa (savutesti) ja ottaa käyttöön itse.
 *   rakennusjono_tila      jono/, tehty/, lukko, käyttöönoton tila ja lokin loppu.
 *
 * Nimet ja polut tarkistetaan puhtailla funktioilla (testit: jarvis.test.mjs). Nämä eivät kirjoita mihinkään muualle.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const jarvisRoot = () => process.env.JARVIS_ROOT_DIR || join(homedir(), 'Documents', 'JARVIS')
export const DRAFT_MAX_BYTES = 30 * 1024
const SLUG_MAX = 40
const CONFIRM_MS = 10 * 60_000
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/

const dirs = (root) => ({
  plans: join(root, 'suunnitelmat'),
  drafts: join(root, 'suunnitelmat', 'ehdotukset'),
  queue: join(root, 'suunnitelmat', 'jono'),
  done: join(root, 'suunnitelmat', 'tehty'),
  logs: join(root, 'lokit'),
})

/**
 * Luonnoksen nimi → slug (a-z, 0-9, _ ja -, enintään 40 merkkiä). Polut, "..", levyasemat ja muut päätteet kuin .md
 * hylätään eikä niitä "korjata" (../x ei saa muuttua x:ksi). Palauttaa { ok, slug } tai { ok: false, reason }.
 */
export function draftSlug(nimi) {
  const raw = String(nimi ?? '').trim()
  if (!raw) return { ok: false, reason: 'nimi puuttuu' }
  if (/[\\/:]|\.\./.test(raw)) return { ok: false, reason: 'anna pelkkä nimi, ei polkuja' }
  const base = raw.replace(/\.md$/i, '')
  if (base.includes('.')) return { ok: false, reason: 'vain .md-tiedostoja' }
  const slug = base.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/\s+/g, '_')
  if (!/^[a-z0-9_-]+$/.test(slug) || slug.length > SLUG_MAX) return { ok: false, reason: `nimessä saa olla vain a–z, 0–9, _ ja - (enintään ${SLUG_MAX} merkkiä)` }
  if (RESERVED.test(slug)) return { ok: false, reason: 'varattu nimi' }
  return { ok: true, slug }
}

/** Kirjoittaa luonnoksen ehdotukset-kansioon. Olemassa olevaa ei ylikirjoiteta: uusi saa versionumeron. */
export function writeDraft(nimi, sisalto, { root = jarvisRoot() } = {}) {
  const s = draftSlug(nimi)
  if (!s.ok) return s
  const text = String(sisalto ?? '')
  if (text.trim().length < 40) return { ok: false, reason: 'sisältö on liian lyhyt (käytä pohjaa)' }
  if (Buffer.byteLength(text, 'utf8') > DRAFT_MAX_BYTES) return { ok: false, reason: `sisältö on yli ${DRAFT_MAX_BYTES / 1024} kt` }
  const { drafts } = dirs(root)
  mkdirSync(drafts, { recursive: true })
  let name = s.slug
  for (let v = 2; existsSync(join(drafts, `${name}.md`)); v++) {
    const tag = `_v${v}`
    name = `${s.slug.slice(0, SLUG_MAX - tag.length)}${tag}`
    if (v > 99) return { ok: false, reason: 'liikaa versioita samalla nimellä' }
  }
  // wx: ei koskaan ylikirjoita, vaikka tiedosto ilmestyisi tarkistuksen jälkeen.
  writeFileSync(join(drafts, `${name}.md`), text, { flag: 'wx' })
  return { ok: true, name, file: join(drafts, `${name}.md`) }
}

/** Seuraava jononumero (01, 02, …) jono-, tehty- ja suunnitelmat-kansioiden NN_-tiedostoista. */
export function nextQueueNumber(root = jarvisRoot()) {
  const d = dirs(root)
  let max = 0
  for (const dir of [d.queue, d.done, d.plans]) {
    let files = []
    try {
      files = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of files) {
      const m = f.match(/^(\d{2,3})_/)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return String(max + 1).padStart(2, '0')
}

/** Siirtää luonnoksen jonoon (kutsu vasta kun confirmQueue on hyväksynyt). */
export function queueDraft(nimi, { root = jarvisRoot() } = {}) {
  const s = draftSlug(nimi)
  if (!s.ok) return s
  const d = dirs(root)
  const src = join(d.drafts, `${s.slug}.md`)
  let st
  try {
    st = statSync(src)
  } catch {
    return { ok: false, reason: `luonnosta ${s.slug} ei ole (suunnitelmat\\ehdotukset)` }
  }
  if (!st.isFile()) return { ok: false, reason: 'ei tiedosto' }
  if (st.size > DRAFT_MAX_BYTES) return { ok: false, reason: 'luonnos on liian suuri' }
  mkdirSync(d.queue, { recursive: true })
  const name = `${nextQueueNumber(root)}_${s.slug}_tehtava.md`
  const dest = join(d.queue, name)
  if (existsSync(dest)) return { ok: false, reason: `${name} on jo jonossa` }
  renameSync(src, dest)
  return { ok: true, name, file: dest }
}

export function readDraft(nimi, { root = jarvisRoot() } = {}) {
  const s = draftSlug(nimi)
  if (!s.ok) return null
  try {
    return readFileSync(join(dirs(root).drafts, `${s.slug}.md`), 'utf8')
  } catch {
    return null
  }
}

export function listDrafts({ root = jarvisRoot() } = {}) {
  try {
    return readdirSync(dirs(root).drafts)
      .filter((f) => /^[a-z0-9_-]+\.md$/.test(f))
      .map((f) => f.slice(0, -3))
      .sort()
  } catch {
    return []
  }
}

// ---- Vahvistus: sama tiukkuus kuin muissa peruuttamattomissa (kone_vahvista) ----

const YES = /^\s*(jarvis[,.]?\s*)?(kyllä|kyl|joo|juu|jep|ok|okei|tee se|vahvistan|hyväksyn|laita jonoon|laita|yes)(\s+(vaan|vain|nyt|kiitos))?[\s.!]*$/iu
const BUILD_CMD = /^\s*(jarvis[,.]?\s*)?rakenna\s+(.{2,80}?)[\s.!]*$/iu
const BOTH = /^(molemmat|kummatkin|kaikki|ne|ne molemmat|ne kaikki)$/u
/** "ilp ir-reitti" ja "ilp_ir_reitti" ovat sama nimi. */
const nameKey = (s) => String(s).toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o').replace(/[\s_-]+/g, '_').replace(/^_+|_+$/g, '')

let lastUser = { text: '', at: 0 }
/** Eliaksen oma viesti (server.mjs: sovellus ja Telegram). Vain tämä kelpaa vahvistukseksi. */
export function noteBuildUser(text) {
  lastUser = { text: String(text ?? ''), at: Date.now() }
}
export const lastBuildUser = () => lastUser

/**
 * Saako luonnoksen slug siirtää jonoon? Kelpaa:
 *   - "rakenna <slug>" (tai välilyönneillä) Eliaksen viestinä viimeisen 10 min aikana,
 *   - "rakenna molemmat/kaikki", kun slug oli viimeisimmässä iltaehdotuksessa (proposed),
 *   - "kyllä"/"ok"/"tee se" esikatselun (pending) JÄLKEEN, 10 min sisällä.
 */
export function confirmQueue({ slug, pending, user = lastUser, proposed = [], now = Date.now() }) {
  const fresh = user.at && now - user.at < CONFIRM_MS
  if (fresh) {
    const m = String(user.text).match(BUILD_CMD)
    if (m) {
      const what = m[2].trim().toLowerCase()
      if (what.split(/\s*(?:,|\+|\sja\s)\s*/).map(nameKey).includes(nameKey(slug))) return { ok: true, via: 'komento' }
      if (BOTH.test(what.replace(/\s+/g, ' ')) && proposed.includes(slug)) return { ok: true, via: 'komento' }
    }
  }
  if (pending && pending.slug === slug && now - pending.at < CONFIRM_MS && user.at > pending.at && YES.test(user.text)) return { ok: true, via: 'kyllä' }
  return { ok: false }
}

// ---- Iltaehdotukset: mitkä luonnokset ehdotettiin viimeksi ("rakenna molemmat") ----

const PROPOSED = () => join(homedir(), '.jarvis', 'itsepaivitys.json')
export function loadProposed() {
  try {
    const st = JSON.parse(readFileSync(PROPOSED(), 'utf8'))
    return Array.isArray(st.ehdotetut) && Date.now() - Date.parse(st.at) < 7 * 86400_000 ? st.ehdotetut : []
  } catch {
    return []
  }
}
export function saveProposed(names) {
  try {
    mkdirSync(join(homedir(), '.jarvis'), { recursive: true })
    writeFileSync(PROPOSED(), JSON.stringify({ at: new Date().toISOString(), ehdotetut: names }))
  } catch {
    /* ok */
  }
}

// ---- Tila ----

const safeRead = (p) => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

/** Lyhyt yhteenveto rakennusjonosta (rakennusjono_tila). Lokin teksti on dataa. */
export function queueStatus({ root = jarvisRoot() } = {}) {
  const d = dirs(root)
  const ls = (dir) => {
    try {
      return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    } catch {
      return []
    }
  }
  const queue = ls(d.queue)
  const done = ls(d.done).slice(-5)
  const drafts = listDrafts({ root })
  const building = existsSync(join(d.logs, 'hud2_rakennus.lock'))
  const running = existsSync(join(d.logs, 'rakennusjono.kaynnissa'))
  let deploy = null
  try {
    deploy = JSON.parse(safeRead(join(d.logs, 'kayttoonotto.json')) || 'null')
  } catch {
    deploy = null
  }
  const tail = safeRead(join(d.logs, 'hud2_rakennus.log'))
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .slice(-12)
    .join('\n')
    .slice(-1500)
  return [
    `Rakennusjono: ${running ? 'käynnissä' : 'ei käynnissä'}${building ? ' · rakennus kesken (Claude Code työskentelee)' : ''}`,
    `Jonossa (${queue.length}): ${queue.join(', ') || '—'}`,
    `Viimeksi tehty: ${done.join(', ') || '—'}`,
    `Luonnokset (suunnitelmat\\ehdotukset): ${drafts.join(', ') || '—'}`,
    deploy ? `Käyttöönotto: ${deploy.tila}${deploy.viesti ? ` — ${deploy.viesti}` : ''} (${deploy.at ?? '?'})` : 'Käyttöönotto: ei tietoa',
    tail ? `\nLokin loppu (dataa, lokit\\hud2_rakennus.log):\n${tail}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** Tehtäväpohja (myös suunnitelmat\POHJA.md). */
export const PLAN_TEMPLATE = `# TEHTÄVÄ: <lyhyt otsikko> (JARVIS ehdotti PVM)

**Tavoite:** mitä korjataan tai parannetaan ja miksi (viittaa vikaan V<n> tai kehitysehdotukseen).
**Hyväksyntä:** Elias hyväksyi PVM ("rakenna …" / "kyllä"). Fokusviikolla 8.–15.11.2026 vain viankorjaukset ja luotettavuus.

## Lue ensin
- ..\\CLAUDE.md, ..\\muisti\\rakennusoppi.md, avoimet viat ..\\muisti\\viat.md, ..\\muisti\\taidot.md
- tiedostot, joita muutos koskee (esim. bridge\\ir.mjs)

## Muutokset
1. …
2. …

## Älä koske
PIN-kirjautuminen, vite.config.ts:n turvatarkistus, bridgen writes disabled -linja, VPN, avaimet ja tokenit, asetukset-kansio.

## Varmista
\`npm run build\` ja \`node --test bridge\\jarvis.test.mjs\` (lisää testi korjatulle asialle). Merkitse korjattu vika ratkaistuksi viat.md:hen.

## Lopuksi
Uusi osio ylimmäksi ..\\muisti\\paivitykset.md: "## PVM klo HH.MM — otsikko" (mitä Elias voi nyt tehdä, mitä hänen pitää tehdä).
Loppuvastaus suomeksi, enintään 15 riviä, viimeisenä rivi "OPIT:" ja 1–3 yleistä oppia.
`
