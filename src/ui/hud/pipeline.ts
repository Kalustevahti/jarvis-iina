/**
 * LIIDIT money math on the bridge's read-only CRM snapshot (crm.mjs pipelineDetail). Value per company, most
 * reliable first: its offer (price + fleet) → CRM fleet estimate × PRICE_PER_CAR_EUR (marked as an estimate) → unknown.
 */
import { PRICE_PER_CAR_EUR } from '../../config'

export type PipeOrg = { id: string; name: string; stage: string; city: string; fleet: number | null; owner: string | null }
export type PipeOffer = { id: string; org: string; orgName: string; seller: string | null; status: string; cents: number | null; fleet: number | null; at: string | null }
export type Pipe = { stages: Array<{ key: string; label: string }>; orgs: PipeOrg[]; offers: PipeOffer[]; people: Record<string, string> }

export type Value = { cars: number | null; eur: number | null; est: boolean }

/** Stages that are no longer open deals. */
export const CLOSED = new Set(['customer', 'lost', 'inactive', 'archived'])
/** Open stages furthest along first (the list shows the hottest deals on top). */
const HEAT = ['decision_pending', 'offered', 'meeting_booked', 'prospect', 'lead']

const nf = new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 0 })
export const eur = (n: number) => `${nf.format(Math.round(n))} €`

/** The offer that best describes the deal: newest not rejected, else the newest. Offers arrive newest first. */
export function offerFor(offers: PipeOffer[]): PipeOffer | null {
  return offers.find((o) => o.status !== 'rejected' && o.status !== 'expired' && o.cents) ?? offers.find((o) => o.cents) ?? null
}

export function valueOf(org: PipeOrg, offer: PipeOffer | null): Value {
  if (offer?.cents) return { cars: offer.fleet ?? org.fleet, eur: offer.cents / 100, est: false }
  if (org.fleet) return { cars: org.fleet, eur: org.fleet * PRICE_PER_CAR_EUR, est: true }
  return { cars: null, eur: null, est: false }
}

export function valueText(v: Value): string {
  if (v.eur == null) return 'Autot ei tiedossa'
  if (v.est) return `~${v.cars} autoa · ~${eur(v.eur)}/kk · arvio`
  return `${v.cars ? `${v.cars} autoa · ` : ''}${eur(v.eur)}/kk`
}

export type Row = { org: PipeOrg; offer: PipeOffer | null; value: Value; seller: string | null }
export type Sum = { n: number; eur: number; est: boolean; unknown: number }

const add = (s: Sum, r: Row) => {
  s.n++
  if (r.value.eur == null) s.unknown++
  else {
    s.eur += r.value.eur
    if (r.value.est) s.est = true
  }
}
const zero = (): Sum => ({ n: 0, eur: 0, est: false, unknown: 0 })

/** Joins offers to companies and decides each company's seller (owner, else the seller of its offer). */
export function rows(p: Pipe): Row[] {
  const byOrg = new Map<string, PipeOffer[]>()
  for (const o of p.offers) byOrg.set(o.org, [...(byOrg.get(o.org) ?? []), o])
  return p.orgs.map((org) => {
    const offs = byOrg.get(org.id) ?? []
    const offer = offerFor(offs)
    return { org, offer, value: valueOf(org, offer), seller: org.owner ?? offer?.seller ?? offs[0]?.seller ?? null }
  })
}

/** Sellers that own a company or have an offer, with their open-lead count, most leads first. */
export function sellers(p: Pipe, all: Row[]): Array<{ id: string; name: string; open: number }> {
  const ids = new Set<string>()
  all.forEach((r) => r.seller && ids.add(r.seller))
  p.offers.forEach((o) => o.seller && ids.add(o.seller))
  return [...ids]
    .map((id) => ({ id, name: p.people[id] ?? 'tuntematon', open: all.filter((r) => r.seller === id && !CLOSED.has(r.org.stage)).length }))
    .sort((a, b) => b.open - a.open || a.name.localeCompare(b.name, 'fi'))
}

/** Per-stage sums in CRM order (inactive/archived only when present) plus the open total. */
export function summarize(p: Pipe, list: Row[]) {
  const by = new Map<string, Sum>()
  const open = zero()
  for (const r of list) {
    const s = by.get(r.org.stage) ?? zero()
    add(s, r)
    by.set(r.org.stage, s)
    if (!CLOSED.has(r.org.stage)) add(open, r)
  }
  const known = new Set(p.stages.map((s) => s.key))
  const stages = [...p.stages, ...[...by.keys()].filter((k) => !known.has(k)).map((k) => ({ key: k, label: k.replace(/_/g, ' ') || '—' }))]
    .filter((s) => (s.key === 'inactive' || s.key === 'archived' || !known.has(s.key) ? by.has(s.key) : true))
    .map((s) => ({ ...s, sum: by.get(s.key) ?? zero() }))
  return { stages, open }
}

export const heat = (stage: string) => {
  const i = HEAT.indexOf(stage)
  return i < 0 ? HEAT.length : i
}

export const firstName = (n: string) => n.split(' ')[0] || n
