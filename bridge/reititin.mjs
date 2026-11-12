/**
 * Mallireititin: halpa malli (Haiku) helppoihin, Sonnet vaativiin. Ei mallikutsua —
 * päätös tehdään sääntöpohjaisesti mikrosekunneissa, joten reititys itse ei maksa mitään.
 *
 * Periaate: epävarmassa tapauksessa Sonnet. Haikulle menevät vain selvästi kevyet:
 * kellonaika/päivä, sää, lyhyet CRM-listaukset ("mitä tapaamisia huomenna"), kuittaukset,
 * avaa/sulje-komennot. Myynti, neuvot, analyysi, kirjoittaminen, liidit, kokous ja
 * monivaiheiset tehtävät pysyvät Sonnetilla.
 *
 * Kolme tasoa: Haiku (laitekomennot, small talk, kellonaika) · Sonnet (oletus: myynti, CRM, liidit, ohjaus) ·
 * Opus (strategia, perusteellinen analyysi; JARVIS_DEEP=0 pois). Liidien pisteytys ja kokousanalyysi käyttävät Opusta omissa moduuleissaan.
 *
 * Ympäristömuuttujat:
 *   JARVIS_FAST_MODEL   (oletus "haiku")      — kevyt malli
 *   JARVIS_ROUTER=0                           — reititys pois (aina oletusmalli)
 */
export const FAST_MODEL = process.env.JARVIS_FAST_MODEL || 'haiku'
export const ROUTER_ON = process.env.JARVIS_ROUTER !== '0'

const HEAVY = new RegExp(
  [
    'myyn', 'strategi', 'analy', 'arvio', 'miksi', 'mieti', 'suunnit', 'valmistel', 'liidi', 'tarjou', 'hinnoit',
    'kirjoita', 'luonnos', 'sähköpost', 'viesti', 'vertaa', 'neuvo', 'ehdota', 'opeta', 'selitä', 'kerro kunnolla',
    'mitä teen', 'mitä tehdä', 'pitäisi', 'kannattaa', 'seuraavaksi', 'seuraava askel', 'paras tapa', 'miten', 'vastaväit', 'asiakas sano', 'raportti', 'yhteenveto',
    'kokous', 'teams', 'tapaaminen kanssa', 'luo ', 'varaa', 'lähetä', 'hae netistä', 'etsi netistä', 'tutki',
    'hyväksy', 'hylkää', 'sääntö', 'muista', 'kirjaa', 'merkitse', 'tulos', 'seuranta', 'muuta vaihe', 'osake', 'koodi', 'claude', 'selain', 'avaa sivu', 'verkkosivu',
    'strategy', 'sales', 'analy', 'write', 'draft', 'explain', 'why', 'plan', 'prepare', 'compare',
  ].join('|'),
  'i',
)
const LIGHT = /(kello|mikä päivä|monesko|päivämäärä|sää\b|sääti|lämpötila|kiitos|selvä|ok\b|okei|moi|hei\b|huomenta|mitä tapaamisia|tapaamiset (tänään|huomenna)|kenellä on|montako|kuinka monta|näytä putki|putki nyt|mitä kuuluu|lopeta|pysähdy|tauko|äänenvoimakkuus|what time|weather|thanks)/i

/** Palauttaa mallin nimen tälle viestille (null = istunnon oletusmalli). */
// Telegramissa lyhyt viesti on usein jatkokysymys ("entä toinen", "tee se", "ei kun Turusta") tai komento
// koneelle, joka vaatii kontekstin ymmärtämistä → siellä Haiku vain selvään small talkiin / kellonaikaan.
const PHONE_LIGHT = /^(kiitos|kiitti|selvä|ok|okei|moi|hei|huomenta|hyvää yötä|kello|paljonko kello|mikä päivä|monesko päivä|what time)[\s.!?]*$/i

/** Selvät yhden askeleen laitekomennot (ääni, lukitus, koneen ohjelma, projektori päälle/pois) → kevyt malli. Projektorin sovellukset ja
 * navigointi ovat Sonnetilla: Haiku painoi nuolia työkalun sijaan ja väitti onnistuneensa. */
