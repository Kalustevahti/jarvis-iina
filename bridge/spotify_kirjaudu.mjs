/**
 * Spotify-kirjautuminen (PKCE) asennusohjelmalle: node spotify_kirjaudu.mjs CLIENT_ID
 * Avaa selaimen Spotifyn kirjautumiseen (Elias kirjautuu itse), vastaanottaa koodin osoitteessa http://127.0.0.1:8888/callback
 * ja tulostaa VAIN refresh-tokenin stdoutiin (asennusohjelma salaa sen DPAPI:lla). Viestit stderriin.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { exec } from 'node:child_process'

const clientId = process.argv[2]
if (!/^[0-9a-f]{32}$/i.test(String(clientId))) {
  console.error('Client ID puuttuu tai on väärän muotoinen (32 merkkiä).')
  process.exit(2)
}
const REDIRECT = 'http://127.0.0.1:8888/callback'
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing'
const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const verifier = b64url(randomBytes(48))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const state = b64url(randomBytes(12))
const url = `https://accounts.spotify.com/authorize?${new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256', code_challenge: challenge, scope: SCOPES, state })}`

const done = (code, msg) => {
  console.error(msg)
  setTimeout(() => process.exit(code), 300)
}
const timer = setTimeout(() => done(3, 'Aikakatkaisu: kirjautumista ei tehty 5 minuutissa.'), 5 * 60_000)
createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT)
  if (u.pathname !== '/callback') return res.end()
  const send = (t) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>${t}</h2><p>Voit sulkea tämän välilehden.</p></body></html>`)
  }
  if (u.searchParams.get('state') !== state || !u.searchParams.get('code')) {
    send('Kirjautuminen peruttiin tai epäonnistui.')
    return done(4, `Spotify palautti: ${u.searchParams.get('error') ?? 'ei koodia'}`)
  }
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: u.searchParams.get('code'), redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.refresh_token) {
    send('Tokenin haku epäonnistui.')
    return done(5, `Token: ${j.error_description ?? j.error ?? r.status}`)
  }
  send('JARVIS yhdistetty Spotifyyn ✔')
  clearTimeout(timer)
  process.stdout.write(j.refresh_token + '\n')
  setTimeout(() => process.exit(0), 500)
}).listen(8888, '127.0.0.1', () => {
  console.error('Avataan Spotifyn kirjautuminen selaimeen...')
  exec(process.platform === 'win32' ? `start "" "${url}"` : `xdg-open "${url}"`)
})
