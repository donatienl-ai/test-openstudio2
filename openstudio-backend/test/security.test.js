'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyOpusWebhook, signForTest } = require('../src/opusclip/webhook');
const { tokensMatch, newAccessToken } = require('../src/auth');
const { MockPaymentProvider } = require('../src/payment');

const SECRET = 'sk-test-secret';
const body = JSON.stringify({ projectId: 'P1', status: 'COMPLETED' });

test('webhook : signature valide acceptée', async () => {
  const r = await verifyOpusWebhook(Buffer.from(body), signForTest(body, SECRET), SECRET, async () => false);
  assert.equal(r.ok, true);
});

test('webhook : signature invalide refusée', async () => {
  const h = signForTest(body, 'mauvais-secret');
  const r = await verifyOpusWebhook(Buffer.from(body), h, SECRET);
  assert.equal(r.ok, false);
});

test('webhook : corps modifié refusé', async () => {
  const h = signForTest(body, SECRET);
  const r = await verifyOpusWebhook(Buffer.from(body.replace('P1', 'P2')), h, SECRET);
  assert.equal(r.ok, false);
});

test('webhook : signature malformée (longueur différente) refusée sans planter', async () => {
  const h = { ...signForTest(body, SECRET), 'x-opus-signature': 'abc' };
  const r = await verifyOpusWebhook(Buffer.from(body), h, SECRET);
  assert.equal(r.ok, false);
});

test('webhook : horodatage trop ancien refusé', async () => {
  const old = Math.floor(Date.now() / 1000) - 3600;
  const r = await verifyOpusWebhook(Buffer.from(body), signForTest(body, SECRET, 'a1b2c3d4e5f60708', old), SECRET);
  assert.equal(r.ok, false);
  assert.match(r.reason, /horodatage/);
});

test('webhook : rejeu (salt déjà vu) refusé', async () => {
  const seen = new Set();
  const isSeen = async (s) => {
    if (seen.has(s)) return true;
    seen.add(s);
    return false;
  };
  const h = signForTest(body, SECRET);
  assert.equal((await verifyOpusWebhook(Buffer.from(body), h, SECRET, isSeen)).ok, true);
  const again = await verifyOpusWebhook(Buffer.from(body), h, SECRET, isSeen);
  assert.equal(again.ok, false);
  assert.match(again.reason, /rejeu/);
});

test('accès aux téléchargements : jeton d’une autre commande refusé', () => {
  const tokenA = newAccessToken();
  const tokenB = newAccessToken();
  assert.equal(tokensMatch(tokenA, tokenA), true);
  assert.equal(tokensMatch(tokenA, tokenB), false);
  assert.equal(tokensMatch(tokenA, ''), false);
  assert.equal(tokensMatch(tokenA, undefined), false);
});

test('paiement simulé : idempotent (un seul déclenchement)', async () => {
  // Reproduit la garde SQL de orders.markPaid : WHERE status = 'validated' AND payment_status <> 'paid'
  const order = { id: 'o1', status: 'validated', payment_status: 'unpaid' };
  let triggers = 0;
  const provider = new MockPaymentProvider(async (id, ref) => {
    if (order.status !== 'validated' || order.payment_status === 'paid') return null;
    order.status = 'paid';
    order.payment_status = 'paid';
    order.payment_ref = ref;
    triggers += 1;
    return order;
  });
  await provider.startPayment(order);
  await provider.startPayment(order);
  await provider.startPayment(order);
  assert.equal(triggers, 1);
  assert.equal(order.status, 'paid');
});
