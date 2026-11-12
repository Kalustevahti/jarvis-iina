/**
 * Filler speech.
 *
 * A tool call can take ten seconds, and silence that long reads as a crash. So
 * JARVIS says something the instant work starts — then goes quiet until he has
 * an answer. One acknowledgement, no progress chatter.
 *
 * The phrasing follows the character's actual grammar rather than generic
 * assistant-speak, which matters more than it sounds:
 *
 *   - Working lines are subjectless present participles: "Compiling.",
 *     "Cross-referencing." Not "I'm now checking" and never "let me".
 *   - There is no snap-to compliance formula. "Right away" and "At once" are
 *     not in his vocabulary; acknowledgement is deferential, not eager.
 *   - No filler words, no enthusiasm, no apology, no exclamation marks.
 *   - "Sir" fronted means urgency; final means routine. These are all routine,
 *     so it goes at the end, and only sometimes.
 */

/** Said as soon as the first tool fires, before any answer exists. */
const WORKING = [
  'Hetkinen, katson tämän. Haen tiedot ja kerron heti, mitä löytyy.',
  'Selvitän asian. Tässä menee pieni hetki, johtaja.',
  'Haen tiedot. Kerron heti, kun ne ovat kasassa.',
  'Tarkistan tämän puolestasi. Hetki vain.',
  'Katsotaan, mitä löytyy. Palaan asiaan ihan kohta.',
]

/** Said when the answer itself is slow to start and no tool has fired yet. */
const THINKING = [
  'Hetkinen, mietin tätä.',
  'Katsotaan. Hetki vain, johtaja.',
  'Hetki, kootaan vastaus.',
  'Pieni hetki.',
]

/** Acknowledging an order where no tool is involved. */
const ACKNOWLEDGE = [
  'Selvä, johtaja.',
  'Hoidetaan.',
  'Onnistuu.',
  'Selvä.',
  'Tehdään, johtaja.',
  'Hyvä on.',
]

/** Answering to his name, before the user has said what they want. */
const ATTENTION = [
  'Niin, johtaja?',
  'Johtaja?',
  'Kuuntelen.',
  'Täällä, johtaja.',
  'Palveluksessasi.',
]

/**
 * Avoids repeating the same phrase twice running, which is what makes canned
 * lines sound canned. Keeps one slot of history per pool.
 */
function makePicker(pool: string[]) {
  let last = -1
  return () => {
    if (pool.length < 2) return pool[0] ?? ''
    let i = last
    while (i === last) i = Math.floor(Math.random() * pool.length)
    last = i
    return pool[i]
  }
}

export const working = makePicker(WORKING)
export const acknowledge = makePicker(ACKNOWLEDGE)
export const attention = makePicker(ATTENTION)
export const thinking = makePicker(THINKING)

/**
 * Heti kysymyksen jälkeen sanottava repliikki, joka peittää odotuksen ja
 * kertoo, että asia on jo työn alla. Valitaan kysymyksen sanoista, jotta se
 * kuulostaa vastaukselta eikä yleiseltä täytteeltä. Aivot hakevat tietoa
 * samaan aikaan taustalla.
 */
const LEAD_IN: { match: RegExp; lines: string[] }[] = [
  { match: /\bkello|paljonko aika|mitä aika|monelta/i, lines: ['Katson, mitä kello on.', 'Hetki, katson kellon.'] },
  { match: /sää|lämpötila|sataa|tuulee|pakkas|ennuste/i, lines: ['Katson sään.', 'Tarkistan sääennusteen.'] },
  { match: /uutis|tapahtu.*maailma|otsiko/i, lines: ['Katson uutiset.', 'Haen tuoreimmat uutiset.'] },
  { match: /(lähetä|laita|tekstaa|ilmoita|kirjoita).{0,30}(viesti|puhelim|tekstari|mulle|minulle)|puhelimeen/i, lines: ['Lähetän puhelimeen.', 'Laitan viestin.'] },
  { match: /sähköposti|meili|posti|viesti/i, lines: ['Katson postin.', 'Tarkistan viestit.'] },
  { match: /kalenteri|tapaamis|palaveri|aikataulu/i, lines: ['Katson kalenterin.', 'Tarkistan aikataulun.'] },
  { match: /\bavaa\b|käynnistä|mene sivulle/i, lines: ['Avaan sen.', 'Hetki, avaan.'] },
  { match: /kuva|piirrä|renderöi/i, lines: ['Katsotaan kuvaa.', 'Hetki, kuva-asia työn alla.'] },
  { match: /\blaske|montako|kuinka paljon|yhteensä|prosentti/i, lines: ['Lasken.', 'Hetki, lasken tämän.'] },
  { match: /käännä|englanniksi|suomeksi|ruotsiksi/i, lines: ['Käännän.', 'Hetki, käännän sen.'] },
  { match: /hae|etsi|googlaa|selvitä|tarkista|löydä|kuka on|mikä on|missä on|milloin/i, lines: ['Haen tiedot.', 'Selvitän.', 'Katson, mitä löytyy.'] },
]
const leadPickers = LEAD_IN.map((r) => ({ ...r, pick: makePicker(r.lines) }))

export function leadIn(said: string): string {
  for (const r of leadPickers) if (r.match.test(said)) return r.pick()
  return thinking()
}

