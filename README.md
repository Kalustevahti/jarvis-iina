# JARVIS – perusversio Iinalle (Mac)

Henkilökohtainen puheavustaja, joka pyörii omalla koneellasi ja jota ohjataan myös puhelimesta (Telegram).
Tämä on Eliaksen JARVISin **siivottu perusversio** ("kopio ilman muistia ja avaimia"): koko koodi on mukana,
mutta mitään henkilökohtaista dataa, avaimia tai muistitiedostoja ei ole. Rakennat siitä oman versiosi.

> **Tila:** Koodi on kehitetty ja testattu Windowsilla. **Macilla sitä ei ole vielä ajettu**: osa toiminnoista
> (koneen ohjaus) on kirjoitettu Windowsin PowerShellillä ja pitää portata. Muistutukset ja Telegram-ohjaus
> ovat alustariippumattomia ja toimivat todennäköisesti sellaisenaan.

## Mitä tällä saa

| Toiminto | Mac-tilanne |
|---|---|
| Puhe- ja tekstikeskustelu (holografinen käyttöliittymä selaimessa) | Toimii todennäköisesti heti |
| Muistutukset ("muistuta 30 min päästä soitosta") | Toimii, vaatii Telegramin tai ntfy:n ilmoituksille |
| Ohjaus puhelimesta Telegram-botilla | Toimii, vaatii oman botin (BotFather) |
| Koneen ohjaus puhelimesta (lukitse, kuvakaappaus, avaa ohjelma, virta) | **Pitää portata** → `docs/02_MAC_PORTTAUS.md` |
| Äänet: selaimen oma puhe (ilmainen) tai ElevenLabs (valinnainen, maksullinen) | Toimii |

## Pikastartti (Mac)

Tarvitset: Claude-tilauksen (Pro/Max), jonka kautta Claude Code kirjautuu. Muuta maksullista ei tarvita aluksi.

```bash
# 1. Työkalut (Terminal)
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node git
npm install -g @anthropic-ai/claude-code
claude            # kirjaudu Claude-tililläsi, poistu komennolla /exit

# 2. Lataa koodi (sinulla pitää olla pääsy repoon)
git clone https://github.com/Kalustevahti/jarvis-iina.git ~/JARVIS
cd ~/JARVIS
npm install
npm run setup     # tarkistaa koneen, ei muuta mitään

# 3. Käynnistä (vain lukuoikeudet: JARVIS katsoo mutta ei tee mitään)
npm start
# Avaa selaimessa http://localhost:5190  (portti tulostuu terminaaliin)
```

Oikeat toiminnot päälle vasta kun testit onnistuvat: `npm start -- --writes`.

## Ensimmäiset askeleet (tässä järjestyksessä)

1. **Käynnistä ja juttele.** Jos tämä toimii, perusta on kunnossa.
2. **Avaa Claude Code kansiossa** (`cd ~/JARVIS && claude`) ja anna sille prompti 1 tiedostosta `docs/04_PROMPTIT.md` (personalisointi).
3. **Telegram-botti** (prompti 3): muistutukset ja ohjaus puhelimelta.
4. **Mac-portaus** (prompti 4): lukitus, kuvakaappaus, ohjelmien avaus, virta.
5. Vasta sitten muut moduulit (kalenteri, posti, kamerat yms.) yksi kerrallaan.

## Dokumentit

- `docs/01_ALOITUS_MAC.md` – tarkempi asennus ja yleisimmät ongelmat
- `docs/02_MAC_PORTTAUS.md` – mitä on Windows-only ja miten portataan
- `docs/03_PERSONALISOINTI.md` – nimet, persoona ja Elias-kohtaiset moduulit pois/sinun mukaasi
- `docs/04_PROMPTIT.md` – valmiit promptit Claude Codelle ja Claude-projektillesi
- `docs/05_PLUGINIT_JA_TYOKALUT.md` – mitä pluginit, skillit ja liittimet kannattaa lisätä
- `docs/06_PROJEKTIN_OHJEET.md` – liitettävä ohjeteksti sinun Claude-projektiisi
- `CLAUDE.md` – ohje Claude Codelle: arkkitehtuuri ja säännöt

## Turva (lue ennen kuin otat toiminnot käyttöön)

- Salaisuudet (Telegram-token, API-avaimet) ovat **repon ulkopuolella**: `~/.jarvis/`. Älä koskaan tallenna niitä repoon.
- Botti vastaa vain **sinun** Telegram-chat-id:llesi. Tarkista tämä (`bridge/telegram.mjs`) ennen kuin laitat koneen ohjauksen päälle.
- Pidä `--writes` pois päältä, kunnes olet testannut. Sammutus vaatii aina erillisen vahvistuksen.
- Älä tee repoa julkiseksi: koodissa on edelleen Eliaksen työkalujen nimiä ja logiikkaa.
- Macilla `~/.jarvis`-tiedostot tallentuvat selkotekstinä (Windowsin DPAPI-suojaus puuttuu). Aja `chmod 700 ~/.jarvis`.

## Lisenssi ja alkuperä

MIT. Pohjana avoimen lähdekoodin J.A.R.V.I.S.-projekti (adewaskar/jarvis), jonka päälle Elias on rakentanut suomenkielisen version.
Alkuperäinen README: `docs/README.upstream.en.md`.
