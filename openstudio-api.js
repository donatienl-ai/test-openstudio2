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
  /** Mode test : ajoute à l'espace client une vidéo déjà envoyée avec uploadFile(file, 'video'). */
  const addMyVideo = ({ title, sourceKey, programmeId, broadcastDate, durationSec }) =>
    call('POST', '/api/me/videos', { body: { title, sourceKey, programmeId, broadcastDate, durationSec } }).then((d) => d.video);
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
    addMyVideo,
    getMyOrders,
    clientSession,
    watchOrder,
    savedOrders,
    orderLink,
  };
})();
