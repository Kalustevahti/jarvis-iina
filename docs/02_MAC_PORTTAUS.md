# 02 – Mac-portaus

JARVIS on kirjoitettu Windowsille. Tämä lista kertoo mitä pitää tehdä, jotta koneen ohjaus toimii Macilla.
Portaus tehdään **Claude Codella** tässä repossa (prompti 4 tiedostossa `04_PROMPTIT.md`), pienissä paloissa ja testaten.

## Mikä toimii sellaisenaan (alustariippumaton)
- Käyttöliittymä (`src/`), silta (`bridge/server.mjs`), Telegram (`telegram.mjs`), ntfy (`puhelin.mjs`)
- Ajastimet ja muistutukset (`ajastin.mjs`, tallentuu `~/.jarvis/ajastimet.json`)
- Turvakerros (`turva.mjs`), muisti (`muisti.mjs`)

## Mikä on Windows-only ja mihin Mac-vastine
| Toiminto | Tiedosto | Windowsissa | Macilla |
|---|---|---|---|
| Näytön lukitus | `bridge/kone.mjs` | Win+L | `pmset displaysleepnow` tai `osascript` + Ctrl+Cmd+Q |
| Kuvakaappaus | `bridge/ps/kuva.ps1` | .NET / PowerShell | `screencapture -x /tmp/x.png` |
| Näyttö pois/päälle, kirkkaus | `bridge/ps/naytto.ps1`, `naytto.mjs` | Win32 | `pmset displaysleepnow`, `caffeinate` |
| Hiiri/näppäimistö | `bridge/ps/ohjaus.ps1` | Win32 SendInput | `cliclick` (brew) tai `osascript` |
| Ikkunan fokus | `bridge/ps/fokus.ps1` | Win32 | `osascript -e 'tell application "X" to activate'` |
| Ohjelman avaus | `kone.mjs` | `start` | `open -a "Ohjelma"` / `open URL` |
| Sammutus / lepotila | `kone.mjs` | `shutdown` | `osascript -e 'tell app "System Events" to shut down'`, `pmset sleepnow` |
| Salaisuuksien suojaus | `spotify.mjs`, `valot.mjs`, `tesla.mjs`, `leffat.mjs` | DPAPI | Macilla tallentuu selkotekstinä → siirrä Keychainiin (`security add-generic-password`) |
| Työkaluajo | `tyokaluajo.mjs` | `.bat` | shell-skriptit `.sh` |
| Automaattinen käynnistys | – | Task Scheduler | launchd LaunchAgent |
| zip-purku | `tuonti.mjs` | PowerShell | `unzip` |

Kaikissa on rakenne `process.platform === 'win32'` -tarkistuksia; lisää haara `darwin` samoihin kohtiin.

## Portausjärjestys (suositus)
1. **Vain luku**: `kone_tila`, `kone_kuvakaappaus` (turvallisin, näet heti toimiiko).
2. `kone_avaa` (sallittujen ohjelmien lista!) ja `kone_lukitse`.
3. Näyttö ja äänenvoimakkuus.
4. **Viimeisenä** virta (sammutus/lepotila). Säilytä esikatselu + vahvistus + 60 s peruutusaika sellaisenaan.
5. Hiiren ja näppäimistön ohjaus vain jos tarvitset. Se on riskialtein.

## Säännöt portauksessa
- Komennot pysyvät **kiinteinä** (ei vapaata komentoriviä mallille). Älä lisää "aja mikä tahansa komento" -työkalua.
- Jokainen uusi komento: lisää testi `bridge/jarvis.test.mjs`-tyyliin.
- Käyttöoikeudet (Screen Recording, Accessibility) pyydetään vasta kun toiminto tarvitsee ne.
- Testaa jokainen vaihe käsin puhelimesta (Telegram) ennen seuraavaa.
