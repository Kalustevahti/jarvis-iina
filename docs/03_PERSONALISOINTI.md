# 03 – Personalisointi: tee tästä oma JARVIS

Koodi on siivottu avaimista, muistitiedostoista, puhelinnumeroista ja kolmansien henkilöiden nimistä.
**Mutta persoona ja liiketoimintalogiikka on edelleen Eliaksen:** järjestelmäpromptissa (`bridge/server.mjs`) ja monessa moduulissa
JARVIS puhuu "Eliaksesta", "Iinasta" ja "KalustoVahdista". Tämä ei ole salaisuus, mutta JARVIS käyttäytyisi kuin se palvelisi Eliasta.
Tee seuraavat ennen kuin käytät oikeasti.

## Mitä on vaihdettu valmiiksi
- Kolmansien henkilöiden nimet (myyjät, asiakasesimerkit testeissä) → yleisiä paikkamerkkejä ("Myyjä1", "Testi Yritys A")
- Omistajan oletusnimi CRM-asetuksissa → "Käyttäjä Nimi"
- Ei muistitiedostoja (`muisti/`), ei `~/.jarvis`-asetuksia, ei lokeja

## Mitä sinun pitää päättää
1. **Omistajan nimi.** Elias esiintyy satojissa kohdissa (järjestelmäprompti, ilmoitukset, muistiin kirjoitus). Pyydä Claude Codea korvaamaan se nimelläsi (taivutus!: Eliaksen→Iinan, Eliakselle→Iinalle, Elias→Iina) ja ajamaan tarkistus (prompti 1).
2. **Työ-/yritysmoduulit.** Nämä on rakennettu KalustoVahdin myyntiin (CRM, liidit, kontaktirekisteri, myyntioppi, harjoituspuhelu, ryhmäneuvoja). Valitse:
   - *Pidä*, jos käytät samaa CRM:ää (Supabase-yhteys ja tunnukset kysytään sinulta; ne eivät ole repossa), tai
   - *Poista käytöstä*, jos haluat vain henkilökohtaisen avustajan. Pyydä Claude Codea kytkemään ne pois `server.mjs`:stä siististi (ei tiedostojen poistoa, vain rekisteröinnin pois).
   Moduulit: `crm.mjs`, `liidikone.mjs`, `neuvoja.mjs`, `ryhma.mjs`, `kotisivu.mjs`, `yhteydet.mjs`, `myyntimuisti.mjs`, `puuttuvat.mjs`, `menetetyt.mjs`, `harjoitus.mjs`, `kokous.mjs`, `teams.mjs`.
3. **Elias-kohtaiset laitteet.** Tesla, XGIMI-projektori, Tuya-valot, kamerat, Roborock-imuri, IR-kaukosäädin, Samsung-telkkari, ZTE-modeemi (oletus-IP 192.168.32.1). Ne eivät tee mitään, ellei `~/.jarvis/`-asetuksia ole; jätä ne rauhaan tai kytke pois.
4. **Persoona.** Järjestelmäprompti on suomeksi ja kuvaa tyylin. Muokkaa tyyli itsellesi: puhuttelu, tiiviys, huumori, mitä saa tehdä itsenäisesti ja mikä vaatii vahvistuksen.
5. **Hinnat ja luvut.** `src/config.ts`: `PRICE_PER_CAR_EUR` on KalustoVahdin hinta. Tarkista tai poista.

## Rajat, joita et poista
- Vahvistus ennen sammutusta, viestien lähetystä ja CRM-kirjauksia
- Telegram-botin omistajatarkistus (vain sinun chat-id)
- `--writes`-lippu pois päältä oletuksena

## Tarkistus muutosten jälkeen
```bash
grep -rniE "elias|petriotis" bridge src | head      # pitäisi olla tyhjä tai harkittu
for f in bridge/*.mjs scripts/*.mjs; do node --check "$f" || echo "VIRHE $f"; done
npm run build                                       # TypeScript + Vite
```
