'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, passwordProblem } = require('../src/admin/password');
const totp = require('../src/admin/totp');
const secretbox = require('../src/admin/secretbox');
const { AttemptLimiter } = require('../src/admin/limiter');

/* ---------------------------------------------------------------- Mots de passe */

test('mot de passe : le bon est accepté, un autre refusé', async () => {
  const h = await hashPassword('OpenStudio2027!');
  assert.match(h, /^scrypt\$/);
  assert.equal(await verifyPassword('OpenStudio2027!', h), true);
  assert.equal(await verifyPassword('openstudio2027!', h), false);
});

test('mot de passe : deux hachages du même mot de passe diffèrent (sel aléatoire)', async () => {
  assert.notEqual(await hashPassword('OpenStudio2027!'), await hashPassword('OpenStudio2027!'));
});

test('mot de passe : un hachage malformé est refusé sans planter', async () => {
  assert.equal(await verifyPassword('x', 'pas-un-hash'), false);
  assert.equal(await verifyPassword('x', 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA'), false);
  assert.equal(await verifyPassword(undefined, 'scrypt$1$1$1$a$b'), false);
});

test('mot de passe : 9 caractères minimum, au moins une lettre et un chiffre', () => {
  assert.ok(passwordProblem('1234567a'), '8 caractères : trop court');
  assert.ok(passwordProblem('seulementdeslettres'));
  assert.ok(passwordProblem('123456789'), 'que des chiffres');
  assert.equal(passwordProblem('12345678a'), null, '8 chiffres + 1 lettre');
  assert.equal(passwordProblem('Montage-BFM-2027'), null);
});

/* ---------------------------------------------------------------- Double authentification */

// Vecteurs officiels de la RFC 6238 (SHA-1), tronqués à 6 chiffres
const RFC_SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));
const RFC = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
];

test('code à 6 chiffres : vecteurs de la RFC 6238', () => {
  for (const [t, code] of RFC) assert.equal(totp.codeAt(RFC_SECRET, t * 1000), code, `t=${t}`);
});

test('base32 : aller-retour', () => {
  const buf = Buffer.from('OpenMedias-OpenStudio');
  assert.deepEqual(totp.base32Decode(totp.base32Encode(buf)), buf);
});

test('code : accepté à ±30 s, refusé au-delà', () => {
  const secret = totp.newSecret();
  const now = 1_800_000_000_000;
  assert.notEqual(totp.verifyCode(secret, totp.codeAt(secret, now), { timeMs: now }), null);
  assert.notEqual(totp.verifyCode(secret, totp.codeAt(secret, now - 30_000), { timeMs: now }), null);
  assert.equal(totp.verifyCode(secret, totp.codeAt(secret, now - 120_000), { timeMs: now }), null);
});

test('code : un code déjà utilisé ne sert pas deux fois', () => {
  const secret = totp.newSecret();
  const now = 1_800_000_000_000;
  const code = totp.codeAt(secret, now);
  const counter = totp.verifyCode(secret, code, { timeMs: now });
  assert.notEqual(counter, null);
  assert.equal(totp.verifyCode(secret, code, { timeMs: now, lastCounter: counter }), null);
});

test('code : formats invalides refusés', () => {
  const secret = totp.newSecret();
  for (const bad of ['', '12345', '1234567', 'abcdef', null, undefined]) {
    assert.equal(totp.verifyCode(secret, bad), null);
  }
  assert.notEqual(totp.verifyCode(secret, totp.codeAt(secret).replace(/(\d{3})/, '$1 ')), null, 'espace toléré');
});

test('lien otpauth : contient le secret et le nom du service', () => {
  const uri = totp.otpauthUri('ABCDEF', 'moi@openmedias.fr');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /secret=ABCDEF/);
  assert.match(uri, /issuer=OpenStudio%20admin/);
});

/* ---------------------------------------------------------------- Chiffrement des secrets */

const KEY = 'une-cle-de-test-suffisamment-longue-0123456789';

test('chiffrement : aller-retour', () => {
  const sealed = secretbox.seal('JBSWY3DPEHPK3PXP', KEY);
  assert.notEqual(sealed, 'JBSWY3DPEHPK3PXP');
  assert.equal(secretbox.open(sealed, KEY), 'JBSWY3DPEHPK3PXP');
});

test('chiffrement : mauvaise clé ou contenu modifié refusés', () => {
  const sealed = secretbox.seal('JBSWY3DPEHPK3PXP', KEY);
  assert.throws(() => secretbox.open(sealed, `${KEY}x`));
  const parts = sealed.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => secretbox.open(parts.join('.'), KEY));
});

test('chiffrement : clé absente ou trop courte refusée', () => {
  assert.throws(() => secretbox.seal('x', ''), /ADMIN_ENCRYPTION_KEY/);
  assert.throws(() => secretbox.seal('x', 'courte'), /ADMIN_ENCRYPTION_KEY/);
});

/* ---------------------------------------------------------------- Limitation des tentatives */

test('limite : bloque au-delà du maximum puis se libère après la fenêtre', () => {
  let t = 0;
  const l = new AttemptLimiter({ max: 3, windowMs: 1000, now: () => t });
  assert.equal(l.hit('ip'), true);
  assert.equal(l.hit('ip'), true);
  assert.equal(l.hit('ip'), true);
  assert.equal(l.hit('ip'), false);
  assert.equal(l.hit('autre-ip'), true, 'les adresses sont comptées séparément');
  t = 1001;
  assert.equal(l.hit('ip'), true);
});
