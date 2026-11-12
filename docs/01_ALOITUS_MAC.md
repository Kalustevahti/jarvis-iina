# 01 – Aloitus Macilla

## Vaatimukset
- macOS, Terminal (Finder → Ohjelmat → Apuohjelmat → Terminal)
- Node.js 20 tai uudempi (`node -v`), git, Homebrew
- Claude Code asennettuna ja kirjautuneena (`claude --version`)
- Chrome tai Safari (puheentunnistus selaimessa; Chrome on varmin)

## Asennus
Katso pikastartti `README.md`:stä. Tiivistettynä: `npm install` → `npm run setup` → `npm start`.

## Portit
- Käyttöliittymä: näkyy `npm start` -tulosteessa (oletus 5190).
- Silta (bridge, "aivot"): `127.0.0.1:8787`. Älä avaa tätä ulos internetiin.

## Mikrofoni ja oikeudet
- Selain kysyy mikrofonin käyttöoikeuden. Salli.
- Jos koneen ohjausta portataan: System Settings → Privacy & Security → **Screen Recording**, **Accessibility** ja **Automation** Terminalille (tai sille ohjelmalle, jolla JARVIS ajetaan).

## Yleisimmät ongelmat
| Oire | Syy / korjaus |
|---|---|
| Käyttöliittymä aukeaa mutta ei vastaa | Silta ei käynnissä tai Origin-esto. Katso terminaalin tuloste; käynnistä `npm start` (ei erikseen `npm run dev`). |
| `claude` ei löydy | `npm install -g @anthropic-ai/claude-code`, avaa Terminal uudelleen |
| Ääntä ei kuulu | Selain estää automaattisen äänen: klikkaa sivua kerran |
| Moduuli kaatuu "Vain Windows-koneella" | Odotettu: kyseinen toiminto pitää portata (`02_MAC_PORTTAUS.md`) |
| `npm install` valittaa Node-versiosta | `brew upgrade node` |

## Pysyvä käynnistys (myöhemmin)
Kun kaikki toimii, JARVIS voi käynnistyä kirjautuessa **launchd LaunchAgentilla** (`~/Library/LaunchAgents/`). Pyydä Claude Codea tekemään se (prompti 6).
Älä tee tätä ennen kuin Telegramin omistajatarkistus on varmistettu.
