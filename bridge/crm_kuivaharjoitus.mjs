// CRM-siirron kuivaharjoitus (10.11.2026): koko tekoälyarvioiden siirron esikatselu oikeaa CRM:ää vasten, VAIN LUKU.
// Ei CRM-kirjausta, ei kontaktimerkintöjä, ei odottavaa kirjausta eikä listatiedostoa; autoarviot tallentuvat välimuistiin.
// Aja: node bridge\crm_kuivaharjoitus.mjs  (tulostaa määrät ja esikatselun)
import { draftContactImport } from './crm.mjs'
import { contactsForCrm } from './yhteydet.mjs'

const total = contactsForCrm({ max: Infinity, arviot: true }).length
console.log(`kelvollisia: ${total}`)
const t0 = Date.now()
let shown = -1
const d = await draftContactImport({
  arviot: true,
  dryRun: true,
  progress: (phase, done) => {
    if (Math.floor(done / 25) !== shown || done === total) console.log(`  ${phase} ${done}`)
    shown = Math.floor(done / 25)
  },
})
console.log(`kesto ${Math.round((Date.now() - t0) / 1000)} s`)
console.log(JSON.stringify(d.counts ?? { tyhja: d.text }, null, 1))
console.log(`--- esikatselu ---\n${d.preview ?? d.text}`)
process.exit(0)
