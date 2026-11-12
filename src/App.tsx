import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { Desk } from './ui/Desk'
import { startVoice, type Voice, type VoiceMode } from './lib/voice'
import { createSpeaker, cycleVoice, currentVoiceName } from './lib/tts'
import * as sfx from './lib/sfx'
import * as camera from './lib/camera'

/** Taustamusiikki ja 3D-intro on poistettu: kevyt näkymä. Kutsut jäävät no-opeiksi. */
const music = {
  working: (_on: boolean) => {},
  duck: (_on: boolean) => {},
}

/** Puhe päällä/pois (muistetaan selaimessa). */
const SPEAK_KEY = 'jarvis.puhe'
const readSpeak = () => {
  try {
    return localStorage.getItem(SPEAK_KEY) !== '0'
  } catch {
    return true
  }
}

/** Hiljainen "puhuja", kun ääni on pois: sama rajapinta, ei ääntä. */
const muteSpeaker = (): ReturnType<typeof createSpeaker> =>
  ({
    say: () => {},
    push: () => {},
    end: () => Promise.resolve(),
    cancel: () => {},
    level: () => 0,
  }) as unknown as ReturnType<typeof createSpeaker>
import { forTool, attention, leadIn } from './lib/fillers'
import {
  ask,
  warm,
  newConversation,
  request,
  interrupt,
  watchServers,
  watchPanels,
  watchBlades,
  watchCapture,
  watchUi,
  watchConnection,
  connectedLabels,
  usingBridge,
  sendMeeting,
  type Msg,
} from './lib/brain'
import { startAnalyser, micLevel } from './lib/audio'
import { attachSystemAudio, detachSystemAudio, systemAudioAttached } from './lib/vad'
import { MiniMeeting } from './ui/MiniMeeting'

/** ?mini=1: pieni vinkki-ikkuna ilman 3D-näkymää. Luetaan kerran sivun latautuessa. */
const MINI = (() => {
  try {
    const on = new URLSearchParams(window.location.search).get('mini') === '1'
    if (on) document.title = 'JARVIS vinkit'
    return on
  } catch {
    return false
  }
})()
import { probeCapabilities } from './lib/capabilities'

/**
 * The conversation.
 *
 * This used to be a sequential loop — greet, await a capture, await an answer,
 * repeat — with the microphone opened and closed around each step. That shape
 * cannot be interrupted: while it is awaiting the answer, nothing is listening,
 * so there is no way for the user to get a word in.
 *
 * It is an event machine now. The voice loop runs continuously and pushes
 * events at us; every one of them is legal in every phase. Saying anything at
 * all stops him talking, and whatever you say next becomes the new turn.
 */

/** How long to wait for someone to start speaking after he wakes. Generous:
 *  people say his name and *then* think about what they wanted. */
const AWAIT_SPEECH_MS = 14000

/** After an answer, how long the mic stays open for a follow-up before he
 *  drops back to standby. Long enough that you don't have to say the name
 *  again to continue a thought. */
const FOLLOW_UP_MS = 8000
/** Kokoustilassa mikrofoni pysyy auki käytännössä rajattomasti. */
const MEETING_WINDOW_MS = 12 * 60 * 60 * 1000
/** Harjoituspuhelussa myyjä saa miettiä vastaustaan ilman herätyssanaa. */
const PRACTICE_WINDOW_MS = 90 * 1000
const PRACTICE_START = 'Aloitetaan harjoituspuhelu: esitä asiakasta, minä myyn.'
/** Index after the last user turn: captions/feedback start from what JARVIS says next. */
const afterLastUser = (turns: { role: string }[]) => {
  let i = turns.length - 1
  while (i >= 0 && turns[i].role !== 'user') i--
  return i + 1
}

/** crypto.randomUUID needs a secure context, which a LAN address over plain
 *  http is not. Not worth failing a whole turn over an id. */
