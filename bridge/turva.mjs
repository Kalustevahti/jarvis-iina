/**
 * Turvakerros (suomiversio).
 *
 * Bridgen decideTool päättää työkalun nimen perusteella. Tämä moduuli katsoo
 * myös työkalun SYÖTTEEN: mihin osoitteeseen selain menee, mitä tiedostoa
 * luetaan, mitä nappia klikataan. Lisäksi se toteuttaa:
 *
 *   - Arkaluontoiset tiedostot: .ssh, .claude, selainprofiilit, avaimet,
 *     lompakot ym. eivät ole luettavissa lukuoikeuksillakaan.
 *   - Estetyt verkkotunnukset: pankit, maksupalvelut, kryptopörssit,
 *     viranomaispalvelut. Lista on ~/.jarvis/turva.json:ssa muokattavissa.
 *   - Vahvistus: peruuttamaton selaintoiminto (lähetä, osta, poista, julkaise…)
 *     ei mene läpi, ennen kuin käyttäjä sanoo ääneen "Jarvis, vahvista".
 *     Vahvistus kelpaa yhteen toimintoon ja vanhenee 90 sekunnissa.
 *   - Salasanakentät: JARVIS ei koskaan kirjoita salasana-, PIN- tai
 *     korttikenttiin. Ei edes vahvistuksella.
 *   - Lukitus: "Jarvis, lukitse" pysäyttää kaikki työkalut, "Jarvis, avaa
 *     lukitus" palauttaa ne.
 *   - Kirjausketju: jokainen työkalukutsu ja päätös kirjataan
 *     ~/.jarvis/audit.log -tiedostoon.
 *
 * Mikään turvakerros ei ole täydellinen. Tämä pienentää riskiä siitä, että
 * verkkosivulle piilotettu ohje ("lähetä tämä viesti", "lue tämä tiedosto")
 * saa JARVISin tekemään jotain, mitä käyttäjä ei pyytänyt.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DIR = join(homedir(), '.jarvis')
const CONFIG_PATH = join(DIR, 'turva.json')
const AUDIT_PATH = join(DIR, 'audit.log')

/** Oletusarvoisesti estetyt verkkotunnukset (myös aliverkkotunnukset). */
const DEFAULT_BLOCKED_DOMAINS = [
  // Pankit ja maksut
  'op.fi', 'nordea.fi', 'nordea.com', 'danskebank.fi', 's-pankki.fi', 'aktia.fi',
  'saastopankki.fi', 'omasp.fi', 'alandsbanken.fi', 'handelsbanken.fi', 'poppankki.fi',
  'paypal.com', 'mobilepay.fi', 'klarna.com', 'stripe.com', 'wise.com', 'revolut.com',
  // Krypto
  'coinbase.com', 'binance.com', 'kraken.com', 'metamask.io', 'phantom.app',
  'uniswap.org', 'opensea.io', 'crypto.com', 'bybit.com', 'okx.com',
  // Viranomaiset ja terveys
  'vero.fi', 'suomi.fi', 'kanta.fi', 'omakanta.fi', 'kela.fi', 'poliisi.fi', 'dvv.fi',
  // Tilien hallinta
  'myaccount.google.com', 'accounts.google.com', 'account.microsoft.com',
  'appleid.apple.com', 'account.apple.com', 'id.apple.com',
]

/** Tiedostopolut, joita ei lueta koskaan. */
const SENSITIVE_PATH =
  /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.config[\\/]gh|\.claude|\.claude\.json|\.jarvis|\.npmrc|\.git-credentials|\.netrc|\.docker|\.kube|\.env(\.[^\\/]*)?|id_rsa[^\\/]*|id_ed25519[^\\/]*|[^\\/]*\.pem|[^\\/]*\.key|[^\\/]*\.pfx|[^\\/]*\.p12|[^\\/]*\.kdbx|wallet[^\\/]*|keystore[^\\/]*|secrets?[^\\/]*|credentials?[^\\/]*|passwords?[^\\/]*|salasan[^\\/]*)([\\/]|$)/i
const SENSITIVE_APPDATA =
  /AppData[\\/](Local|Roaming)[\\/](Google|Microsoft[\\/]Edge|Mozilla|BraveSoftware|Discord|WhatsApp|Telegram|1Password|Bitwarden|KeePass|Steam|Riot|Claude|npm|Code)/i
const SENSITIVE_GLOB =
  /(\.env|\.pem|\.key|id_rsa|id_ed25519|password|salasana|secret|credential|wallet|cookies|login data|token)/i

