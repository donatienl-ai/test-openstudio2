/**
 * OpenStudio — client front pour le back-end (commandes vidéo, uploads, paiement simulé, téléchargements).
 * À inclure dans index.html :  <script src="openstudio-api.js"></script>
 * Puis définir l'URL du back-end AVANT :  <script>window.OPENSTUDIO_API = 'https://openstudio-backend.onrender.com';</script>
 */
(function () {
  'use strict';

  const API = () => (window.OPENSTUDIO_API || '').replace(/\/$/, '');
  const STORE_KEY = 'openstudio_orders';
  const CLIENT_KEY = 'openstudio_client';

  // --- Espace client (identifiant + jeton remis par l'équipe dans le lien d'accès) ---
  // Lien d'accès : https://votre-site/?client=<id>&clientToken=<jeton>
  function clientSession() {
    const p = new URLSearchParams(location.search);
    if (p.get('client') && p.get('clientToken')) {
      const s = { id: p.get('client'), token: p.get('clientToken') };
      try {
        localStorage.setItem(CLIENT_KEY, JSON.stringify(s));
      } catch {
        /* ignoré */
      }
      return s;
    }
    try {
      return JSON.parse(localStorage.getItem(CLIENT_KEY) || 'null');
    } catch {
      return null;
    }
  }

  // --- Mémorisation locale des commandes (id + jeton d'accès) -----------------
  function savedOrders() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch {
      return [];
    }
  }
  function rememberOrder(id, token, type) {
    try {
      const list = savedOrders().filter((o) => o.id !== id);
      list.unshift({ id, token, type, createdAt: new Date().toISOString() });
      localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, 100)));
    } catch {
      /* stockage indisponible : le lien de commande reste utilisable */
    }
  }
  function tokenFor(id) {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) return fromUrl;
    return (savedOrders().find((o) => o.id === id) || {}).token || '';
  }

  function clientHeaders() {
    const c = clientSession();
    return c ? { 'X-Client-Id': c.id, 'X-Client-Token': c.token } : {};
  }

  // --- Appels HTTP ------------------------------------------------------------
  async function call(method, path, { body, token } = {}) {
    const res = await fetch(API() + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { 'X-Order-Token': token } : {}),
        ...clientHeaders(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erreur ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /**
   * Envoie un fichier directement vers le stockage (sans passer par le serveur).
   * @param {File} file
   * @param {'video'|'transcript'|'logo'} kind   (transcript = fichier .srt ou .vtt)
   * @param {(percent:number)=>void} [onProgress]
   * @returns {Promise<string>} clé de stockage à mettre dans les options de commande
   */
  async function uploadFile(file, kind, onProgress) {
    const isVtt = /\.vtt$/i.test(file.name);
    const contentType =
      file.type || (kind === 'transcript' ? (isVtt ? 'text/vtt' : 'application/x-subrip') : 'application/octet-stream');
    const { key, uploadUrl, headers } = await call('POST', '/api/uploads', {
      body: { kind, fileName: file.name, contentType },
    });
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      Object.entries(headers || {}).forEach(([k, v]) => xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(Math.round((e.loaded / e.total) * 100));
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload échoué (${xhr.status})`)));
      xhr.onerror = () => reject(new Error('Upload interrompu'));
      xhr.send(file);
    });
    return key;
  }

  /**
   * Crée la commande, la valide, puis (en test) simule le paiement.
   * @param {'capsules'|'subtitles'|'visuels'|'publications'} type
   * @param {object} options  voir INTEGRATION.md
   * @param {object} [client] { name, email, company }
   * @param {{simulatePayment?: boolean}} [opts]
   */
  async function submitOrder(type, options, client, opts = {}) {
    const created = await call('POST', '/api/orders', { body: { type, options, client } });
    const id = created.order.id;
    const token = created.accessToken;
    rememberOrder(id, token, type);
    let order = (await call('POST', `/api/orders/${id}/validate`, { token })).order;
    if (opts.simulatePayment !== false) {
      order = (await call('POST', `/api/orders/${id}/pay/simulate`, { token })).order;
    }
    return { order, token, link: orderLink(id, token) };
  }

  function orderLink(id, token) {
    return `${location.origin}/mes-commandes.html?order=${encodeURIComponent(id)}&token=${encodeURIComponent(token)}`;
  }

  const getOrder = (id) => call('GET', `/api/orders/${id}`, { token: tokenFor(id) }).then((d) => d.order);
  const getDownloads = (id) => call('GET', `/api/orders/${id}/downloads`, { token: tokenFor(id) });
  const zipUrl = (id) => {
    const c = clientSession();
    const t = tokenFor(id);
    const q = t ? `token=${encodeURIComponent(t)}` : c ? `client=${encodeURIComponent(c.id)}&clientToken=${encodeURIComponent(c.token)}` : '';
    return `${API()}/api/orders/${id}/download.zip?${q}`;
  };
  const getCatalog = () => call('GET', '/api/catalog');
  /** Client connecté + vidéos de son package (étape 1 « Vidéo » des capsules). */
  const getMyVideos = () => call('GET', '/api/me');
  /** Réponse du client sur les campagnes marketing (true : accepte, false : refuse). */
  const setMarketing = (optin) => call('POST', '/api/me/marketing', { body: { optin: Boolean(optin) } });
  /** Adresse de lecture d'une vidéo du package (valable 1 heure). */
  const videoStreamUrl = (videoId) => call('GET', `/api/me/videos/${encodeURIComponent(videoId)}/stream`).then((d) => d.url);
  /** Connexion avec le code d'accès (OM-XXXX-XX) : la session est gardée dans ce navigateur. */
  const loginWithCode = async (code) => {
    try { localStorage.removeItem(CLIENT_KEY); } catch { /* ignoré */ }
    const d = await call('POST', '/api/client/login', { body: { code } });
    try { localStorage.setItem(CLIENT_KEY, JSON.stringify({ id: d.client.id, token: d.token })); } catch { /* ignoré */ }
    return d.client;
  };
  /** Session ouverte avec un code (et non avec un ancien lien d'accès) ? */
  const hasCodeSession = () => { const c = clientSession(); return Boolean(c && String(c.token).startsWith('cst_')); };
  /** Déconnexion : la session locale est effacée tout de suite, puis fermée côté serveur. */
  const logoutClient = async () => {
    const c = clientSession();
    try { localStorage.removeItem(CLIENT_KEY); } catch { /* ignoré */ }
    if (!c) return;
    try {
      await fetch(API() + '/api/client/logout', { method: 'POST', headers: { 'X-Client-Id': c.id, 'X-Client-Token': c.token }, keepalive: true });
    } catch { /* la session expirera d'elle-même */ }
  };
  /** Mode test : ajoute à l'espace client une vidéo déjà envoyée avec uploadFile(file, 'video'). */
  const addMyVideo = ({ title, sourceKey, programmeId, broadcastDate, durationSec }) =>
    call('POST', '/api/me/videos', { body: { title, sourceKey, programmeId, broadcastDate, durationSec } }).then((d) => d.video);
  // --- Réseaux sociaux (Upload-Post, via le serveur OpenStudio : aucune clé dans le navigateur) ---
  const social = {
    accounts: () => call('GET', '/api/social/accounts'),
    /** URL de la fenêtre officielle du réseau (à ouvrir dans une fenêtre pop-up). */
    connect: (platform) => call('POST', `/api/social/connect/${encodeURIComponent(platform)}`),
    facebookPages: () => call('GET', '/api/social/facebook/pages'),
    selectFacebookPage: (pageId) => call('POST', '/api/social/facebook/page', { body: { pageId } }),
    captions: (videoId) => call('GET', `/api/social/videos/${encodeURIComponent(videoId)}/captions`),
    regenerateCaptions: (videoId) => call('POST', `/api/social/videos/${encodeURIComponent(videoId)}/captions/regenerate`),
    /** { videoId, platforms: [...], texts: { youtube: {title, description}, instagram: {caption}, ... }, scheduledAt?: 'AAAA-MM-JJTHH:MM' (heure de Paris) } */
    publish: (pub) => call('POST', '/api/social/publications', { body: pub }).then((d) => d.publication),
    publications: (videoId) => call('GET', `/api/social/publications${videoId ? `?video=${encodeURIComponent(videoId)}` : ''}`).then((d) => d.publications),
    performance: (filters = {}) => call('GET', `/api/social/performance?${new URLSearchParams(Object.entries(filters).filter(([, v]) => v))}`),
    refreshPerformance: () => call('POST', '/api/social/performance/refresh'),
    /** Origine du serveur (pour vérifier le message envoyé par la fenêtre de connexion). */
    origin: () => new URL(API()).origin,
  };

  // --- Confier ma vidéo à un monteur : prestations, demande, retour du paiement ---
  const montage = {
    offers: () => call('GET', '/api/montage/offers'),
    /** Renvoie { id, status, checkoutUrl } : rediriger vers checkoutUrl (paiement Stripe). */
    request: (body) => call('POST', '/api/montage/requests', { body }),
    status: (id) => call('GET', `/api/montage/requests/${encodeURIComponent(id)}`),
  };

  /** Commandes de l'espace client. */
  const getMyOrders = () => call('GET', '/api/me/orders').then((d) => d.orders);

  /** Interroge le statut jusqu'à « ready » / « error » / « dry_run ». */
  function watchOrder(id, onUpdate, intervalMs = 15000) {
    let stopped = false;
    (async function tick() {
      if (stopped) return;
      try {
        const order = await getOrder(id);
        onUpdate(order);
        if (['ready', 'error', 'dry_run'].includes(order.status)) return;
      } catch (e) {
        onUpdate(null, e);
      }
      setTimeout(tick, intervalMs);
    })();
    return () => {
      stopped = true;
    };
  }

  window.OpenStudio = {
    uploadFile,
    submitOrder,
    getOrder,
    getDownloads,
    zipUrl,
    getCatalog,
    getMyVideos,
    setMarketing,
    loginWithCode,
    videoStreamUrl,
    hasCodeSession,
    logoutClient,
    addMyVideo,
    social,
    montage,
    getMyOrders,
    clientSession,
    watchOrder,
    savedOrders,
    orderLink,
  };
})();
