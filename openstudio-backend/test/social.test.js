'use strict';
/**
 * Publication sur les réseaux (Upload-Post), légendes et performances.
 * Base PostgreSQL réelle (TEST_DATABASE_URL), Upload-Post / stockage / Claude simulés.
 * Sans TEST_DATABASE_URL, ces tests sont ignorés.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB;
  process.env.DATABASE_SSL = 'false';
  process.env.UPLOAD_POST_API_KEY = 'up-test-key';
  process.env.UPLOAD_POST_WEBHOOK_SECRET = 'whsec_test';
  process.env.PUBLIC_BASE_URL = 'https://backend.example';
  process.env.FRONTEND_ORIGIN = 'https://site.example';
  process.env.ANTHROPIC_API_KEY = '';
}
const skip = !DB && 'TEST_DATABASE_URL non défini';

const config = require('../src/config');
const db = require('../src/db');
const storage = require('../src/storage');
const up = require('../src/social/uploadpost');
const social = require('../src/social/service');
const captionsLib = require('../src/social/captions');

const A = { id: crypto.randomUUID(), name: 'Ecoval', company: 'Ecoval Industrie', sector: 'Recyclage industriel' };
const B = { id: crypto.randomUUID(), name: 'Autre', company: 'Autre SA' };
let videoA; // deliverable du client A
let videoB;

// --- Simulations Upload-Post -------------------------------------------------
const calls = [];
let accountsState = {};
let selectedPage = null;
function stubUploadPost() {
  up.createProfile = async (u) => { calls.push(['createProfile', u]); return { success: true }; };
  up.getProfile = async (u) => ({ username: u, social_accounts: accountsState, selected_page_id: selectedPage, selected_page_name: selectedPage ? 'Ma Page' : null });
  up.startOAuth = async (platform, profile, redirect) => { calls.push(['startOAuth', platform, profile, redirect]); return { authorize_url: `https://${platform}.example/authorize?state=x`, expires_in: 900 }; };
  up.getFacebookPages = async () => ({ pages: [{ id: '111', name: 'Ma Page' }], selected_page_id: selectedPage });
  up.pinFacebookPage = async (profile, id) => { selectedPage = id; return { facebook_page_name: 'Ma Page' }; };
  up.uploadVideo = async (fields) => { calls.push(['upload', fields]); return fields.scheduled_date ? { job_id: 'job-1' } : { request_id: 'req-' + calls.length }; };
  up.getPostAnalytics = async () => ({
    platforms: {
      youtube: { success: true, post_url: 'https://youtube.com/shorts/abc', post_metrics: { views: 5200, likes: 120, comments: 8, favorites: 3 } },
      tiktok: { success: true, post_url: 'https://www.tiktok.com/@x/video/1', post_metrics_error: 'TikTok video not found' },
    },
  });
  storage.presignDownload = async (key) => `https://bucket.example/${key}?signed=1`;
}

async function insertVideo(clientId, { kind = 'capsules', title = 'Capsule 1', transcript = null, format = '9:16' } = {}) {
  const orderId = crypto.randomUUID();
  await db.query(
    `INSERT INTO orders (id, type, status, payment_status, options, access_token, client_id)
     VALUES ($1, $2, 'ready', 'paid', $3, 'tok', $4)`,
    [orderId, kind === 'subtitles' ? 'subtitles' : 'capsules', JSON.stringify({ kind, programmeId: 'bfm-business', format, videoTitle: 'Passage' }), clientId]
  );
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO deliverables (id, order_id, storage_key, file_name, title, duration_ms, opus_clip_id, expires_at, transcript)
     VALUES ($1, $2, $3, 'capsule.mp4', $4, 15000, $5, now() + interval '30 days', $6)`,
    [id, orderId, `commandes/${orderId}/capsule.mp4`, title, crypto.randomUUID(), transcript]
  );
  return id;
}

test.before(async () => {
  if (skip) return;
  // Base de test repartie de zéro à chaque exécution (jamais sur une autre base que celle de test)
  if (!/test/i.test(DB)) throw new Error('TEST_DATABASE_URL doit désigner une base de test');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await db.migrate();
  for (const c of [A, B]) {
    await db.query('INSERT INTO clients (id, name, company, access_token, sector) VALUES ($1,$2,$3,$4,$5)', [c.id, c.name, c.company, 'tok-' + c.id, c.sector || null]);
  }
  videoA = await insertVideo(A.id, { transcript: 'Nous recyclons les plastiques industriels en granulés.' });
  videoB = await insertVideo(B.id);
  stubUploadPost();
});
test.after(async () => { if (!skip) await db.pool.end(); });

const connected = (extra = {}) => ({ username: 'id', handle: '@ecoval', display_name: 'Ecoval', ...extra });

test('comptes : aucun profil → tout déconnecté, sans créer de profil', { skip }, async () => {
  const r = await social.accounts(A);
  assert.equal(r.platforms.youtube.connected, false);
  assert.equal(calls.filter((c) => c[0] === 'createProfile').length, 0);
});

test('connexion : profil créé au premier clic (nom = id client), retour vers /api/social/connected', { skip }, async () => {
  const r = await social.startConnect(A, 'youtube');
  assert.match(r.authorizeUrl, /^https:\/\/youtube\.example\/authorize/);
  assert.deepEqual(calls.find((c) => c[0] === 'createProfile'), ['createProfile', A.id]);
  assert.deepEqual(calls.find((c) => c[0] === 'startOAuth'), ['startOAuth', 'youtube', A.id, 'https://backend.example/api/social/connected']);
  await social.startConnect(A, 'instagram');
  assert.equal(calls.filter((c) => c[0] === 'createProfile').length, 1, 'profil créé une seule fois');
  await assert.rejects(social.startConnect(A, 'myspace'), /Réseau non proposé/);
});

test('comptes : connecté, à reconnecter, Page Facebook unique épinglée automatiquement', { skip }, async () => {
  accountsState = { youtube: connected(), instagram: connected({ reauth_required: true }), tiktok: '', facebook: connected(), linkedin: null };
  const r = await social.accounts(A);
  assert.equal(r.platforms.youtube.connected, true);
  assert.equal(r.platforms.instagram.reauthRequired, true);
  assert.equal(r.platforms.tiktok.connected, false);
  assert.equal(r.platforms.linkedin.connected, false);
  const pages = await social.facebookPages(A);
  assert.equal(pages.selectedId, '111');
});

test('sécurité : un client ne voit ni ne publie la vidéo d’un autre', { skip }, async () => {
  await assert.rejects(social.captions(B, videoA), /Vidéo introuvable/);
  await assert.rejects(social.publish(B, { deliverableId: videoA, platforms: ['youtube'], texts: { youtube: { title: 'x', description: 'y' } } }), /Vidéo introuvable/);
  await assert.rejects(social.captions(A, 'pas-un-uuid'), /Vidéo introuvable/);
});

test('légendes : générées une fois (secours sans clé IA), relues ensuite, régénération limitée à 5', { skip }, async () => {
  const c1 = await social.captions(A, videoA);
  assert.equal(c1.source, 'fallback');
  assert.match(c1.captions.instagram.caption, /BFM Business/);
  assert.ok(c1.captions.youtube.description.includes('#Shorts'));
  assert.equal(c1.regenerationsLeft, 5);
  assert.equal(c1.limits.tiktok.caption, 2200);
  for (let i = 0; i < 5; i++) await social.captions(A, videoA, { regenerate: true });
  await assert.rejects(social.captions(A, videoA, { regenerate: true }), /5 fois/);
  assert.equal((await social.captions(A, videoA)).regenerationsLeft, 0);
});

test('publication : un texte par réseau en un seul appel, URL signée, external_id, refus si non connecté / à reconnecter', { skip }, async () => {
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['instagram'], texts: { instagram: { caption: 'x' } } }), /Reconnectez votre compte Instagram/);
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['tiktok'], texts: { tiktok: { caption: 'x' } } }), /Connectez d’abord votre compte TikTok/);
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['youtube'], texts: { youtube: { title: '', description: 'd' } } }), /titre est obligatoire/);
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['facebook'], texts: { facebook: { caption: 'x'.repeat(5001) } } }), /trop long/);

  const pub = await social.publish(A, {
    deliverableId: videoA,
    platforms: ['youtube', 'facebook'],
    texts: { youtube: { title: 'Nos granulés vus sur BFM', description: 'Desc #Shorts' }, facebook: { caption: 'Texte Facebook' } },
  });
  assert.equal(pub.status, 'in_progress');
  assert.deepEqual(pub.targets.map((t) => [t.platform, t.status]), [['facebook', 'pending'], ['youtube', 'pending']]);
  const f = calls.filter((c) => c[0] === 'upload').pop()[1];
  assert.equal(f.user, A.id);
  assert.match(f.video, /^https:\/\/bucket\.example\/commandes\/.+\?signed=1$/);
  assert.deepEqual(f['platform[]'], ['youtube', 'facebook']);
  assert.equal(f.youtube_title, 'Nos granulés vus sur BFM');
  assert.equal(f.youtube_description, 'Desc #Shorts');
  assert.equal(f.facebook_description, 'Texte Facebook');
  assert.equal(f.async_upload, 'true');
  assert.equal(f.external_id, pub.id);
  assert.equal(f.instagram_title, undefined);
  assert.equal(f.facebook_media_type, undefined, 'vidéo verticale : Reels par défaut');
});

test('programmation : heure de Paris, 7 jours maximum', { skip }, async () => {
  const fmt = (d) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d).replace(' ', 'T');
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['youtube'], texts: { youtube: { title: 't', description: 'd' } }, scheduledAt: fmt(new Date(Date.now() + 8 * 86400_000)) }), /7 jours/);
  await assert.rejects(social.publish(A, { deliverableId: videoA, platforms: ['youtube'], texts: { youtube: { title: 't', description: 'd' } }, scheduledAt: fmt(new Date(Date.now() - 3600_000)) }), /futur/);
  const when = fmt(new Date(Date.now() + 2 * 86400_000));
  const pub = await social.publish(A, { deliverableId: videoA, platforms: ['youtube'], texts: { youtube: { title: 't', description: 'd' } }, scheduledAt: when });
  assert.equal(pub.status, 'scheduled');
  const f = calls.filter((c) => c[0] === 'upload').pop()[1];
  assert.equal(f.scheduled_date, `${when}:00`);
  assert.equal(f.timezone, 'Europe/Paris');
  // Conversion heure de Paris → UTC (été : +2 h, hiver : +1 h)
  assert.equal(social.parisLocalToDate('2026-07-14T20:00').toISOString(), '2026-07-14T18:00:00.000Z');
  assert.equal(social.parisLocalToDate('2026-12-24T20:00').toISOString(), '2026-12-24T19:00:00.000Z');
});

test('notification upload_completed : signature vérifiée, doublons ignorés, lien du post enregistré', { skip }, async () => {
  const [pub] = (await social.listPublications(A, { videoId: videoA })).filter((p) => p.status === 'in_progress');
  const send = (body, { secret = 'whsec_test', delivery = crypto.randomUUID() } = {}) => {
    const raw = Buffer.from(JSON.stringify(body));
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', secret).update(`${ts}.`).update(raw).digest('hex');
    return social.handleWebhook(raw, { 'x-upload-post-signature': `sha256=${sig}`, 'x-upload-post-timestamp': ts, 'x-upload-post-delivery': delivery });
  };
  assert.equal((await send({ event: 'upload_completed' }, { secret: 'faux' })).status, 401);
  const ev = { event: 'upload_completed', external_id: pub.id, platform: 'youtube', result: { success: true, url: 'https://youtube.com/shorts/abc', post_id: 'abc' } };
  assert.equal((await send(ev, { delivery: 'd1' })).status, 200);
  assert.equal((await send(ev, { delivery: 'd1' })).duplicate, true);
  await send({ event: 'upload_completed', external_id: pub.id, platform: 'facebook', result: { success: false, error: 'Page introuvable' } });
  const after = await social.getPublication(A, pub.id);
  assert.equal(after.status, 'partial');
  const yt = after.targets.find((t) => t.platform === 'youtube');
  assert.equal(yt.status, 'published');
  assert.equal(yt.url, 'https://youtube.com/shorts/abc');
  assert.equal(after.targets.find((t) => t.platform === 'facebook').error, 'Page introuvable');
  await assert.rejects(social.getPublication(B, pub.id), /introuvable/);
});

test('performances : statistiques en cache, « — » si non fournie, filtres, tri, actualisation limitée', { skip }, async () => {
  // Une 2e vidéo publiée sur TikTok (statistiques non fournies par TikTok)
  const v2 = await insertVideo(A.id, { kind: 'teaser', title: 'Teaser' });
  accountsState.tiktok = connected();
  const p2 = await social.publish(A, { deliverableId: v2, platforms: ['tiktok'], texts: { tiktok: { caption: 'Court #bfm' } } });
  await social.applyResult(p2.id, 'tiktok', { success: true, url: 'https://www.tiktok.com/@x/video/1' });
  await db.query("UPDATE publications SET request_id = 'req-p2' WHERE id = $1", [p2.id]);

  const perf = await social.performance(A, { period: '30' });
  assert.equal(perf.totals.publications, 2);
  assert.equal(perf.totals.views, 5200, 'TikTok ne compte pas pour 0');
  assert.equal(perf.videos[0].title, 'Capsule 1', 'les plus vues d’abord');
  const tk = perf.videos[1].networks.find((n) => n.platform === 'tiktok');
  assert.equal(tk.views, null);
  assert.equal(tk.unavailable, 'TikTok video not found');
  assert.ok(perf.lastUpdate);
  assert.equal((await social.performance(A, { kind: 'teaser' })).videos.length, 1);
  assert.equal((await social.performance(A, { platform: 'youtube' })).totals.publications, 1);
  assert.equal((await social.performance(B, {})).videos.length, 0, 'rien du client A chez le client B');

  await social.manualRefresh(A);
  await assert.rejects(social.manualRefresh(A), /Réessayez dans 15 min/);
});

test('métriques : alias des réseaux, null si absente', () => {
  assert.equal(social.metric({ play_count: 10 }, 'views'), 10);
  assert.equal(social.metric({ reactions: 3 }, 'likes'), 3);
  assert.equal(social.metric({ likes: 3 }, 'shares'), null);
  assert.equal(social.metric(null, 'views'), null);
});

test('légendes IA : un seul appel, sortie structurée, limites appliquées ; échec → secours', async () => {
  let req = null;
  const fake = { beta: { messages: { create: async (r) => { req = r; return { stop_reason: 'end_turn', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify({ youtube: { title: 'T'.repeat(150), description: 'D #Shorts' }, instagram: { caption: 'IG' }, tiktok: { caption: 'TT' }, linkedin: { caption: 'LI' }, facebook: { caption: 'FB' } }) }] }; } } } };
  const ctx = { title: 'Capsule', kind: 'capsules', programme: 'BFM Business', company: 'Ecoval', sector: 'Recyclage', transcript: 'Nous recyclons.' };
  const r = await captionsLib.generateCaptions(ctx, { client: fake });
  assert.equal(r.source, 'ai');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.equal(req.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(Object.keys(req.output_config.format.schema.properties), ['youtube', 'instagram', 'tiktok', 'linkedin', 'facebook']);
  assert.equal(req.fallbacks, 'default');
  assert.match(req.messages[0].content, /Nous recyclons\./);
  assert.match(req.system, /N'invente jamais de chiffres/);
  assert.ok(r.captions.youtube.title.length <= 100, 'titre YouTube coupé à 100');
  const broken = { beta: { messages: { create: async () => { throw new Error('API indisponible'); } } } };
  const f = await captionsLib.generateCaptions(ctx, { client: broken });
  assert.equal(f.source, 'fallback');
  assert.match(f.captions.linkedin.caption, /BFM Business/);
});

test('textes sans IA : un texte propre à chaque réseau, selon ses bonnes pratiques', () => {
  const ctx = { title: 'Nos granulés vus sur BFM Business', kind: 'capsules', programme: 'BFM Business', company: 'Écoval Industrie', sector: 'Recyclage',
    transcript: 'Bonjour. Nous recyclons chaque année des milliers de tonnes de plastiques industriels en granulés. Merci.' };
  const c = captionsLib.fallbackCaptions(ctx);
  const all = [c.youtube.description, c.instagram.caption, c.tiktok.caption, c.linkedin.caption, c.facebook.caption];
  assert.equal(new Set(all).size, 5, 'aucun texte recopié d’un réseau à l’autre');
  assert.equal(c.youtube.title, 'Nos granulés vus sur BFM Business', 'émission non répétée dans le titre');
  assert.ok(c.youtube.title.length <= 70);
  assert.match(c.youtube.description, /#Shorts/);
  assert.match(c.instagram.caption, /« Nous recyclons chaque année des milliers de tonnes de plastiques industriels en granulés\. »/, 'citation tirée de la transcription');
  assert.match(c.instagram.caption, /#BFMBusiness #EcovalIndustrie #Recyclage/);
  assert.ok(c.tiktok.caption.split('\n').length <= 2, 'TikTok : 2 lignes maximum');
  const li = c.linkedin.caption;
  assert.ok((li.match(/#\w+/g) || []).length <= 3, 'LinkedIn : 3 hashtags maximum');
  assert.match(li.trim().split('\n').slice(-3).join(' '), /\?/, 'LinkedIn : question finale');
  assert.ok((c.facebook.caption.match(/#\w+/g) || []).length <= 2, 'Facebook : 2 hashtags maximum');
  // Interview complète (horizontale) : pas de #Shorts ; titre générique remplacé
  const s = captionsLib.fallbackCaptions({ title: 'Capsule 1', kind: 'subtitles', company: 'Ecoval', programme: 'BFM Business' });
  assert.doesNotMatch(s.youtube.description, /#Shorts/);
  assert.equal(s.youtube.title, 'Ecoval sur BFM Business');
  // « Autre proposition » : l'accroche change
  assert.notEqual(captionsLib.fallbackCaptions(ctx, 1).instagram.caption, c.instagram.caption);
  assert.equal(captionsLib.hashtag('BFM Business'), '#BFMBusiness');
  assert.equal(captionsLib.pickQuote('Oui. Bon.'), '');
});

test('format 16:9 : Facebook en vidéo de Page (les Reels sont verticaux)', () => {
  const f = social.uploadFields({ username: 'u', videoUrl: 'https://v', title: 'T', platforms: ['facebook'], texts: { facebook: { caption: 'c' } }, publicationId: 'p', format: '16:9' });
  assert.equal(f.facebook_media_type, 'VIDEO');
});
