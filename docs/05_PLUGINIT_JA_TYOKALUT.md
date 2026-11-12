# 05 – Mitä lisätä Claude-projektiin ja koneelle

Kaikki alla on **ehdotus**: lisää vain mitä tarvitset. Mikään ei ole pakollinen paitsi kohdat 1–2.
Tarkista aina, mitä sinun Claude-tilisi ja -sovelluksesi oikeasti tarjoaa; valikot ja nimet muuttuvat.

## Pakolliset
1. **Claude-tilaus** (Pro tai Max). JARVISin "aivot" ajavat Claude Codea sinun kirjautumisellasi, API-avainta ei tarvita.
2. **Claude Code** (CLI): `npm install -g @anthropic-ai/claude-code`. Tämä on työkalu, jolla rakennat ja korjaat JARVISia.

## Claude-projektiisi (claude.ai)
| Mitä | Miksi |
|---|---|
| **GitHub-liitin / repon lisäys projektin tietoihin** | Projekti-Claude näkee koodin ja voi neuvoa tiedosto tiedostolta. Vaatii pääsyn repoon (Elias lisää sinut). |
| `docs/06_PROJEKTIN_OHJEET.md` projektin ohjeisiin | Antaa Claudelle säännöt: suomeksi, kokonaiset tiedostot, turvaluettelo. |
| `CLAUDE.md` ja `docs/02_MAC_PORTTAUS.md` projektin tiedostoihin | Pysyvä konteksti portaukseen. |
| Muistitoiminto päälle projektissa | Edistyminen säilyy keskustelusta toiseen. |

## Claude Codeen (vapaaehtoiset lisäosat)
- **Versionhallinta-/commit-työkalut** (esim. commit-komennot): siistit commitit kun teet muutoksia.
- **Koodikatselmointi** (code-review / pr-review): ajaa tarkistuksen ennen kuin otat muutoksen käyttöön. Hyödyllinen turvakriittisille muutoksille.
- **Engineering-skillit** (debug, testing-strategy, documentation), jos ne näkyvät kirjastossasi.
- **Chrome-laajennus (Claude in Chrome)**: vain jos haluat Clauden toimivan selaimessasi. JARVIS ei sitä tarvitse.

## Liittimet (vasta myöhemmin, tarpeen mukaan)
- Google Calendar / Gmail: aamukooste, kalenterimuistutukset
- Telegram: ei liitin vaan oma botti (BotFather), ohje `04_PROMPTIT.md` kohta 3
- ElevenLabs (maksullinen, valinnainen): parempi ääni; avain tiedostoon `~/.jarvis`/ympäristömuuttujaan, **ei koskaan repoon**

## Mikä on maksullista
| Palvelu | Hinta | Tarvitaanko |
|---|---|---|
| Claude Pro/Max | tilaus | Kyllä |
| Telegram, ntfy | ilmaisia | Suositus |
| ElevenLabs | tilaus / ilmainen taso | Ei |
| Muut avaimet (Spotify, Tuya, Tesla, TMDB yms.) | vaihtelee | Ei, vain jos haluat kyseiset laitteet |

## Suositeltu minimiasetelma ensimmäiselle viikolle
Claude Code + GitHub-repo projektissa + Telegram-botti. Ei muuta.
