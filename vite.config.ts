import { defineConfig, type ProxyOptions } from 'vite'
import react from '@vitejs/plugin-react'

// The face's own port (kaynnista_jarvis.bat sets PORT=5190).
const PORT = Number(process.env.PORT) || 5173

/**
 * True when a /__bridge request comes from the JARVIS page itself: the browser's Origin (and
 * Sec-Fetch-Site) must match the host the page was loaded from. A request without Origin is a plain
 * page load such as <img src> for the camera, which still needs the bridge's own token.
 */
function fromThisPage(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const site = String(req.headers['sec-fetch-site'] ?? '')
  if (site && site !== 'same-origin' && site !== 'none') return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(String(origin)).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

// Kotiverkko (8.11.2026, Eliaksen päätös): sivu näkyy kaikille saman wifin laitteille osoitteessa
// http://<koneen-ip>:5190. JARVIS_LAN=0 palauttaa vanhan "vain tämä kone" -tilan.
const HOST = process.env.JARVIS_LAN === '0' ? 'localhost' : true
// Etäkäyttö MacBookilta Tailscalen HTTPS-osoitteella (tailscale serve → localhost) + kotiverkon nimet.
// IP-osoitteet sallitaan Vitessä aina; nimet vain näistä päätteistä (suoja DNS rebinding -hyökkäystä vastaan).
// .nord = NordVPN Meshnet -nimi (puhelin kodin ulkopuolelta NordVPN päällä).
const ALLOWED_HOSTS = ['.ts.net', '.local', '.lan', '.home', '.nord']

// The bridge listens on localhost:8787 only. Phones on the home wifi reach it through this
// proxy on the face's own port: ws(s)://<host>:5190/__bridge → ws://127.0.0.1:8787/.
// The bridge trusts only local dev origins, so the proxy presents the face's own local origin —
// but ONLY for requests that come from this page itself (same origin). 9.11.2026 security review:
// without that check any website open in a browser on this PC or the LAN could connect to
// ws://<host>:5190/__bridge and get full JARVIS control (screenshots, PC power, browser, CRM).
// The same object serves both the dev server and `vite preview` (production build, 9.11.2026), so the check
// cannot drift between the two.
const PROXY: Record<string, ProxyOptions> = {
  '/__bridge': {
    target: 'http://127.0.0.1:8787',
    ws: true,
    // Bridge serves the camera stream only to Host localhost/127.0.0.1 (DNS-rebinding guard): present that host.
    changeOrigin: true,
    rewrite: (p) => p.replace(/^\/__bridge/, '') || '/',
    headers: { origin: `http://localhost:${PORT}` },
    configure: (proxy) => {
      proxy.on('proxyReqWs', (proxyReq, req, socket) => {
        if (!fromThisPage(req)) {
          console.warn(`[jarvis] __bridge: torjuttu vieras websocket (origin ${req.headers.origin ?? '-'})`)
          proxyReq.destroy()
          socket.destroy()
          return
        }
        proxyReq.setHeader('origin', `http://localhost:${PORT}`)
      })
      proxy.on('proxyReq', (proxyReq, req, res) => {
        if (!fromThisPage(req)) {
          proxyReq.destroy()
          res.writeHead(403, { 'content-type': 'text/plain' })
          res.end('Forbidden')
          return
        }
        proxyReq.setHeader('origin', `http://localhost:${PORT}`)
      })
    },
  },
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Honour PORT so a second instance can run alongside the first. The bridge
    // only accepts sockets from localhost:5173-5199, so stay inside that range
    // or set JARVIS_ALLOWED_ORIGINS to match.
    port: PORT,
    host: HOST,
    allowedHosts: ALLOWED_HOSTS,
    proxy: PROXY,
  },
  // Production serving (scripts/start.mjs → `vite preview` of dist/): same port, hosts and guarded proxy as dev.
  // Set explicitly rather than relying on preview's fallback to the server values.
  preview: {
    port: PORT,
    strictPort: true,
    host: HOST,
    allowedHosts: ALLOWED_HOSTS,
    proxy: PROXY,
  },
  optimizeDeps: {
    // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
    // Vite's dependency pre-bundler rewrites that initialisation and the
    // language table ends up empty — the symptom is
    // `Invalid language identifier: "en". Should be one of: .` at generate()
    // time, long after the model has loaded successfully. Serving these
    // untouched fixes it.
    exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
  },
})