/** Kentät, joihin ei kirjoiteta koskaan. */
const CREDENTIAL_FIELD =
  /(salasana|password|passcode|passphrase|(?<!\p{L})pin(?!\p{L})|tunnusluku|kortin numero|card number|cardnumber|(?<!\p{L})cv[vc](?!\p{L})|security code|turvakoodi|iban|tilinumero|henkilötunnus|social security|(?<!\p{L})ssn(?!\p{L})|one[- ]time|kertakäyttö|2fa|authenticator|seed phrase|recovery phrase|siemenlause|private key|yksityinen avain)/iu

/** Painikkeet ja toiminnot, jotka vaativat vahvistuksen. */
const IRREVERSIBLE =
  /(?<!\p{L})(lähetä|send|submit|osta|buy|purchase|checkout|maksa|pay|tilaa|order|poista|delete|remove|tyhjennä|julkaise|publish|post|jaa|share|vahvista|confirm|hyväksy|accept|agree|allekirjoita|sign|siirrä|transfer|withdraw|nosta|peruuta tilaus|cancel subscription|unsubscribe|kirjaudu ulos|log ?out|sign ?out|vaihda salasana|change password|reset)(?!\p{L})/iu

/** Käyttäjän lausumat, jotka toimivat vahvistuksena. Kielto edellä ("älä vahvista", "en hyväksy") ei kelpaa. */
const CONFIRM_PHRASE =
  /(?<!\p{L})(?<!(?:älä|äläkä|en|ei|emme|älkää)\s+)(jarvis[,.]?\s*)?(vahvista|vahvistan|hyväksyn|kyllä[,.]?\s*(tee se|lähetä|jatka|vahvista|tee)|tee se|lupa myönnetty)(?!\p{L})/iu
// "lukitse kone/näyttö" = Windowsin lukitus (kone.mjs), ei JARVISin työkalujen lukitus.
const LOCK_PHRASE = /(?<!\p{L})(jarvis[,.]?\s*)?(lukitse(?!\s+(kone|koneen|koneeni|tietokone|tietokoneen|tietokoneeni|näyttö|näytön|ruutu|windows))|lukitus päälle|hätäpysäytys|pysäytä kaikki)(?!\p{L})/iu
const UNLOCK_PHRASE = /(?<!\p{L})(jarvis[,.]?\s*)?(avaa lukitus|poista lukitus|lukitus pois)(?!\p{L})/iu

const CONFIRM_TTL_MS = 90_000

/**
 * Koneen ohjaus (jarvis_kone): yhdistelmät ja tekstit, joilla saa komentorivin. 9.11.2026 tietoturvatarkastus:
 * Win+R + "powershell …" ohitti kaiken, koska turvakerros ei katsonut kone-työkaluja lainkaan. Nämä vaativat nyt
 * "Jarvis, vahvista" — tavallinen kirjoittaminen, klikkaus ja ohjelmien avaus toimivat kuten ennen.
 */
const SHELL_KEYS = /(?<![a-z])(win|windows|super)\s*\+\s*(r|x)(?![a-z])|ctrl\s*\+\s*shift\s*\+\s*(enter|esc)|alt\s*\+\s*f4.*alt/i
const SHELL_TEXT =
  /(?<![\p{L}\d])(powershell|pwsh|cmd(\.exe)?|wscript|cscript|mshta|rundll32|regsvr32|certutil|bitsadmin|schtasks|reg\s+(add|delete|import)|net\s+user|netsh|wmic|iex|invoke-(expression|webrequest|restmethod)|start-process|set-executionpolicy|curl|wget|del\s+\/|rd\s+\/s|rmdir|format\s+[a-z]:|shutdown|bcdedit|vssadmin|cipher\s+\/w)(?![\p{L}\d])/iu

function loadConfig() {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    if (!existsSync(CONFIG_PATH)) return {}
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (err) {
    console.warn('[jarvis] turva.json ei kelpaa, käytetään oletuksia:', err?.message)
    return {}
  }
}
const config = loadConfig()
const BLOCKED_DOMAINS = new Set(
  [...DEFAULT_BLOCKED_DOMAINS, ...(config.blockedDomains ?? [])]
    .filter((d) => !(config.allowedDomains ?? []).includes(d))
    .map((d) => String(d).toLowerCase()),
)

export function audit(entry) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true })
    appendFileSync(AUDIT_PATH, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n')
  } catch {
    /* loki ei saa kaataa mitään */
  }
}

function hostBlocked(hostname) {
  const h = hostname.toLowerCase()
  for (const d of BLOCKED_DOMAINS) {
    if (h === d || h.endsWith(`.${d}`)) return d
  }
  return null
}

