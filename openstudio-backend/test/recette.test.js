'use strict';
/** Recette (APP_ENV=recette) : aucun effet réel possible. */
const test = require('node:test');
const assert = require('node:assert/strict');

test('recette : clé Stripe live refusée, e-mails redirigés, factures simulées', () => {
  const keep = { ...process.env };
  Object.assign(process.env, { APP_ENV: 'recette', STRIPE_SECRET_KEY: 'sk_live_abc', MAIL_ALLOW_REAL_RECIPIENTS: '1', PENNYLANE_API_KEY: 'pl_live', PENNYLANE_RECETTE_ALLOWED: '' });
  delete require.cache[require.resolve('../src/config')];
  const warn = console.warn; console.warn = () => {};
  try {
    const config = require('../src/config');
    assert.equal(config.appEnv, 'recette');
    assert.equal(config.stripe.secretKey, '');
    assert.equal(config.stripe.mock, true);
    assert.equal(config.mail.allowRealRecipients, false);
    assert.equal(config.invoicing.pennylaneKey, '');
    assert.equal(config.invoicing.pennylaneMock, true);
    assert.equal(config.invoicing.provider, 'pennylane');
  } finally {
    console.warn = warn;
    process.env = keep;
    delete require.cache[require.resolve('../src/config')];
  }
});

test('production : réglages inchangés', () => {
  const keep = { ...process.env };
  Object.assign(process.env, { APP_ENV: '', STRIPE_SECRET_KEY: 'sk_live_abc', MAIL_ALLOW_REAL_RECIPIENTS: '1', PENNYLANE_API_KEY: '', PENNYLANE_MOCK: '' });
  delete require.cache[require.resolve('../src/config')];
  try {
    const config = require('../src/config');
    assert.equal(config.appEnv, 'production');
    assert.equal(config.stripe.secretKey, 'sk_live_abc');
    assert.equal(config.mail.allowRealRecipients, true);
    assert.equal(config.invoicing.provider, 'stripe');
  } finally {
    process.env = keep;
    delete require.cache[require.resolve('../src/config')];
  }
});