/**
 * Naming the task is warmer than a generic acknowledgement and shows the
 * integration off on camera. Still participial, still under five words.
 *
 * MCP tool names are `mcp__<server>__<tool>`, and the two halves say different
 * things: the server is who is being asked, the tool is what is being asked
 * for. Matching one flat substring against the whole string gets both wrong —
 * `mcp__playwright__browser_click` announced a web search because "browse"
 * appeared earlier in the table than "browser", `Get-Report` looked like a code
 * repository, `Get-Events` like a calendar entry, and "highlight" like a lamp.
 *
 * So: split the name, match the halves separately, order the table so the
 * specific beats the general, and put word boundaries on the short words that
 * hide inside longer ones. Either half matching is enough — the server is the
 * better signal when a name gives one, but plenty of them don't.
 */
type Rule = {
  /** Matched against the server segment, if there is one. */
  server?: RegExp
  /** Matched against the tool segment, or the whole name for a built-in. */
  tool?: RegExp
  lines: string[]
}

const FOOTAGE = ['Teen videota.', 'Teen kuvaa.']

const BY_TOOL: Rule[] = [
  // Video sits above image because higgsfield and palmier both do either, so
  // the verb in the tool name is the only thing separating them — a rule on the
  // server alone would send every generate_video to "Rendering."
  { tool: /video|footage|\bclip\b|\breel\b|talking_head/, lines: FOOTAGE },
  {
    server: /higgsfield|openrouter-image|dalle|flux|midjourney/,
    tool: /image|photo|thumbnail|render|upscale|seedream/,
    lines: ['Teen kuvaa.', 'Piirrän.'],
  },
  // The editors, once the two rules that read the verb have had their turn.
  { server: /palmier|heygen|runway|descript/, lines: FOOTAGE },
  {
    server: /playwright|puppeteer|browserbase|chrome/,
    tool: /\bbrowser\b|navigate/,
    lines: ['Avaan selaimen.', 'Siirryn.'],
  },
  {
    server: /android|\badb\b|simulator/,
    tool: /\bdevice\b|\bapk\b|\bphone\b/,
    lines: ['Yhdistän laitteeseen.', 'Yhdistän puhelimeen.'],
  },
  {
    server: /gmail|\bmail\b/,
    tool: /gmail|\bmail\b|email|inbox/,
    lines: ['Tarkistan postin.', 'Katson saapuneet.'],
  },
  // Calendar keys off "calendar" alone. "event" used to live here, which is how
  // a Mixpanel event query came out as "Checking your calendar."
  {
    tool: /calendar|\bdiary\b|\bmeeting\b/,
    lines: ['Tarkistan kalenterin.', 'Katson kalenteria.'],
  },
  {
    server: /elevenlabs|openai-tts/,
    tool: /speech|\bvoice\b|\btts\b|text_to_sound/,
    lines: ['Teen äänen.', 'Hetkinen, katson tämän. Haen tiedot ja kerron heti, mitä löytyy.'],
  },
  {
    server: /spotify|sonos/,
    tool: /\bplay\b|\bmusic\b|playlist|\btrack\b/,
    lines: ['Laitan jonoon.', 'Laitan soimaan.'],
  },
  {
    server: /^home|homeassistant|\bhue\b|\bhass\b/,
    tool: /\blights?\b|thermostat|\bdimmer\b/,
    lines: ['Säädän.', 'Hoidan sen, johtaja.'],
  },
  {
    server: /github|linear|jira|sentry/,
    tool: /\brepo\b|repository|\bissues?\b|pull_request|\bcommit\b/,
    lines: ['Tarkistan repon.', 'Katson tehtävät.'],
  },
  // Also where the anonymously named analytics servers land — theirs are bare
  // UUIDs, so only the tool half says anything: Get-Report, Get-Events,
  // Run-Query. "report" is safe from the repository rule above because that one
  // is bounded.
  {
    server: /mixpanel|clarity|posthog|amplitude/,
    tool: /analytic|\bmetrics?\b|\breports?\b|\bevents?\b|cohort|funnel|dashboard|\bquery\b/,
    lines: ['Ajan kyselyn.', 'Haen luvut.'],
  },
  {
    server: /\bexa\b|serper|serpapi|perplexity|tavily|brave/,
    tool: /search|\bweb\b|\bfetch\b|crawl|research/,
    lines: ['Etsin.', 'Haen tiedot.'],
  },
]

const pickers = BY_TOOL.map((r) => ({ ...r, pick: makePicker(r.lines) }))

/**
 * `mcp__<server>__<tool>`, split on the first separator so tool names keep
 * their own underscores (`browser_click`, `text_to_speech`). A built-in like
 * WebSearch or Bash has no server half.
 *
 * The second form matters more than it looks: the bridge client prettifies
 * names for the HUD badge before handing them on, so what actually arrives
 * here is `higgsfield · generate image`. Parsing only the raw form meant every
 * rule below silently missed and every tool got the generic line.
 */
function split(toolName: string): { server: string; tool: string } {
  const raw = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (raw) return { server: raw[1].toLowerCase(), tool: raw[2].toLowerCase() }

  const pretty = toolName.split(' · ')
  if (pretty.length === 2) {
    return { server: pretty[0].toLowerCase(), tool: pretty[1].toLowerCase() }
  }

  return { server: '', tool: toolName.toLowerCase() }
}

/** A phrase suited to the tool that just fired. */
export function forTool(toolName: string): string {
  const { server, tool } = split(toolName)
  for (const r of pickers) {
    const hit =
      (r.server !== undefined && server !== '' && r.server.test(server)) ||
      (r.tool !== undefined && r.tool.test(tool))
    if (hit) return r.pick()
  }
  // Read, Bash, Grep and anything unrecognised: better a neutral line than a
  // confident wrong one.
  return working()
}