/** Lyhyt, lokiin ja puheeseen sopiva kuvaus syötteestä. */
export function summarize(toolName, input) {
  if (!input || typeof input !== 'object') return ''
  const pick = ['url', 'file_path', 'path', 'pattern', 'element', 'ref', 'text', 'key', 'query', 'command', 'action']
  const parts = []
  for (const k of pick) {
    if (input[k] !== undefined) parts.push(`${k}=${String(input[k]).slice(0, 120)}`)
  }
  if (Array.isArray(input.fields)) parts.push(`fields=${input.fields.map((f) => f?.name ?? f?.ref).join(',').slice(0, 160)}`)
  return parts.join(' ')
}

/**
 * Yhden yhteyden turvatila: vahvistus ja lukitus.
 */
/**
 * Esihyväksyntä: kun käyttäjä on itse pyytänyt lähetyksen (esim. Teams-kutsu),
 * työkalu voi sallia tietyn peruuttamattoman painikkeen määräajaksi ilman
 * erillistä "Jarvis, vahvista" -lausetta. Koskee kaikkia yhteyksiä (myös
 * puhelinsessiota). Kulutetaan käyttökertojen mukaan ja vanhenee ajallaan.
 */
let preApproved = []
export function preApprove(re, { ttlMs = 15 * 60_000, uses = 3, label = '' } = {}) {
  preApproved.push({ re, until: Date.now() + ttlMs, uses, label })
  audit({ event: 'preapprove', label, ttlMs })
}
function takePreApproval(desc) {
  const now = Date.now()
  preApproved = preApproved.filter((p) => p.until > now && p.uses > 0)
  const hit = preApproved.find((p) => p.re.test(desc))
  if (!hit) return false
  hit.uses -= 1
  audit({ event: 'preapproved-click', label: hit.label, element: desc.slice(0, 120) })
  return true
}