const DEVICE = /(ääni (kovemmalle|hiljemmalle|pienemmälle|isommalle|pois|päälle)|mykistä|tauko|pause|jatka toistoa|lukitse kone|käynnistä itsesi|päivitä itsesi|näyt(tö|öt) (pois|päälle|kiinni)|sammuta näyt(tö|öt)|näyt(tö|öt) (pois|päälle|kiinni)|sammuta näyt(tö|öt)|kuvakaappaus|ota kuva|koneen tila|levytila|avaa (claude|excel|word|chrome|edge|teams|steam|outlook|muistio)|peru sammutus|valot? (päälle|pois)|sammuta valot?|(projektori|telkkari|tv) (päälle|pois|valmiustilaan)|lämmitä (auto|tesla)|auton (tila|lämmitys)|missä auto|lukitse auto|imuroi|imuri(n)? (kotiin|tila|tauko|jatka|pois)|imurointi (pois|päälle))/i
/** Monivaiheinen tai harkintaa vaativa → ei koskaan kevyelle mallille. */
const COMPLEX = /(peli|ohjelma|sovellus|rakenna|päästä|kuluttua|klo \d|ajasta|muistuta|etsi|hae|katso ja|ja sitten|ja laita|laita .+ päälle .*(netflix|youtube|areena|disney)|(netflix|youtube|areena|disney)\w* .+ päälle|elokuva|sarja|jakso|leffa|asenna|asetuks|vaihda|sammuta (kone|tietokone)|(kone|tietokone|pc)[^|]{0,12}uudelleen|lepotila|miksi|miten|mitä jos|ei vaan|ei kun|tarkoitin|puhun|väärä|väärin|en tarkoittanut|\?.*\?)/i
/** Erityisen vaativa ajattelu → isoin malli (Opus). */
const DEEP = /(tee (mulle|minulle) (peli|ohjelma|sovellus|sivu|työkalu)|rakenna|strategi|liiketoimintasuunnitelm|perusteellisesti|syvällisesti|mieti kunnolla|analysoi kaikki|kokonaiskuva|pitkän aikavälin|hinnoittelumalli|rahoitus|sijoittaj)/i
export const DEEP_MODEL = process.env.JARVIS_DEEP_MODEL || 'claude-opus-5'

export function routeModel(text, { defaultModel, phone = false } = {}) {
  if (!ROUTER_ON) return defaultModel
  const t = String(text ?? '').replace(/\[[^\]]*\]/g, ' ').trim() // järjestelmähuomautukset pois
  if (!t) return defaultModel
  if (DEEP.test(t) && process.env.JARVIS_DEEP !== '0') return DEEP_MODEL
  if (t.length < 80 && DEVICE.test(t) && !COMPLEX.test(t)) return FAST_MODEL
  if (phone) return PHONE_LIGHT.test(t) ? FAST_MODEL : defaultModel
  if (t.length > 160) return defaultModel
  if (HEAVY.test(t)) return defaultModel
  if (LIGHT.test(t) || t.length < 40) return FAST_MODEL
  return defaultModel
}

/** Käyttöraja / ylikuorma: kannattaa yrittää samaa uudelleen kevyemmällä mallilla. */
export function isLimitError(msg) {
  const raw = `${msg?.result ?? ''} ${(msg?.errors ?? []).join?.(' ') ?? ''} ${msg?.message ?? ''}`
  return /usage limit|session limit|limit reached|rate.?limit|overloaded|\b529\b|\b429\b|hit your .*limit/i.test(raw)
}

/** Kun raja on kerran osunut, 20 min ajan suoraan kevyelle mallille (ei turhia epäonnistuvia kutsuja). */
let limitedUntil = 0
export const markLimited = (ms = 20 * 60_000) => {
  limitedUntil = Date.now() + ms
}
export const limitActive = () => Date.now() < limitedUntil