const newId = () =>
  globalThis.crypto?.randomUUID?.() ??
  `id${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`

/** The same mishearings voice.ts accepts for the wake word — otherwise a turn
 *  that woke him as "travis" gets that word sent on to the model as a question. */
const NAME = '(?:jarvis|jarvys|jervis|travis|jarviss|java\'s|jarv)'
/** A bare vocative — "Jarvis", "hey jarvis" — with nothing asked. */
const BARE_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}[\\s,.!?]*$`, 'i')
/** A leading vocative on a real command: "Jarvis, what's the weather". */
const LEADING_NAME = new RegExp(`^(?:hey|hi|ok|okay|yo)?\\s*${NAME}\\b[\\s,.:!?-]*`, 'i')

export default function App() {
  const store = useStore
  const history = useRef<Msg[]>([])
  const speaker = useRef<ReturnType<typeof createSpeaker> | null>(null)
  const voice = useRef<Voice | null>(null)

  /**
   * Monotonic turn counter. Every await in a turn checks it on the way out:
   * if it has moved, that turn was superseded by a barge-in and must not touch
   * the phase, the speaker, or the busy state on its way to the floor.
   */
  const turn = useRef(0)
  const booting = useRef(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const voicePoll = useRef<ReturnType<typeof setInterval> | null>(null)

  // -- helpers --------------------------------------------------------------

  const clearIdle = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = null
  }

  const silence = () => {
    speaker.current?.cancel()
    speaker.current = null
  }

  const goDormant = () => {
    clearIdle()
    silence()
    turn.current++
    const s = store.getState()
    s.setCaption('')
    s.setActiveTool(null)
    music.working(false)
    music.duck(false)
    sfx.duck(false)
    s.setPhase('dormant')
  }

  /** Open the mic and wait. `window` is how long before he gives up. */
  /** Kokoustila päällä: puhe menee litteraattiin eikä herätyssanaa tarvita. */
  const meeting = useRef(false)
  /** Harjoituspuhelu käynnissä (bridge: ui op 'practice'). */
  const practice = useRef(false)
  /** ?harjoitus=1: puhelunäkymä aloittaa harjoituspuhelun heti, kun mikrofoni on päällä. */
  const pendingPractice = useRef(false)
  /** ?kokous=<kuvaus> osoitteessa: kokoustila käynnistyy heti käynnistyksen jälkeen. */
  const pendingMeeting = useRef<string | null>(null)

  const listen = (window: number) => {
    if (meeting.current) window = MEETING_WINDOW_MS
    else if (practice.current) window = Math.max(window, PRACTICE_WINDOW_MS)
    clearIdle()
    const s = store.getState()
    s.setCaption('')
    s.setPhase('listening')
    // Kokoustilassa ja harjoituspuhelussa ei merkkiääntä joka lauseen jälkeen.
    if (!meeting.current && !practice.current) sfx.play('listen')
    idleTimer.current = setTimeout(goDormant, window)
  }

  // -- one turn -------------------------------------------------------------

  /** Puhe sallittu: kytkin päällä ja ääni avattu käyttäjän eleellä. */
  const [speakOn, setSpeakOnState] = useState(readSpeak)
  const speakRef = useRef(speakOn)
  const audioReady = useRef(false)
  const voiceOn = useRef(false)
  const [voiceReady, setVoiceReady] = useState(false)
  const setSpeakOn = (on: boolean) => {
    speakRef.current = on
    setSpeakOnState(on)
    try {
      localStorage.setItem(SPEAK_KEY, on ? '1' : '0')
    } catch {
      /* ei tallennusta */
    }
    if (!on) silence()
  }
  const canSpeak = () => speakRef.current && audioReady.current && !meeting.current

  const respond = async (said: string, opts: { typed?: boolean; before?: Promise<unknown> } = {}): Promise<void> => {
    const typed = Boolean(opts.typed)
    const mine = ++turn.current
    const stale = () => mine !== turn.current

    clearIdle()
    const s = store.getState()
    // Last turn's panels and blades go now, before the new answer starts
    // putting its own up. Anything the model marked sticky survives.
    s.clearPanels()
    s.clearBlades()
    s.setCaption('')
    s.pushTurn({ id: newId(), role: 'user', text: said })
    s.setPhase('thinking')
    // The message and "thinking" are on screen first; only then wait (briefly) for audio to unlock (9.11.2026).
    if (opts.before) {
      await Promise.race([opts.before.catch(() => {}), new Promise((r) => setTimeout(r, 1500))])
      if (stale()) return
    }

    const spk = canSpeak() ? createSpeaker() : muteSpeaker()
    speaker.current = spk
    sfx.duck(true)
    music.duck(true)

    const turnId = newId()
    let started = false
    let filled = false

    // Suomiversio: heti kysymyksen jälkeen JARVIS sanoo kysymykseen sopivan
    // lyhyen repliikin ("Katson, mitä kello on.") samalla, kun aivot jo
    // työstävät vastausta taustalla. Puhe peittää odotuksen eikä viivytä
    // hakua. Pieni viive vain siksi, ettei salamannopea vastaus saa turhaa
    // täytettä eteensä.
    const LEAD_IN_MS = 350
    const thinkTimer = setTimeout(() => {
      // Harjoituspuhelussa ei täytelauseita ("Katson…"): asiakas ei puhu niin.
      if (stale() || started || filled || meeting.current || typed || practice.current) return
      filled = true
      spk.say(leadIn(said))
    }, LEAD_IN_MS)

    try {
      const { text } = await ask(said, history.current, {
        onText: (delta) => {
          if (stale()) return
          if (!started) {
            started = true
            clearTimeout(thinkTimer)
            store.getState().setPhase('speaking')
            // The answer arriving is what ends the tool phase — a timer would
            // clear the readout while a slow tool was still running.
            store.getState().setActiveTool(null)
            music.working(false)
            store.getState().pushTurn({ id: turnId, role: 'jarvis', text: '' })
          }
          store.getState().appendToLastTurn(delta)
          // Kokoustilassa JARVIS ei puhu: vastaus näkyy vain tekstinä.
          if (!meeting.current) spk.push(delta)
        },
        onTool: (name) => {
          if (stale()) return
          // Only claim the tooling phase while he has nothing to say yet.
          // Setting it unconditionally pinned the machine in 'tooling' for the
          // rest of any answer that called a tool after it started talking,
          // which also broke the reactor's lip-sync for the remainder.
          if (!started) store.getState().setPhase('tooling')
          store.getState().setActiveTool(name)
          if (!practice.current) sfx.play('tool')
          music.working(true)
          // Say something the moment work starts — a tool can take ten seconds
          // and silence that long reads as a crash. Once per turn only; a
          // chain of five tools shouldn't produce five apologies.
          if (!filled && !started && !meeting.current && !practice.current) {
            filled = true
            spk.say(forTool(name))
          }
        },
      }, { mode: typed ? 'text' : 'voice' })

      if (stale()) return

      // The bridge keeps conversation state in its own session, so history is
      // only threaded through on the direct path.
      if (!usingBridge) {
        history.current.push({ role: 'user', content: said })
        history.current.push({ role: 'assistant', content: text || '…' })
        if (history.current.length > 16) {
          history.current = history.current.slice(-16)
        }
      }

      await spk.end()
      if (stale()) return
      if (!practice.current) sfx.play('done')
    } catch (err) {
      if (stale()) return
      console.error(err)
      sfx.play('error')
      store
        .getState()
        .setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      clearTimeout(thinkTimer)
      if (!stale()) {
        speaker.current = null
        sfx.duck(false)
        music.duck(false)
        store.getState().setActiveTool(null)
        music.working(false)
        // Stay open. Having to say his name again to add one more sentence is
        // the difference between a conversation and a vending machine.
        // Kirjoitettu viesti ilman avattua mikkiä: ei kuuntelua.
        // Harjoituspuhelu aloitettu napista (kirjoitettu): puhelu jatkuu silti puheella.
        if (voiceOn.current && (!typed || practice.current)) listen(FOLLOW_UP_MS)
        else store.getState().setPhase('dormant')
      }
    }
  }

  // -- voice events ---------------------------------------------------------

  /** What the voice loop should do with what it hears, derived from phase. */
  const mode = (): VoiceMode => {
    switch (store.getState().phase) {
      case 'offline':
      case 'boot':
        return 'deaf'
      case 'dormant':
        return 'wake'
      case 'waking':
      case 'listening':
        return 'command'
      default:
        return 'guard' // thinking, tooling, speaking
    }
  }

  const onWake = (trailing: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot') return

    store.getState().setError(null)
    sfx.play('wake')

    // "Jarvis, what's happening in AI this week" in one breath. Waiting for a
    // greeting he didn't need is the most common way an assistant wastes time.
    if (trailing) {
      void respond(trailing)
      return
    }

    store.getState().setPhase('waking')

    // Answer to his name. Deliberately NOT awaited any more: the microphone is
    // already open and the echo filter knows his voice, so the user can talk
    // straight over the greeting instead of waiting it out.
    const greeting = createSpeaker()
    speaker.current = greeting
    greeting.say(attention())
    void greeting.end()

    listen(AWAIT_SPEECH_MS)
  }

  /**
   * Someone started talking. This is the whole point of the rewrite: he stops,
   * immediately, whatever he was doing.
   */
  const onSpeechStart = () => {
    clearIdle()
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    const wasBusy =
      phase === 'thinking' || phase === 'tooling' || phase === 'speaking'

    silence()
    if (wasBusy) {
      // Abandon the answer in flight. The turn counter moves in respond()'s
      // replacement; bumping it here covers the case where nothing replaces it.
      turn.current++
      interrupt()
      store.getState().setActiveTool(null)
      music.working(false)
      sfx.duck(false)
      music.duck(false)
    }
    store.getState().setPhase('listening')
  }

  const onUtterance = (text: string) => {
    const phase = store.getState().phase
    if (phase === 'offline' || phase === 'boot' || phase === 'dormant') return

    // People keep using his name as a vocative once they're already talking to
    // him. Strip it rather than sending "jarvis" to the model as a question.
    if (BARE_NAME.test(text)) {
      listen(AWAIT_SPEECH_MS)
      return
    }
    // Kokoustila: ilman nimeä sanottu menee litteraattiin, ei JARVISille.
    if (meeting.current && !LEADING_NAME.test(text)) {
      sendMeeting(text)
      listen(MEETING_WINDOW_MS)
      return
    }

    const said = text.replace(LEADING_NAME, '').trim()
    if (!said) {
      listen(AWAIT_SPEECH_MS)
      return
    }

    void respond(said)
  }

  const onPartial = (text: string) => {
    store.getState().setCaption(text)
  }

  const onVoiceError = (message: string) => {
    store.getState().setError(message)
  }

  // -- power on -------------------------------------------------------------

  /** Puhelun ääni (Teams kuulokkeissa) JARVISille: K-näppäin tai vinkki-ikkunan painike. */
  const [sysAudio, setSysAudio] = useState(false)
  const shareCallAudio = () => {
    store.getState().setError(null)
    void attachSystemAudio()
      .then((msg) => {
        store.getState().setCaption(msg)
        setSysAudio(systemAudioAttached())
      })
      .catch((err: Error) => {
        setSysAudio(false)
        store.getState().setError(
          err?.name === 'NotAllowedError'
            ? 'Jako peruttiin. Yritä uudelleen ja valitse "Koko näyttö" + "Jaa järjestelmän ääni".'
            : `Äänen jako epäonnistui: ${err?.message ?? err}`,
        )
      })
  }

  const brainStarted = useRef(false)

  /**
   * Aivot (bridge) heti sivun auetessa — ei introa, ei klikkausta. Chat toimii tästä hetkestä.
   */
  const initBrain = () => {
    if (brainStarted.current) return
    brainStarted.current = true
    const s = store.getState()
    watchServers((servers) => store.getState().setConnected(servers))
    watchPanels((panel) => store.getState().pushPanel(panel))
    watchBlades((blade) => store.getState().pushBlade(blade))

    // JARVIS pyytää kameraa (näkötyökalu). Ilmoitetaan aina näytöllä.
    watchCapture(async (req) => {
      const note =
        req.mode === 'watch'
          ? req.when === 'past'
            ? req.reason || 'katson viime sekunnit'
            : `${req.reason || 'katson'} · ${req.seconds}s`
          : req.reason || 'katson'
      store.getState().setLooking(note)
      if (req.mode === 'watch' && req.when === 'past' && camera.bufferedSeconds() < 1) {
        store.getState().setLooking(null)
        return { error: 'There is no recent footage — the camera has to be open on screen for me to remember what just happened.' }
      }
      let held = false
      try {
        await camera.holdCamera()
        held = true
        if (req.mode === 'look') return camera.grabFrame()
        if (req.when === 'past') {
          const grid = camera.recentGrid(req.seconds, 9)
          return grid ?? { error: 'There is not enough recent footage to review.' }
        }
        return await camera.watchAhead(req.seconds, 9)
      } catch (err) {
        return {
          error:
            (err as DOMException)?.name === 'NotAllowedError'
              ? 'The camera is not permitted, so I cannot see anything.'
              : `The camera could not be read: ${(err as Error)?.message ?? err}`,
        }
      } finally {
        if (held) camera.releaseCamera()
        store.getState().setLooking(null)
      }
    })

    watchUi((op, args) => {
      const s = store.getState()
      const a = (args ?? {}) as Record<string, unknown>
      switch (op) {
        case 'screen':
          s.clearScreen((a.what as 'all' | 'panels' | 'transcript') ?? 'all')
          break
        case 'meeting': {
          const on = Boolean(a.on)
          // Päänäkymä ei kuuntele kokousta: kulmaikkuna (?mini=1) hoitaa mikrofonin, ettei puhe tallennu kahdesti.
          if (!MINI) {
            if (on && voiceOn.current) {
              voice.current?.stop()
              voice.current = null
              voiceOn.current = false
              setVoiceReady(false)
              goDormant()
            }
            break
          }
          meeting.current = on
          if (on) {
            if (voiceOn.current) listen(MEETING_WINDOW_MS)
            s.setCaption('Kokoustila päällä. Jos puhelu on kuulokkeissa, paina "Jaa puhelun ääni".')
          } else {
            detachSystemAudio()
            setSysAudio(false)
            if (voiceOn.current) listen(FOLLOW_UP_MS)
          }
          break
        }
        case 'practice': {
          practice.current = Boolean(a.on)
          const prev = s.practice
          s.setPractice(
            practice.current
              ? { on: true, name: String(a.name ?? ''), company: String(a.company ?? ''), startedAt: Number(a.startedAt ?? Date.now()), from: afterLastUser(s.turns) }
              : prev
                ? { ...prev, on: false, ended: Boolean(a.ended), endFrom: afterLastUser(s.turns) }
                : null,
          )
          if (practice.current) s.setCaption(voiceOn.current ? 'Harjoituspuhelu käynnissä — puhu suoraan, lopetus: "lopeta harjoitus".' : 'Harjoituspuhelu käynnissä — käynnistä mikrofoni ja puhu asiakkaalle.')
          else if (voiceOn.current && s.phase === 'listening') listen(FOLLOW_UP_MS)
          break
        }
        case 'announce': {
          const text = String(a.text ?? '')
          const phase = s.phase
          const busy = phase === 'thinking' || phase === 'tooling' || phase === 'speaking'
          if (!text || busy || meeting.current) break
          s.pushTurn({ id: newId(), role: 'jarvis', text })
          if (!canSpeak()) break
          const ann = createSpeaker()
          speaker.current = ann
          ann.say(text)
          void ann.end().then(() => {
            if (speaker.current === ann) speaker.current = null
            if (voiceOn.current) listen(FOLLOW_UP_MS)
          })
          break
        }
        case 'tg': {
          // Yhteinen keskustelu: Telegramissa käyty viestipari näkyy myös täällä.
          const at = String(a.at ?? new Date().toISOString())
          s.pushTurn({ id: newId(), role: 'user', text: String(a.user ?? ''), channel: 'telegram', at })
          s.pushTurn({ id: newId(), role: 'jarvis', text: String(a.jarvis ?? ''), channel: 'telegram', at })
          break
        }
        default:
          // Vanhan 3D-näkymän komennot (väri, kiertoradat, efektit) ohitetaan kevyessä näkymässä.
          break
      }
    })
    watchConnection((state) => {
      if (state === 'lost') store.getState().setError('Yhteys JARVISiin katkesi — yhdistetään uudelleen.')
      else if (state === 'reconnected') {
        store.getState().setError(null)
        // Pages refresh their data on reconnect too (device states may have changed while JARVIS restarted).
        window.dispatchEvent(new Event('jarvis-connected'))
      }
    })
    s.setPhase('dormant')
    const connected = () => {
      store.getState().setConnected(connectedLabels())
      store.getState().setError(null)
      window.dispatchEvent(new Event('jarvis-connected'))
      // Yhteinen keskustelu: viimeisimmät viestit (sovellus + Telegram) näkyviin.
      if (!MINI)
        void request<Array<{ at: string; channel: 'telegram' | 'sovellus' | 'tyo'; user: string; jarvis: string }>>('historia')
          .then((rows) => {
            if (store.getState().turns.length || !Array.isArray(rows)) return
            const turns = rows.flatMap((r, i) => [
              { id: `h${i}u`, role: 'user' as const, text: r.user, channel: r.channel, at: r.at },
              { id: `h${i}j`, role: 'jarvis' as const, text: r.jarvis, channel: r.channel, at: r.at },
            ])
            useStore.setState({ turns })
          })
          .catch(() => {})
    }
    // JARVIS voi vielä käynnistyä (sovellus avattiin kuvakkeesta): yritetään 3 s välein 2 min ajan.
    let tries = 0
    const attempt = () => {
      void warm()
        .then(connected)
        .catch((err: Error) => {
          tries++
          if (tries < 40) {
            store.getState().setError('Yhdistetään JARVISiin…')
            setTimeout(attempt, 3000)
          } else store.getState().setError(`JARVIS ei vastaa (${err.message}). Käynnistä se uudelleen: tyokalut\\kaynnista_uudelleen.bat`)
        })
    }
    attempt()
  }

  /** Ääni: vaatii käyttäjän eleen (klikkaus / näppäin), koska selain avaa äänen vain silloin. */
  const unlockAudio = async () => {
    if (audioReady.current) return
    await sfx.unlockAudio()
    await probeCapabilities()
    audioReady.current = true
  }

  const initVoice = async () => {
    if (booting.current || voiceOn.current) return
    booting.current = true
    try {
      initBrain()
      await unlockAudio()
      try {
        await startAnalyser()
      } catch {
        console.warn('[jarvis] mikrofonin tasomittari ei käytössä')
      }
      voice.current = await startVoice({ mode, onWake, onSpeechStart, onPartial, onUtterance, onError: onVoiceError })
      voiceOn.current = true
      setVoiceReady(true)
      store.getState().setVoice(currentVoiceName())
      store.getState().setPhase('dormant')
      // Kokous oli jo käynnissä, kun ikkuna avautui: kuunnellaan heti.
      if (meeting.current) listen(MEETING_WINDOW_MS)
      const wanted = pendingMeeting.current
      pendingMeeting.current = null
      if (wanted) setTimeout(() => void respond(`Aloita kokous. ${wanted}`), 500)
      if (pendingPractice.current) {
        pendingPractice.current = false
        setSpeakOn(true)
        setTimeout(() => void respond(PRACTICE_START), 600)
      }
    } catch (err) {
      console.error('[jarvis] mikrofoni ei käynnistynyt:', err)
      store.getState().setError(
        (err as DOMException)?.name === 'NotAllowedError'
          ? 'Mikrofonin käyttö estetty. Salli mikrofoni selaimen osoiterivin lukosta.'
          : `Mikrofoni ei käynnistynyt: ${(err as Error)?.message ?? err}`,
      )
    } finally {
      booting.current = false
    }
  }

  /** Puhelunäkymän "Soita": ääni ja mikki päälle (napin painallus = selaimen vaatima ele) ja puhelu alkaa. */
  const onPracticeStart = async () => {
    pendingPractice.current = false // ?harjoitus=1 ei saa aloittaa toista puhelua samaan aikaan
    initBrain()
    await unlockAudio().catch(() => {})
    await initVoice()
    setSpeakOn(true)
    void respond(PRACTICE_START)
  }
  /** Puhelunäkymän napit (Lopeta, Aikalisä): kuin olisi sanottu ääneen. */
  const onPracticeSay = (text: string) => {
    initBrain()
    void respond(text)
  }

  /** Vanha nimi: kokousikkuna (?mini=1) ja pikakäynnistys kutsuvat tätä. */
  const powerOn = async () => {
    initBrain()
    await initVoice()
  }

  /** Mikki-nappi: käynnistää äänen ensimmäisellä kerralla, sitten kuuntelee yhden komennon. */
  const onMic = async () => {
    if (!voiceOn.current) await initVoice()
    if (!voiceOn.current) return
    const phase = store.getState().phase
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
      onSpeechStart()
      listen(AWAIT_SPEECH_MS)
    } else if (phase === 'listening' || phase === 'waking') {
      goDormant()
    } else {
      onWake('')
    }
  }

  /** Chat: kirjoitettu viesti. */
  const onSend = async (text: string) => {
    const t = text.trim()
    if (!t) return
    initBrain()
    // Enter/klikkaus on käyttäjän ele: ääni voidaan avata, jos puhe on päällä. Ei odoteta ennen viestin näyttämistä.
    const before = speakRef.current && !audioReady.current ? unlockAudio() : undefined
    void respond(t, { typed: true, before })
  }

  const onNewChat = async () => {
    goDormant()
    interrupt()
    store.getState().clearScreen('all')
    await newConversation().catch(() => {})
    store.getState().setPhase('dormant')
  }

  const onStop = () => {
    const phase = store.getState().phase
    if (phase === 'thinking' || phase === 'tooling' || phase === 'speaking') {
      turn.current++
      interrupt()
    }
    goDormant()
  }

  // -- level pump + keys ----------------------------------------------------

  useEffect(() => {
    let raf = 0
    // Ei introa: yhteys JARVISiin heti, chat on käytössä saman tien.
    initBrain()

    const pump = () => {
      const st = store.getState()
      // While speaking, follow JARVIS's own output rather than the mic, so the
      // orb lip-syncs instead of reacting to room noise.
      const lvl =
        st.phase === 'speaking' && speaker.current
          ? speaker.current.level()
          : micLevel()
      st.setLevel(lvl)
      raf = requestAnimationFrame(pump)
    }
    pump()

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return

      // V auditions the next British voice installed on this machine. Which
      // ones exist varies per Mac, so hearing them beats trusting a ranking.
      // Bare V only — ⌘V and ⌃V are paste, and swallowing those was rude.
      if (
        e.key === 'v' &&
        !e.repeat &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        e.preventDefault()
        const name = cycleVoice()
        store.getState().setVoice(name)
        silence()
        const demo = createSpeaker()
        speaker.current = demo
        demo.say(`Ääni vaihdettu: ${name.replace(/\(.*?\)/g, '').trim()}. Palveluksessasi, johtaja.`)
        void demo.end()
        return
      }

      // K jakaa järjestelmän äänen (Teams kuulokkeissa) JARVISille. Vaatii
      // näppäinpainalluksen, koska selain näyttää jakovalinnan vain käyttäjän
      // omasta toimesta.
      if (e.key === 'k' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        shareCallAudio()
        return
      }

      // T speaks a fixed line, bypassing the wake word, the recogniser and the
      // model entirely. When "I can't hear him" is the report, this is the one
      // keypress that separates a broken voice engine from a broken voice loop
      // — and it prints the verdict rather than making you infer it.
      if (e.key === 't' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        silence()
        const t = createSpeaker()
        speaker.current = t
        t.say('Äänitesti. Jos kuulet tämän, puhe toimii, johtaja.')
        void t.end().then(() => {
          const d = (window as unknown as Record<string, Record<string, unknown>>).__tts
          console.info('[jarvis] audio test →', d)
          if (d && d.started === 0 && d.rescued === 0) {
            store.getState().setError(
              `No sound produced. engine=${d.engine} voice=${d.voice} error=${d.lastError || 'none'}`,
            )
          }
        })
        return
      }

      // Escape stands the whole thing down — the one thing the old build had
      // no key for at all.
      if (e.key === 'Escape') {
        e.preventDefault()
        onStop()
        return
      }

      // Space starts a turn without the wake word. Worth using while filming so
      // a missed wake word doesn't cost a take.
      if (e.code !== 'Space' || e.repeat) return
      e.preventDefault()

      void onMic()
    }
    window.addEventListener('keydown', onKey)

    // Pikakäynnistys: kokous.bat tai Telegram-komento avaa sivun osoitteella
    // ?kokous=<kuvaus>&auto=1. Kuvaus talteen ja virta päälle ilman klikkausta
    // (ikkuna avataan autoplay-luvalla, mikrofonin lupa on profiilissa tallessa).
    try {
      const q = new URLSearchParams(window.location.search)
      if (q.get('harjoitus') === '1') {
        pendingPractice.current = true
        window.history.replaceState(null, '', window.location.pathname)
      }
      const wanted = q.get('kokous')?.trim()
      if (wanted) {
        pendingMeeting.current = wanted
        window.history.replaceState(null, '', window.location.pathname)
      }
      // auto=1: kokousikkuna käynnistää mikrofonin itse (kokous voi olla jo aloitettu sovelluksesta).
      if (q.get('auto') === '1') setTimeout(() => void powerOn(), 300)
    } catch {
      /* ei parametria */
    }

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('keydown', onKey)
      clearIdle()
      if (voicePoll.current) clearInterval(voicePoll.current)
      voice.current?.stop()
      speaker.current?.cancel()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (MINI) return <MiniMeeting onStart={() => void powerOn()} onAudio={shareCallAudio} audioOn={sysAudio} />

  return (
    <Desk
      onSend={(t) => void onSend(t)}
      onMic={() => void onMic()}
      onStop={onStop}
      onNewChat={() => void onNewChat()}
      onShareAudio={shareCallAudio}
      audioShared={sysAudio}
      speakOn={speakOn}
      onSpeak={setSpeakOn}
      voiceReady={voiceReady}
      onPracticeStart={() => void onPracticeStart()}
      onPracticeSay={onPracticeSay}
    />
  )
}