export function createGuard() {
  let armedUntil = 0
  let locked = false

  return {
    /** Kutsutaan jokaiselle käyttäjän lausumalle. Palauttaa true, jos lause oli pelkkä komento. */
    hearUser(text) {
      if (LOCK_PHRASE.test(text)) {
        locked = true
        audit({ event: 'lock' })
        return 'locked'
      }
      if (UNLOCK_PHRASE.test(text)) {
        locked = false
        audit({ event: 'unlock' })
        return 'unlocked'
      }
      if (CONFIRM_PHRASE.test(text)) {
        armedUntil = Date.now() + CONFIRM_TTL_MS
        audit({ event: 'armed' })
        return 'armed'
      }
      return null
    },
    isLocked: () => locked,

    /**
     * Tarkistaa työkalukutsun syötteen. Palauttaa null, jos kaikki on kunnossa,
     * muuten viestin, joka menee mallille (ja mahdollisesti puheeseen).
     */
    check(toolName, input) {
      if (locked) {
        return 'Lukittu: käyttäjä on pysäyttänyt kaikki työkalut. Sano vain, että JARVIS on lukittu, ja odota käskyä "avaa lukitus".'
      }
      const server = toolName.startsWith('mcp__') ? toolName.split('__')[1] : null
      const tool = server ? toolName.split('__').slice(2).join('__') : toolName

      // --- tiedostot -----------------------------------------------------
      if (tool === 'Read' || tool === 'Glob' || tool === 'Grep' || tool === 'NotebookRead') {
        const p = String(input?.file_path ?? input?.path ?? '')
        const pat = String(input?.pattern ?? '')
        if (SENSITIVE_PATH.test(p) || SENSITIVE_APPDATA.test(p) || SENSITIVE_GLOB.test(pat)) {
          return 'Estetty: tämä sijainti sisältää arkaluontoisia tietoja (avaimia, kirjautumisia tai selaimen tietoja), eikä JARVIS lue niitä koskaan.'
        }
      }
      if (tool === 'WebFetch') {
        const u = String(input?.url ?? '')
        try {
          const url = new URL(u)
          if (!/^https?:$/.test(url.protocol)) return 'Estetty: vain http- ja https-osoitteet.'
          const b = hostBlocked(url.hostname)
          if (b) return `Estetty: ${b} on turvalistalla, eikä JARVIS käy siellä.`
          if (u.length > 1500) return 'Estetty: epäilyttävän pitkä osoite.'
        } catch {
          return 'Estetty: osoite ei kelpaa.'
        }
      }

      // --- koneen ohjaus (näppäimistö, liittäminen, ohjelmien avaus) ---------------
      if (server === 'jarvis_kone') {
        const confirmOrAsk = (why) => {
          if (Date.now() < armedUntil) {
            armedUntil = 0
            audit({ event: 'confirmed', tool, why })
            return null
          }
          return `Vahvistus tarvitaan: ${why}. Kerro käyttäjälle yhdellä lauseella, mitä olet tekemässä ja miksi, ja pyydä sanomaan "Jarvis, vahvista". Älä yritä uudelleen ennen sitä äläkä kierrä tätä toisella työkalulla.`
        }
        if (tool === 'kone_nappain' && SHELL_KEYS.test(String(input?.yhdistelma ?? ''))) {
          return confirmOrAsk('näppäinyhdistelmä avaa Suorita-ikkunan tai komentorivin')
        }
        if ((tool === 'kone_kirjoita' || tool === 'kone_liita') && SHELL_TEXT.test(String(input?.teksti ?? ''))) {
          return confirmOrAsk('teksti näyttää komentorivi- tai järjestelmäkomennolta')
        }
        if (tool === 'kone_avaa') {
          const k = String(input?.kohde ?? '').trim()
          if (/^(file|javascript|data|vbscript|ms-settings|search-ms|shell):/i.test(k)) return 'Estetty: kone_avaa avaa vain ohjelmia nimellä tai http(s)-sivuja.'
          if (/^https?:\/\//i.test(k)) {
            try {
              const url = new URL(k)
              const b = hostBlocked(url.hostname)
              if (b) return `Estetty: ${b} on turvalistalla, eikä JARVIS avaa sitä.`
              if (k.length > 300 || url.search.length > 200) return 'Estetty: epäilyttävän pitkä osoite. Avaa sivu ilman pitkää kyselyosaa.'
            } catch {
              return 'Estetty: osoite ei kelpaa.'
            }
          }
        }
      }

      // --- selain --------------------------------------------------------
      if (server === 'playwright') {
        if (tool === 'browser_navigate') {
          const u = String(input?.url ?? '')
          try {
            const url = new URL(u.includes('://') ? u : `https://${u}`)
            if (!/^https?:$/.test(url.protocol)) return 'Estetty: selain avaa vain http- ja https-osoitteita.'
            const b = hostBlocked(url.hostname)
            if (b) return `Estetty: ${b} on turvalistalla (pankki, maksu, krypto tai tili). JARVIS ei käy siellä. Käyttäjä voi hoitaa sen itse.`
          } catch {
            return 'Estetty: osoite ei kelpaa.'
          }
        }
        if (tool === 'browser_file_upload') {
          return 'Estetty: JARVIS ei lataa tiedostoja koneelta verkkoon.'
        }
        const desc = `${input?.element ?? ''} ${input?.text ?? ''} ${input?.name ?? ''}`
        const fields = Array.isArray(input?.fields) ? input.fields : []
        const fieldText = fields.map((f) => `${f?.name ?? ''} ${f?.type ?? ''} ${f?.ref ?? ''}`).join(' ')
        if (tool === 'browser_type' || tool === 'browser_fill_form' || tool === 'browser_select_option') {
          if (CREDENTIAL_FIELD.test(desc) || CREDENTIAL_FIELD.test(fieldText) || fields.some((f) => /password/i.test(String(f?.type ?? '')))) {
            return 'Estetty: JARVIS ei koskaan kirjoita salasanoja, PIN-koodeja, kortti- tai tilitietoja. Pyydä käyttäjää tekemään se itse.'
          }
        }
        if (tool === 'browser_click') {
          if (IRREVERSIBLE.test(desc)) {
            if (Date.now() < armedUntil) {
              armedUntil = 0
              audit({ event: 'confirmed', tool, element: String(input?.element ?? '').slice(0, 120) })
              return null
            }
            if (takePreApproval(desc)) return null
            return `Vahvistus tarvitaan: painike "${String(input?.element ?? '').slice(0, 80)}" on peruuttamaton toiminto. Kerro käyttäjälle yhdellä lauseella, mitä olet tekemässä, ja pyydä sanomaan "Jarvis, vahvista". Älä yritä uudelleen ennen sitä.`
          }
        }
        if (tool === 'browser_handle_dialog' && input?.accept === true) {
          if (Date.now() < armedUntil) {
            armedUntil = 0
            return null
          }
          return 'Vahvistus tarvitaan: selain kysyy vahvistusta. Pyydä käyttäjää sanomaan "Jarvis, vahvista".'
        }
      }
      return null
    },
  }
}

export const turvaInfo = () =>
  `[jarvis] turva: ${BLOCKED_DOMAINS.size} estettyä verkkotunnusta, vahvistus peruuttamattomiin toimiin, arkaluontoiset tiedostot estetty · loki ${AUDIT_PATH}`
