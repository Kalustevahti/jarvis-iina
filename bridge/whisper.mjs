/**
 * Paikallinen puheentunnistus: whisper.cpp:n whisper-server omalla koneella.
 *
 * Selain lähettää bridgen /stt-päätepisteeseen MediaRecorderin tuottamaa
 * webm/opus-ääntä. whisper-server ottaa vastaan 16 kHz mono WAV:ia, joten ääni
 * muunnetaan ensin ffmpeg:llä ja lähetetään sitten palvelimelle. Kaikki tämä
 * tapahtuu koneen sisällä: ääni ei lähde mihinkään verkkoon.
 *
 * Käyttöön ympäristömuuttujalla JARVIS_STT_URL, esim.
 *   JARVIS_STT_URL=http://127.0.0.1:8178/inference
 */
import { spawn } from 'node:child_process'
import process from 'node:process'

export const STT_URL = process.env.JARVIS_STT_URL ?? ''
export const STT_LANGUAGE = process.env.JARVIS_STT_LANGUAGE ?? 'fi'
const FFMPEG = process.env.JARVIS_FFMPEG ?? 'ffmpeg'

export const localSttAvailable = () => Boolean(STT_URL)

/** webm/opus (tai mikä tahansa ffmpeg:n tuntema) -> 16 kHz mono PCM WAV. */
function toWav(input) {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      FFMPEG,
      [
        '-hide_banner', '-loglevel', 'error',
        '-i', 'pipe:0',
        '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav',
        'pipe:1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const out = []
    const err = []
    ff.stdout.on('data', (c) => out.push(c))
    ff.stderr.on('data', (c) => err.push(c))
    ff.on('error', (e) => reject(new Error(`ffmpeg ei käynnisty: ${e.message}`)))
    ff.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`ffmpeg epäonnistui (${code}): ${Buffer.concat(err).toString().trim()}`))
      }
      resolve(Buffer.concat(out))
    })
    ff.stdin.on('error', () => {})
    ff.stdin.end(input)
  })
}

/**
 * Whisper keksii hiljaisuudelle tekstiä — tyypillisesti tekstitysten
 * loppufraaseja. Ne eivät ole käyttäjän puhetta, joten ne pudotetaan.
 */
const HALLUCINATIONS = [
  /^\s*(kiitos|kiitos,? (kun|että) katsoit|kiitos katsomisesta|tilaa kanava|tekstitys.*|tekstitykset.*|subtitles.*|thank you.*|thanks for watching.*)\s*[.!]?\s*$/i,
  /^\s*[.\-–—…♪\s]*$/,
]
export function looksHallucinated(text) {
  return HALLUCINATIONS.some((re) => re.test(text))
}

/** Palauttaa tunnistetun tekstin tai '' jos mitään ei kuultu. */
export async function transcribeLocally(audio, contentType) {
  const t0 = Date.now()
  const wav = contentType?.includes('wav') ? audio : await toWav(audio)
  const t1 = Date.now()
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav')
  form.append('language', STT_LANGUAGE)
  form.append('response_format', 'json')
  form.append('temperature', '0.0')
  form.append('no_timestamps', 'true')
  const res = await fetch(STT_URL, { method: 'POST', body: form })
  if (!res.ok) {
    throw new Error(`whisper-server vastasi ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  const data = await res.json()
  const text = String(data?.text ?? '').replace(/\s+/g, ' ').trim()
  console.log(`[jarvis] whisper ${t1 - t0}ms ffmpeg + ${Date.now() - t1}ms tunnistus (${Math.round(audio.length / 1024)} kB): ${text.slice(0, 80)}`)
  return looksHallucinated(text) ? '' : text
}
