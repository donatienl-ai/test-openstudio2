'use strict';
/**
 * Catalogue Stripe des recharges de crédits : un produit par pack, avec son prix TTC actuel.
 * À chaque modification des tarifs dans le back-office, le catalogue est mis à jour :
 * produit créé ou renommé, nouveau prix créé si le montant change (l'ancien est archivé),
 * pack retiré = produit archivé. Les identifiants sont conservés par mode (test / production).
 */
const config = require('../config');
const db = require('../db');

const mode = () => (config.stripe.secretKey.startsWith('sk_live') || config.stripe.secretKey.startsWith('rk_live') ? 'live' : 'test');
const key = () => `stripe_catalog_${mode()}`;
const ttcCents = (priceHT) => Math.round(priceHT * 100 * (1 + config.stripe.vatRate));

async function load() {
  const { rows } = await db.query('SELECT value FROM app_settings WHERE key = $1', [key()]);
  if (!rows[0]) return {};
  return typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
}

async function store(catalog) {
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key(), JSON.stringify(catalog)]
  );
}

/** Identifiant du prix Stripe d'un pack, s'il correspond bien au montant demandé. */
async function priceFor(packId, amountTtcCents) {
  if (config.stripe.mock) return null;
  try {
    const e = (await load())[packId];
    return e && e.active !== false && e.price && e.amount === amountTtcCents ? e.price : null;
  } catch {
    return null;
  }
}

/**
 * Met le catalogue Stripe en accord avec les packs. Ne bloque jamais l'enregistrement des tarifs :
 * renvoie { ok, mode, changes[], error? }. Sans clé Stripe : rien à faire.
 */
async function sync(packs, { stripe = require('../montage/stripe') } = {}) {
  if (config.stripe.mock) return { ok: true, skipped: 'Stripe non configuré (paiements simulés).', changes: [] };
  const req = stripe.stripeRequest;
  const catalog = await load();
  const changes = [];
  try {
    for (const p of packs) {
      const name = `Recharge OpenStudio — ${p.label} (${p.credits.toLocaleString('fr-FR')} crédits)`;
      const amount = ttcCents(p.priceHT);
      let e = catalog[p.id];
      if (!e || !e.product) {
        const prod = await req('POST', '/products', { name, metadata: { openstudio_pack_id: p.id, credits: p.credits } });
        e = catalog[p.id] = { product: prod.id };
        changes.push(`produit créé : ${p.label}`);
      } else if (e.name !== name || e.active === false) {
        await req('POST', `/products/${e.product}`, { name, active: 'true', metadata: { openstudio_pack_id: p.id, credits: p.credits } });
        changes.push(e.active === false ? `produit réactivé : ${p.label}` : `produit renommé : ${p.label}`);
      }
      if (!e.price || e.amount !== amount) {
        const price = await req('POST', '/prices', {
          product: e.product, currency: 'eur', unit_amount: amount,
          nickname: `${p.priceHT} € HT`, metadata: { openstudio_pack_id: p.id, prix_ht: p.priceHT },
        });
        await req('POST', `/products/${e.product}`, { default_price: price.id });
        if (e.price) await req('POST', `/prices/${e.price}`, { active: 'false' }).catch(() => null);
        changes.push(`${p.label} : ${(amount / 100).toFixed(2).replace('.', ',')} € TTC`);
        e.price = price.id;
        e.amount = amount;
      }
      e.name = name;
      e.active = true;
      await store(catalog); // conservé au fil de l'eau : une erreur plus loin ne fait rien perdre
    }
    for (const [id, e] of Object.entries(catalog)) {
      if (packs.some((p) => p.id === id) || e.active === false) continue;
      await req('POST', `/products/${e.product}`, { active: 'false' });
      e.active = false;
      changes.push(`produit archivé : ${id}`);
      await store(catalog);
    }
    return { ok: true, mode: mode(), changes };
  } catch (err) {
    console.error('[tarifs] Stripe :', err.message);
    return { ok: false, mode: mode(), changes, error: err.message };
  }
}

module.exports = { sync, priceFor, ttcCents, mode };
