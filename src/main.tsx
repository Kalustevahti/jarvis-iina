import { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { PinGate } from './ui/PinGate'

// Kokousikkuna (?mini=1) käyttää vanhaa tyylitiedostoa, työpöytä omaansa.
// Ei molempia: vanhan HUD-tyylin koko sivun peitto (scanlines) ei saa tulla työpöydän päälle.
const mini = new URLSearchParams(window.location.search).get('mini') === '1'
const css = mini ? import('./index.css') : import('./ui/desk.css')
if (!mini) document.title = 'JARVIS'

// Nopeus (9.11.2026): the PIN screen is in the first, small bundle; the app itself downloads in parallel while the
// device token / PIN is checked, so it is usually ready by the time the gate opens.
const appModule = import('./App.tsx')
const App = lazy(() => appModule)

// Deliberately no StrictMode: its double-invoked effects would open the
// microphone and arm the wake-word engine twice, and the second subscription
// steals the audio stream from the first.
// PIN (9.11.2026): nothing but the PIN screen until the bridge has accepted this device.
void css.finally(() =>
  createRoot(document.getElementById('root')!).render(
    <PinGate>
      <Suspense fallback={<div className="pg-root" aria-busy="true" />}>
        <App />
      </Suspense>
    </PinGate>,
  ),
)
