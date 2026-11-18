/* Back-office OpenStudio — espace équipe OpenMedias.
   Application sans dépendance : connexion en deux temps, activation des comptes, équipe, journal.
   Le jeton de session reste dans l'onglet (sessionStorage) et part dans l'en-tête Authorization. */
(function () {
  'use strict';

  var API = ((window.OPENSTUDIO_ADMIN_CONFIG || {}).API_URL || '').replace(/\/$/, '');
  var TOKEN_KEY = 'openstudio_admin_session';
  var app = document.getElementById('app');

  var S = {
    view: 'loading',        // loading | login | code | invite | invite-key | app
    page: 'accueil',
    user: null,
    pendingToken: null,
    invite: null,           // { token, email, name, role, secret, uri }
    error: '',
    busy: false,
    team: null,
    lastLink: null,         // lien d'activation à transmettre, affiché après création ou réinitialisation
    audit: null,
    sub: '',                // sous-page : '#clients/<sub>'
    clients: null,
    mail: null,
    clientFilter: { q: '', status: '' },
    client: null,           // fiche ouverte : { client, videos, history, mail }
    clientLink: null,       // lien créé à la main, affiché une seule fois
    importPreview: null,
    importCsv: '',
  };

  /* ------------------------------------------------------------ Outils */

  function esc(v) {
    return String(v === null || v === undefined ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtDate(v) {
    if (!v) return '—';
    var d = new Date(v);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) + ' à ' +
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, 3500);
  }

  function getToken() { try { return sessionStorage.getItem(TOKEN_KEY); } catch (e) { return null; } }
  function setToken(t) { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch (e) { /* navigation privée */ } }

  function api(method, path, body, token) {
    var headers = { 'Content-Type': 'application/json' };
    var tk = token === '-' ? null : (token || getToken());
    if (tk) headers.Authorization = 'Bearer ' + tk;
    return fetch(API + '/api' + path, {
      method: method,
      headers: headers,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'omit',
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (r.status === 401 && S.view === 'app' && data.code === 'auth_required') {
          setToken(null);
          S.user = null;
          S.view = 'login';
          S.error = 'Votre session a expiré. Reconnectez-vous.';
          render();
        }
        if (!r.ok) {
          var err = new Error(data.error || ('Erreur ' + r.status));
          err.status = r.status;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error('Serveur injoignable. Vérifiez votre connexion ; le serveur peut aussi être en train de redémarrer (environ 1 minute).');
    });
  }

  function errorBox() { return S.error ? '<div class="error" role="alert">' + esc(S.error) + '</div>' : ''; }

  function brand(sub) {
    return '<div class="brand"><b>OpenStudio</b><span>' + esc(sub || 'Espace équipe OpenMedias') + '</span></div>';
  }

  function groupKey(secret) { return String(secret).replace(/(.{4})/g, '$1 ').trim(); }

  /* ------------------------------------------------------------ Écrans de connexion */

  function viewLogin() {
    return '<div class="auth"><div class="auth-card">' + brand() +
      '<h1>Connexion</h1><p class="muted small">Réservé aux collaborateurs OpenMedias.</p>' +
      '<form data-form="login" novalidate>' + errorBox() +
      '<label>Identifiant<input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="ex. thomas.d" required></label>' +
      '<label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Continuer</button>' +
      '</form></div></div>';
  }

  function viewCode() {
    return '<div class="auth"><div class="auth-card">' + brand() +
      '<h1>Code de sécurité</h1><p class="muted small">Ouvrez votre application d’authentification et saisissez le code à 6 chiffres affiché pour « OpenStudio admin ».</p>' +
      '<form data-form="code" novalidate>' + errorBox() +
      '<label>Code<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Se connecter</button>' +
      '<button class="btn secondary" type="button" data-a="to-login">Recommencer</button>' +
      '</form></div></div>';
  }

  function viewInvite() {
    var i = S.invite;
    return '<div class="auth"><div class="auth-card">' + brand('Activation de votre compte') +
      (i.twoFactor ? '<div class="steps"><i class="on"></i><i></i></div>' : '') +
      '<h1>Bienvenue ' + esc(i.name) + '</h1><p class="muted small">Votre identifiant de connexion : <b class="mono">' + esc(i.username) + '</b>. Choisissez votre mot de passe.</p>' +
      '<form data-form="invite-start" novalidate>' + errorBox() +
      '<input type="text" hidden name="login" autocomplete="username" value="' + esc(i.username) + '">' +
      '<label>Mot de passe<input name="password" type="password" autocomplete="new-password" minlength="9" required></label>' +
      '<label>Confirmez le mot de passe<input name="confirm" type="password" autocomplete="new-password" minlength="9" required></label>' +
      '<p class="small muted">Au moins 9 caractères, avec au moins une lettre et un chiffre (par exemple 8 chiffres et 1 lettre).</p>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (i.twoFactor ? 'Continuer' : 'Activer mon compte') + '</button>' +
      '</form></div></div>';
  }

  function viewInviteKey() {
    var i = S.invite;
    return '<div class="auth"><div class="auth-card">' + brand('Activation de votre compte') +
      '<div class="steps"><i class="on"></i><i class="on"></i></div>' +
      '<h1>Double authentification</h1>' +
      '<ol class="howto">' +
      '<li>Sur votre téléphone, ouvrez une application d’authentification (Google Authenticator, Microsoft Authenticator…).</li>' +
      '<li>Ajoutez un compte, choisissez « Saisir une clé de configuration », et recopiez cette clé :</li>' +
      '</ol>' +
      '<code class="secret mono">' + esc(groupKey(i.secret)) + '</code>' +
      '<p class="small muted mt">Sur téléphone, vous pouvez aussi <a href="' + esc(i.uri) + '">ouvrir directement l’application</a>.</p>' +
      '<form data-form="invite-finish" novalidate>' + errorBox() +
      '<label>Code à 6 chiffres affiché par l’application<input class="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required></label>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Activer mon compte</button>' +
      '</form></div></div>';
  }

  /* ------------------------------------------------------------ Application */

  var NAV = [
    ['accueil', 'Accueil', null],
    ['clients', 'Clients', null],
    ['emissions', 'Émissions et vidéos', 'lot 3'],
    ['commandes', 'Commandes', 'lot 3'],
    ['credits', 'Crédits', 'lot 4'],
  ];
  var NAV_SUPER = [['equipe', 'Équipe'], ['journal', 'Journal d’activité']];

  function isSuper() { return S.user && S.user.role === 'super_admin'; }

  function viewApp() {
    var nav = NAV.map(function (n) {
      return '<a href="#' + n[0] + '" class="' + (S.page === n[0] ? 'on' : '') + '">' + esc(n[1]) +
        (n[2] ? '<span class="soon">' + esc(n[2]) + '</span>' : '') + '</a>';
    }).join('');
    var navSuper = isSuper() ? '<div class="sep"></div>' + NAV_SUPER.map(function (n) {
      return '<a href="#' + n[0] + '" class="' + (S.page === n[0] ? 'on' : '') + '">' + esc(n[1]) + '</a>';
    }).join('') : '';
    var page;
    if (S.page === 'clients') page = pageClients();
    else if (S.page === 'equipe' && isSuper()) page = pageTeam();
    else if (S.page === 'journal' && isSuper()) page = pageAudit();
    else if (S.page === 'accueil') page = pageHome();
    else page = pageSoon();
    return '<div class="shell"><nav class="side" aria-label="Navigation">' + brand('Espace équipe') + nav + navSuper +
      '<div class="me"><span><b>' + esc(S.user.name) + '</b><br>' + (isSuper() ? 'Super admin' : 'Admin') + '</span>' +
      '<button type="button" data-a="logout">Se déconnecter</button></div></nav><main>' + page + '</main></div>';
  }

  function pageHome() {
    return '<div class="head"><div><h1>Bonjour ' + esc(S.user.name) + '</h1>' +
      '<p class="muted">Le back-office se construit lot par lot. Les rubriques marquées d’un numéro de lot arrivent dans les prochaines semaines.</p></div></div>' +
      '<div class="card"><h2>Ce qui est disponible</h2><p>Connexion à l’espace équipe avec votre identifiant.' +
      (isSuper() ? ' En tant que super admin, vous gérez aussi les comptes de l’équipe et consultez le journal d’activité.' : '') + '</p></div>';
  }

  function pageSoon() {
    var n = NAV.filter(function (x) { return x[0] === S.page; })[0] || NAV[0];
    return '<div class="head"><div><h1>' + esc(n[1]) + '</h1></div></div><div class="card empty">Cette rubrique arrive avec le ' + esc(n[2] || 'prochain lot') + '.</div>';
  }

  function statusTag(u) {
    if (!u.active) return '<span class="tag off">Désactivé</span>';
    if (!u.activated) return '<span class="tag wait">À activer</span>';
    return '<span class="tag ok">Actif</span>';
  }

  function pageTeam() {
    var rows;
    if (!S.team) rows = '<div class="empty">Chargement…</div>';
    else {
      rows = '<table><thead><tr><th>Nom</th><th>Identifiant</th><th>E-mail</th><th>Rôle</th><th>Statut</th><th>Dernière connexion</th><th></th></tr></thead><tbody>' +
        S.team.map(function (u) {
          var self = u.id === S.user.id;
          var actions = self ? '<span class="small muted">Vous</span>' :
            '<button class="btn small secondary" data-a="reset" data-id="' + esc(u.id) + '">' + (u.activated ? 'Réinitialiser l’accès' : 'Nouveau lien') + '</button>' +
            (u.active ? '<button class="btn small danger" data-a="disable" data-id="' + esc(u.id) + '">Désactiver</button>'
              : '<button class="btn small secondary" data-a="enable" data-id="' + esc(u.id) + '">Réactiver</button>');
          return '<tr><td><b>' + esc(u.name) + '</b></td><td class="mono">' + esc(u.username || '—') + '</td><td>' + esc(u.email) + '</td><td>' +
            (u.role === 'super_admin' ? '<span class="tag super">Super admin</span>' : 'Admin') + '</td><td>' + statusTag(u) +
            '</td><td class="small">' + esc(fmtDate(u.lastLoginAt)) + '</td><td class="actions">' + actions + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    var link = S.lastLink ? '<div class="card"><h2>Lien d’activation pour ' + esc(S.lastLink.name) + '</h2>' +
      '<p class="small">Envoyez ce lien à la personne, par exemple par e-mail, avec son identifiant <b class="mono">' + esc(S.lastLink.username) + '</b>. Le lien est valable 72 heures et ne sert qu’une fois. Il ne sera plus affiché ensuite.</p>' +
      '<div class="linkbox"><input readonly value="' + esc(S.lastLink.url) + '" aria-label="Lien d’activation"><button class="btn secondary" data-a="copy-link">Copier</button></div></div>' : '';
    return '<div class="head"><div><h1>Équipe</h1><p class="muted">Chaque personne a son propre compte : le journal d’activité indique qui a fait quoi.</p></div></div>' + link +
      '<div class="card"><h2>Ajouter un compte</h2><form data-form="team-add" class="grid-form" novalidate>' +
      '<label>Nom<input name="name" required placeholder="Ex. Équipe communication"></label>' +
      '<label>E-mail<input name="email" type="email" required placeholder="thomas.d@openmedias.fr"></label>' +
      '<label>Identifiant <span class="muted">(facultatif)</span><input name="username" autocapitalize="none" spellcheck="false" placeholder="par défaut : avant le @"></label>' +
      '<label>Rôle<select name="role"><option value="admin">Admin</option><option value="super_admin">Super admin</option></select></label>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Créer le compte</button></form>' +
      (S.error ? '<div class="mt">' + errorBox() + '</div>' : '') + '</div>' +
      '<div class="card">' + rows + '</div>';
  }

  var ACTIONS = {
    connexion: 'Connexion',
    connexion_refusee: 'Connexion refusée',
    code_refuse: 'Code de sécurité refusé',
    compte_active: 'Compte activé',
    compte_cree: 'Compte créé',
    acces_reinitialise: 'Accès réinitialisé',
    compte_desactive: 'Compte désactivé',
    compte_reactive: 'Compte réactivé',
    client_cree: 'Client créé',
    client_modifie: 'Client modifié',
    video_ajoutee: 'Vidéo ajoutée',
    video_retiree: 'Vidéo retirée',
    commande_relancee: 'Commande relancée',
    clients_importes: 'Import de clients',
    acces_envoye: 'Lien d’accès envoyé',
    acces_envoye_auto: 'Lien d’accès envoyé automatiquement',
    acces_echec_envoi: 'Échec d’envoi du lien d’accès',
    acces_lien_cree: 'Lien d’accès créé à la main',
    acces_coupe: 'Accès coupé',
  };

  var FIELD_NAMES = {
    name: 'nom', company: 'entreprise', email: 'e-mail', broadcastDate: 'date de diffusion', packageLabel: 'package',
    notes: 'notes', logoKey: 'logo', sector: 'secteur',
  };

  function describe(e) {
    var d = e.detail || {};
    if (d.identifiant && !d.email) return d.identifiant + (d.motif ? ' — ' + d.motif : '');
    if (d.email) return d.email + (d.role ? ' (' + (d.role === 'super_admin' ? 'super admin' : 'admin') + ')' : '') + (d.motif ? ' — ' + d.motif : '');
    if (d.name) return d.name;
    if (d.title) return d.title;
    if (d.champs) return 'Modifié : ' + d.champs.map(function (k) { return FIELD_NAMES[k] || k; }).join(', ');
    if (d.crees !== undefined) return d.crees + ' créé(s), ' + d.ignores + ' ignoré(s)';
    if (d.erreur && d.email) return d.email + ' — ' + d.erreur;
    if (d.erreur) return 'Erreur : ' + d.erreur;
    if (d.redirige_vers) return 'mode test : envoyé à ' + d.redirige_vers;
    return '';
  }

  function pageAudit() {
    var body;
    if (!S.audit) body = '<div class="empty">Chargement…</div>';
    else if (!S.audit.length) body = '<div class="empty">Aucune activité enregistrée pour le moment.</div>';
    else {
      body = '<table><thead><tr><th>Date</th><th>Par</th><th>Action</th><th>Détail</th></tr></thead><tbody>' +
        S.audit.map(function (e) {
          return '<tr><td class="small">' + esc(fmtDate(e.at)) + '</td><td>' + esc(e.actor_label) + '</td><td>' +
            esc(ACTIONS[e.action] || e.action) + '</td><td class="small">' + esc(describe(e)) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    return '<div class="head"><div><h1>Journal d’activité</h1><p class="muted">Les 200 dernières actions de l’équipe.</p></div>' +
      '<button class="btn secondary" data-a="reload-audit">Actualiser</button></div><div class="card">' + body + '</div>';
  }

  /* ------------------------------------------------------------ Clients */

  var MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  function fmtDay(iso) {
    if (!iso) return '—';
    var p = String(iso).slice(0, 10).split('-');
    return Number(p[2]) + ' ' + MONTHS[Number(p[1]) - 1] + ' ' + p[0];
  }

  var ACCESS_TAG = {
    scheduled: 'wait', sent: 'ok', manual: 'info', failed: 'err', revoked: 'off', no_email: 'wait', no_date: 'wait',
  };
  var ACCESS_FILTERS = [
    ['', 'Tous les accès'],
    ['scheduled', 'Envoi programmé'],
    ['sent', 'Lien envoyé'],
    ['manual', 'Lien remis à la main'],
    ['todo', 'À compléter (e-mail ou date)'],
    ['failed', 'Échec d’envoi'],
    ['revoked', 'Accès coupé'],
  ];

  function accessLabel(a) {
    if (!a) return '';
    if (a.code === 'scheduled') return a.label + ' · ' + fmtDay(a.day) + ' à ' + a.hour + ' h';
    if (a.at) return a.label + ' · ' + fmtDate(a.at);
    return a.label;
  }
  function accessTag(a) {
    return '<span class="tag ' + (ACCESS_TAG[a.code] || 'off') + '">' + esc(a.code === 'scheduled' ? 'Programmé' : a.label) + '</span>';
  }

  function mailBanner(m) {
    if (!m) return '';
    if (!m.clientSiteConfigured) return '<div class="error mb">Adresse de l’espace client non configurée sur le serveur (CLIENT_SITE_URL) : aucun lien d’accès ne peut être créé.</div>';
    if (!m.ready) return '<div class="warn mb"><b>Les liens ne partiront pas automatiquement.</b> ' + esc(m.problem) + '</div>';
    if (m.redirectTo) return '<div class="note mb"><b>Mode test :</b> tous les e-mails partent vers ' + esc(m.redirectTo) + ', pas vers les clients.</div>';
    return '';
  }

  function loadClients() {
    if (S.sub && S.sub !== 'nouveau' && S.sub !== 'import') {
      if (!S.client || S.client.client.id !== S.sub) S.client = null;
      return api('GET', '/admin/clients/' + encodeURIComponent(S.sub))
        .then(function (d) { S.client = d; S.mail = d.mail; render(); })
        .catch(function (e) { S.error = e.message; S.client = { missing: true }; render(); });
    }
    if (!S.sub) {
      return api('GET', '/admin/clients')
        .then(function (d) { S.clients = d.clients; S.mail = d.mail; render(); })
        .catch(function (e) { S.error = e.message; S.clients = []; render(); });
    }
  }

  function filteredClients() {
    var q = S.clientFilter.q.trim().toLowerCase();
    var st = S.clientFilter.status;
    return (S.clients || []).filter(function (c) {
      if (q && [c.name, c.company, c.email, c.packageLabel].join(' ').toLowerCase().indexOf(q) === -1) return false;
      if (!st) return true;
      if (st === 'todo') return c.access.code === 'no_email' || c.access.code === 'no_date';
      return c.access.code === st;
    });
  }

  function pageClients() {
    if (S.sub === 'nouveau') return pageClientNew();
    if (S.sub === 'import') return pageClientImport();
    if (S.sub) return pageClientDetail();
    var list = filteredClients();
    var table;
    if (!S.clients) table = '<div class="empty">Chargement…</div>';
    else if (!S.clients.length) table = '<div class="empty">Aucun client pour le moment. Créez le premier, ou importez votre liste depuis un fichier CSV.</div>';
    else if (!list.length) table = '<div class="empty">Aucun client ne correspond à cette recherche.</div>';
    else {
      table = '<table class="rows"><thead><tr><th>Client</th><th>E-mail</th><th>Diffusion</th><th>Package</th><th>Accès</th><th class="num">Vidéos</th></tr></thead><tbody>' +
        list.map(function (c) {
          return '<tr data-href="#clients/' + esc(c.id) + '"><td><a href="#clients/' + esc(c.id) + '"><b>' + esc(c.name) + '</b></a>' +
            (c.company && c.company !== c.name ? '<br><span class="small muted">' + esc(c.company) + '</span>' : '') + '</td>' +
            '<td class="small">' + esc(c.email || '—') + '</td><td class="small nowrap">' + esc(fmtDay(c.broadcastDate)) + '</td>' +
            '<td class="small">' + esc(c.packageLabel || '—') + '</td><td>' + accessTag(c.access) + '</td>' +
            '<td class="num">' + esc(c.videos) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }
    var count = S.clients ? (list.length === S.clients.length ? S.clients.length + ' clients' : list.length + ' sur ' + S.clients.length + ' clients') : '';
    return '<div class="head"><div><h1>Clients</h1><p class="muted">Le lien d’accès de chaque client part automatiquement par e-mail le jour de sa diffusion, à partir de ' +
      esc((S.mail && S.mail.sendHour) || 8) + ' h.</p></div><div class="btns"><a class="btn secondary" href="#clients/import">Importer un fichier</a><a class="btn" href="#clients/nouveau">Nouveau client</a></div></div>' +
      mailBanner(S.mail) + errorBox() +
      '<form data-form="client-filter" class="filters" novalidate><input name="q" type="search" placeholder="Rechercher un nom, une entreprise, un e-mail…" aria-label="Rechercher" value="' + esc(S.clientFilter.q) + '">' +
      '<select name="status" aria-label="Filtrer par accès">' + ACCESS_FILTERS.map(function (f) {
        return '<option value="' + f[0] + '"' + (S.clientFilter.status === f[0] ? ' selected' : '') + '>' + esc(f[1]) + '</option>';
      }).join('') + '</select><span class="small muted">' + esc(count) + '</span></form>' +
      '<div class="card flush">' + table + '</div>';
  }

  function clientFields(c) {
    c = c || {};
    return '<label>Nom du client<input name="name" required maxlength="200" value="' + esc(c.name) + '" placeholder="Ex. Marie Dupont"></label>' +
      '<label>Entreprise<input name="company" maxlength="200" value="' + esc(c.company) + '" placeholder="Ex. Ecoval Industries"></label>' +
      '<label>E-mail<input name="email" type="email" maxlength="200" value="' + esc(c.email) + '" placeholder="Le lien d’accès sera envoyé à cette adresse"></label>' +
      '<label>Date de diffusion<input name="broadcastDate" type="date" value="' + esc(c.broadcastDate || '') + '"></label>' +
      '<label>Package<input name="packageLabel" maxlength="200" value="' + esc(c.packageLabel) + '" placeholder="Ex. BFM Business + immersion"></label>' +
      '<label class="wide">Notes internes <span class="muted">(jamais visibles par le client)</span><textarea name="notes" rows="3" maxlength="2000">' + esc(c.notes) + '</textarea></label>';
  }

  function pageClientNew() {
    return '<p><a href="#clients">← Tous les clients</a></p><div class="head"><div><h1>Nouveau client</h1>' +
      '<p class="muted">Avec un e-mail et une date de diffusion, son lien d’accès partira automatiquement ce jour-là.</p></div></div>' +
      '<div class="card"><form data-form="client-new" class="form-2" novalidate>' + errorBox() + clientFields() +
      '<div class="wide"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Créer le client</button></div></form></div>';
  }

  function pageClientDetail() {
    var d = S.client;
    if (!d) return '<p><a href="#clients">← Tous les clients</a></p><div class="card empty">Chargement…</div>';
    if (d.missing) return '<p><a href="#clients">← Tous les clients</a></p>' + errorBox();
    var c = d.client;
    var a = c.access;
    var explain = {
      scheduled: 'Le lien partira automatiquement le ' + fmtDay(a.day) + ' à partir de ' + a.hour + ' h, à ' + (c.email || '') + '.',
      sent: 'Le client a reçu son lien par e-mail. En renvoyer un nouveau coupe l’ancien.',
      manual: 'Un lien existe et a été transmis à la main. En créer un nouveau coupe l’ancien.',
      failed: 'Dernière erreur : ' + (a.error || '') + '. Vérifiez l’adresse, puis renvoyez.',
      revoked: 'Le client ne peut plus ouvrir son espace. Envoyer ou créer un nouveau lien rétablit l’accès.',
      no_email: 'Ajoutez l’e-mail du client pour que son lien parte automatiquement.',
      no_date: 'Ajoutez la date de diffusion pour programmer l’envoi du lien.',
    }[a.code] || '';
    var hasAccess = a.code === 'sent' || a.code === 'manual';
    var link = S.clientLink && S.clientLink.id === c.id ? '<div class="linkbox"><input readonly value="' + esc(S.clientLink.url) + '" aria-label="Lien d’accès"><button class="btn secondary" type="button" data-a="copy-link">Copier</button></div>' +
      '<p class="small muted mt">Transmettez ce lien au client vous-même. Il ne sera plus affiché ensuite.</p>' : '';
    var videos = d.videos.length ? '<table><tbody>' + d.videos.map(function (v) {
      return '<tr><td>' + esc(v.title) + '</td><td class="small muted">' + esc(v.programmeId) + '</td><td class="small nowrap">' + esc(fmtDay(v.broadcastDate)) + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted small">Aucune vidéo pour le moment. L’ajout des vidéos depuis le back-office arrive avec le lot 3.</p>';
    var history = d.history.length ? '<table><tbody>' + d.history.map(function (e) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(e.at)) + '</td><td class="small">' + esc(e.actor_label) + '</td><td class="small">' + esc(ACTIONS[e.action] || e.action) +
        (describe(e) ? ' <span class="muted">— ' + esc(describe(e)) + '</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted small">Aucune action enregistrée.</p>';
    return '<p><a href="#clients">← Tous les clients</a></p><div class="head"><div><h1>' + esc(c.name) + '</h1><p class="muted">' +
      esc([c.company !== c.name ? c.company : null, c.packageLabel].filter(Boolean).join(' · ') || 'Client') + '</p></div></div>' +
      mailBanner(d.mail) + errorBox() +
      '<div class="cols"><div class="card"><h2>Informations</h2><form data-form="client-edit" class="form-2" novalidate>' + clientFields(c) +
      '<div class="wide"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Enregistrer</button></div></form></div>' +
      '<div><div class="card"><h2>Accès à l’espace client</h2><p>' + accessTag(a) + '</p><p class="small">' + esc(explain) + '</p>' +
      '<div class="btns left">' +
      (c.email ? '<button class="btn" type="button" data-a="client-send"' + (S.busy ? ' disabled' : '') + '>' + (hasAccess || a.code === 'revoked' ? 'Renvoyer un lien par e-mail' : 'Envoyer le lien maintenant') + '</button>' : '') +
      '<button class="btn secondary" type="button" data-a="client-link"' + (S.busy ? ' disabled' : '') + '>Créer un lien à transmettre</button>' +
      (hasAccess ? '<button class="btn danger" type="button" data-a="client-revoke"' + (S.busy ? ' disabled' : '') + '>Couper l’accès</button>' : '') +
      '</div>' + link + '</div>' +
      '<div class="card"><h2>Vidéos (' + esc(d.videos.length) + ')</h2>' + videos + '</div></div></div>' +
      '<div class="card"><h2>Historique</h2>' + history + '</div>';
  }

  function pageClientImport() {
    var p = S.importPreview;
    var preview = '';
    if (p) {
      preview = '<div class="card flush"><table><thead><tr><th>Ligne</th><th>Client</th><th>E-mail</th><th>Diffusion</th><th>Package</th><th>État</th></tr></thead><tbody>' +
        p.rows.map(function (r) {
          var state = r.problems.length ? '<span class="tag err">Ignoré</span> <span class="small">' + esc(r.problems.join(', ')) + '</span>'
            : '<span class="tag ok">Prêt</span>' + (r.warnings.length ? ' <span class="small muted">' + esc(r.warnings.join(', ')) + '</span>' : '');
          return '<tr><td class="small">' + esc(r.line) + '</td><td><b>' + esc(r.client.name || '—') + '</b>' + (r.client.company ? '<br><span class="small muted">' + esc(r.client.company) + '</span>' : '') +
            '</td><td class="small">' + esc(r.client.email || '—') + '</td><td class="small nowrap">' + esc(fmtDay(r.client.broadcastDate)) + '</td><td class="small">' + esc(r.client.packageLabel || '—') + '</td><td>' + state + '</td></tr>';
        }).join('') + '</tbody></table></div>' +
        '<div class="btns left mb">' + (p.ready ? '<button class="btn" type="button" data-a="import-confirm"' + (S.busy ? ' disabled' : '') + '>Importer ' + p.ready + ' client' + (p.ready > 1 ? 's' : '') + '</button>' : '') +
        '<span class="small muted">' + p.ready + ' prêt' + (p.ready > 1 ? 's' : '') + ', ' + p.rejected + ' ignoré' + (p.rejected > 1 ? 's' : '') + '</span></div>';
    }
    return '<p><a href="#clients">← Tous les clients</a></p><div class="head"><div><h1>Importer des clients</h1>' +
      '<p class="muted">Depuis Excel ou Google Sheets : Fichier → Enregistrer sous / Télécharger → CSV.</p></div></div>' +
      '<div class="card"><form data-form="import-preview" novalidate>' + errorBox() +
      '<p class="small">Première ligne : les noms de colonnes. Reconnues : <b>nom</b>, <b>entreprise</b>, <b>email</b>, <b>date de diffusion</b> (JJ/MM/AAAA), <b>package</b>, <b>notes</b>. Les clients déjà présents (même e-mail) sont ignorés.</p>' +
      '<label>Fichier CSV<input name="file" type="file" accept=".csv,text/csv"></label>' +
      '<label>… ou collez le contenu ici<textarea name="csv" rows="6" placeholder="nom;entreprise;email;date de diffusion;package">' + esc(S.importCsv) + '</textarea></label>' +
      '<div><button class="btn secondary" type="submit"' + (S.busy ? ' disabled' : '') + '>Vérifier le fichier</button></div></form></div>' + preview;
  }

  function readClientForm(f) {
    return {
      name: f.name.value, company: f.company.value, email: f.email.value,
      broadcastDate: f.broadcastDate.value, packageLabel: f.packageLabel.value, notes: f.notes.value,
    };
  }

  function readFileText(input) {
    var file = input && input.files && input.files[0];
    if (!file) return Promise.resolve(null);
    if (file.size > 2 * 1024 * 1024) return Promise.reject(new Error('Fichier trop lourd (2 Mo maximum).'));
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var text = String(r.result || '');
        // Excel enregistre souvent en Windows-1252 : si l'UTF-8 est illisible, on relit dans cet encodage
        if (text.indexOf('�') !== -1) {
          var r2 = new FileReader();
          r2.onload = function () { resolve(String(r2.result || '')); };
          r2.onerror = function () { resolve(text); };
          r2.readAsText(file, 'windows-1252');
        } else resolve(text);
      };
      r.onerror = function () { reject(new Error('Lecture du fichier impossible.')); };
      r.readAsText(file, 'utf-8');
    });
  }

  /* ------------------------------------------------------------ Rendu et chargements */

  // Les champs saisis survivent à un nouvel affichage (erreur, chargement), sauf les mots de passe et les codes.
  function snapshotFields() {
    var saved = {};
    app.querySelectorAll('form[data-form] input[name], form[data-form] select[name]').forEach(function (el) {
      if (el.type === 'password' || el.classList.contains('code')) return;
      saved[el.form.dataset.form + '|' + el.name] = el.value;
    });
    return saved;
  }
  function restoreFields(saved) {
    app.querySelectorAll('form[data-form] input[name], form[data-form] select[name]').forEach(function (el) {
      var k = el.form.dataset.form + '|' + el.name;
      if (Object.prototype.hasOwnProperty.call(saved, k)) el.value = saved[k];
    });
  }

  function render(keepFields) {
    var saved = keepFields === false ? {} : snapshotFields();
    var active = document.activeElement;
    var focus = active && active.form && active.form.dataset.form && active.name
      ? { form: active.form.dataset.form, name: active.name, pos: typeof active.selectionStart === 'number' ? active.selectionStart : null } : null;
    var views = { login: viewLogin, code: viewCode, invite: viewInvite, 'invite-key': viewInviteKey, app: viewApp };
    app.innerHTML = S.view === 'loading' ? '<div class="auth"><div class="auth-card">' + brand() + '<p class="muted">Chargement…</p></div></div>'
      : S.view === 'error' ? '<div class="auth"><div class="auth-card">' + brand() + errorBox() + '<p class="mt"><a href="./">Revenir à la connexion</a></p></div></div>'
        : views[S.view]();
    restoreFields(saved);
    if (focus) {
      var el = app.querySelector('form[data-form="' + focus.form + '"] [name="' + focus.name + '"]');
      if (el) { el.focus(); if (focus.pos !== null && el.setSelectionRange && el.type !== 'email' && el.type !== 'date') { try { el.setSelectionRange(focus.pos, focus.pos); } catch (e) { /* type sans curseur */ } } }
      return;
    }
    var first = app.querySelector('input:not([readonly])');
    if (first && S.view !== 'app') first.focus();
  }

  function loadPage() {
    S.error = '';
    if (S.page === 'clients') loadClients();
    if (S.page === 'equipe' && isSuper()) {
      api('GET', '/admin/team').then(function (d) { S.team = d.users; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'journal' && isSuper()) {
      S.audit = null;
      api('GET', '/admin/audit?limit=200').then(function (d) { S.audit = d.entries; render(); }).catch(function (e) { S.error = e.message; S.audit = []; render(); });
    }
    render();
  }

  function readHash() {
    var h = (location.hash || '#accueil').slice(1).split('/');
    S.page = h[0] || 'accueil';
    S.sub = decodeURIComponent(h.slice(1).join('/') || '');
  }

  function enterApp(user) {
    S.user = user;
    S.view = 'app';
    S.error = '';
    readHash();
    loadPage();
  }

  window.addEventListener('hashchange', function () {
    if (S.view !== 'app') return;
    readHash();
    S.lastLink = null;
    S.clientLink = null;
    S.error = '';
    loadPage();
  });

  /* ------------------------------------------------------------ Formulaires */

  function withBusy(promise) {
    S.busy = true; S.error = ''; render();
    return promise.catch(function (e) { S.error = e.message; }).then(function () { S.busy = false; render(); });
  }

  var FORMS = {
    login: function (f) {
      return api('POST', '/admin/auth/login', { username: f.username.value, password: f.password.value }, '-')
        .then(function (d) {
          if (d.user) { setToken(d.token); return enterApp(d.user); } // double authentification désactivée
          S.pendingToken = d.token; S.view = 'code';
        });
    },
    code: function (f) {
      return api('POST', '/admin/auth/code', { code: f.code.value }, S.pendingToken)
        .then(function (d) { S.pendingToken = null; setToken(d.token); enterApp(d.user); })
        .catch(function (e) { if (e.status === 401 && /expirée/.test(e.message)) S.view = 'login'; throw e; });
    },
    'invite-start': function (f) {
      if (f.password.value !== f.confirm.value) return Promise.reject(new Error('Les deux mots de passe ne sont pas identiques.'));
      return api('POST', '/admin/auth/invite/start', { token: S.invite.token, password: f.password.value }, '-')
        .then(function (d) {
          if (d.user) { // double authentification désactivée : compte activé
            setToken(d.token);
            history.replaceState(null, '', location.pathname);
            S.invite = null;
            enterApp(d.user);
            return toast('Compte activé. Bienvenue !');
          }
          S.invite.secret = d.secret; S.invite.uri = d.uri; S.view = 'invite-key';
        });
    },
    'invite-finish': function (f) {
      return api('POST', '/admin/auth/invite/finish', { token: S.invite.token, code: f.code.value }, '-')
        .then(function (d) {
          setToken(d.token);
          history.replaceState(null, '', location.pathname); // le lien d'invitation ne sert plus
          S.invite = null;
          enterApp(d.user);
          toast('Compte activé. Bienvenue !');
        });
    },
    'client-filter': function () { return Promise.resolve(); },
    'client-new': function (f) {
      return api('POST', '/admin/clients', readClientForm(f)).then(function (d) {
        S.client = null;
        location.hash = '#clients/' + d.client.id;
        toast('Client créé');
      });
    },
    'client-edit': function (f) {
      return api('POST', '/admin/clients/' + encodeURIComponent(S.client.client.id), readClientForm(f)).then(function () {
        toast('Modifications enregistrées');
        return loadClients();
      });
    },
    'import-preview': function (f) {
      return readFileText(f.file).then(function (fromFile) {
        var csv = fromFile !== null ? fromFile : f.csv.value;
        if (!csv.trim()) throw new Error('Choisissez un fichier CSV ou collez son contenu.');
        S.importCsv = csv;
        S.importPreview = null;
        return api('POST', '/admin/clients/import/preview', { csv: csv });
      }).then(function (d) { S.importPreview = d; });
    },
    'team-add': function (f) {
      var name = f.name.value.trim();
      return api('POST', '/admin/team', { name: name, email: f.email.value, username: f.username.value.trim() || undefined, role: f.role.value })
        .then(function (d) {
          S.lastLink = { name: d.user.name, username: d.user.username, url: d.inviteLink };
          f.reset();
          return api('GET', '/admin/team');
        })
        .then(function (d) { S.team = d.users; });
    },
  };

  app.addEventListener('input', function (ev) {
    var f = ev.target.form;
    if (!f || f.dataset.form !== 'client-filter') return;
    S.clientFilter = { q: f.q.value, status: f.status.value };
    render();
  });

  app.addEventListener('submit', function (ev) {
    var f = ev.target.closest('form[data-form]');
    if (!f) return;
    ev.preventDefault();
    if (S.busy) return;
    withBusy(FORMS[f.dataset.form](f));
  });

  /* ------------------------------------------------------------ Boutons */

  function teamAction(path, confirmText, after) {
    return function (id) {
      var u = (S.team || []).filter(function (x) { return x.id === id; })[0];
      if (!u || !window.confirm(confirmText.replace('{nom}', u.name))) return;
      withBusy(api('POST', '/admin/team/' + encodeURIComponent(id) + path).then(function (d) {
        if (d.inviteLink) S.lastLink = { name: d.user.name, username: d.user.username, url: d.inviteLink };
        if (after) toast(after.replace('{nom}', d.user.name));
        return api('GET', '/admin/team');
      }).then(function (d) { S.team = d.users; }));
    };
  }

  var ACTIONS_UI = {
    'to-login': function () { S.pendingToken = null; S.view = 'login'; S.error = ''; render(); },
    logout: function () {
      api('POST', '/admin/auth/logout').catch(function () {}).then(function () {
        setToken(null); S.user = null; S.team = null; S.audit = null; S.view = 'login';
        history.replaceState(null, '', location.pathname); // la prochaine connexion repart de l'accueil
        render();
      });
    },
    reset: teamAction('/reset', 'Réinitialiser l’accès de {nom} ? Son mot de passe et sa double authentification seront effacés, et il devra activer à nouveau son compte avec un nouveau lien.', null),
    disable: teamAction('/disable', 'Désactiver le compte de {nom} ? Il ne pourra plus se connecter.', 'Compte de {nom} désactivé'),
    enable: teamAction('/enable', 'Réactiver le compte de {nom} ?', 'Compte de {nom} réactivé'),
    'copy-link': function () {
      var input = app.querySelector('.linkbox input');
      if (!input) return;
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject())
        .then(function () { toast('Lien copié'); }, function () { input.select(); toast('Sélectionnez le lien et copiez-le (Ctrl+C)'); });
    },
    'reload-audit': function () { loadPage(); },
    'client-send': function () {
      var c = S.client.client;
      var replacing = c.access.code === 'sent' || c.access.code === 'manual';
      if (replacing && !window.confirm('Un nouveau lien va être envoyé à ' + c.email + '. Le lien actuel cessera de fonctionner. Continuer ?')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/send').then(function (d) {
        toast(d.redirectedTo ? 'Lien envoyé (mode test : à ' + d.redirectedTo + ')' : 'Lien envoyé à ' + c.email);
        return loadClients();
      }, function (e) {
        // L'échec est enregistré sur la fiche : on la recharge pour l'afficher, puis on montre l'erreur
        return loadClients().then(function () { throw e; });
      }));
    },
    'client-link': function () {
      var c = S.client.client;
      var replacing = c.access.code === 'sent' || c.access.code === 'manual';
      if (replacing && !window.confirm('Créer un nouveau lien ? Le lien actuel du client cessera de fonctionner.')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/link').then(function (d) {
        S.clientLink = { id: c.id, url: d.link };
        return loadClients();
      }));
    },
    'client-revoke': function () {
      var c = S.client.client;
      if (!window.confirm('Couper l’accès de ' + c.name + ' ? Son lien actuel cessera immédiatement de fonctionner.')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/revoke').then(function () {
        S.clientLink = null;
        toast('Accès coupé');
        return loadClients();
      }));
    },
    'import-confirm': function () {
      withBusy(api('POST', '/admin/clients/import', { csv: S.importCsv }).then(function (d) {
        S.importPreview = null;
        S.importCsv = '';
        S.clients = null;
        toast(d.created + ' client' + (d.created > 1 ? 's' : '') + ' importé' + (d.created > 1 ? 's' : ''));
        location.hash = '#clients';
      }));
    },
  };

  app.addEventListener('click', function (ev) {
    var row = ev.target.closest('tr[data-href]');
    if (row && !ev.target.closest('a,button,input,select,textarea')) { location.hash = row.dataset.href; return; }
    var b = ev.target.closest('[data-a]');
    if (!b) return;
    ev.preventDefault();
    var fn = ACTIONS_UI[b.dataset.a];
    if (fn) fn(b.dataset.id);
  });

  /* ------------------------------------------------------------ Démarrage */

  function start() {
    if (!API) { S.view = 'error'; S.error = 'Adresse du serveur absente : renseignez API_URL dans config.js.'; return render(); }
    var params = new URLSearchParams(location.search);
    var invite = params.get('invite');
    if (invite) {
      render();
      return api('GET', '/admin/auth/invite?token=' + encodeURIComponent(invite), null, '-')
        .then(function (d) { S.invite = { token: invite, email: d.email, username: d.username, name: d.name, role: d.role, twoFactor: d.twoFactor }; S.view = 'invite'; render(); })
        .catch(function (e) { S.view = 'error'; S.error = e.message; render(); });
    }
    if (!getToken()) { S.view = 'login'; return render(); }
    render();
    api('GET', '/admin/auth/me')
      .then(function (d) { enterApp(d.user); })
      .catch(function () { setToken(null); S.view = 'login'; render(); });
  }

  start();
}());
