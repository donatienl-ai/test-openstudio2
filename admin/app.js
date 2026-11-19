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
    upload: null,           // dépôt de vidéo en cours : { clientId, name, pct }
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
    var d = S.dash;
    var head = '<div class="head"><div><h1>Bonjour ' + esc(S.user.name) + '</h1><p class="muted">Activité de la plateforme.</p></div>' +
      '<button class="btn secondary" type="button" data-a="reload-dash">Actualiser</button></div>';
    if (!d) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var a = d.accounts;
    var p = d.payments;
    var tile = function (label, value, sub, tone, href) {
      return '<' + (href ? 'a href="' + href + '"' : 'div') + ' class="tile ' + (tone || '') + '"><span class="tile-l">' + esc(label) + '</span><b class="tile-v">' + esc(value) + '</b>' +
        (sub ? '<span class="tile-s">' + esc(sub) + '</span>' : '') + '</' + (href ? 'a' : 'div') + '>';
    };
    var tiles = '<div class="tiles">' +
      tile('Comptes actifs', a.active, a.everConnected + ' se sont déjà connectés, sur ' + a.total + ' clients', '', '#clients') +
      tile('Connectés aujourd’hui', a.connectedToday, a.returningToday ? a.returningToday + ' revenus (déjà venus un autre jour)' : 'aucun retour aujourd’hui', '') +
      tile('Paiements reçus · 30 jours', p.paid, euros(p.paid_cents) + ' TTC', 'ok') +
      tile('Paiements en échec · 30 jours', p.failed, p.awaiting + ' en attente de paiement', p.failed ? 'err' : '') +
      '</div>';
    var max = Math.max.apply(null, a.days.map(function (x) { return x.connected; }).concat([1]));
    var week = '<div class="card"><h2>Connexions des 7 derniers jours</h2><p class="small muted">Un client compte une fois par jour. En foncé : les clients qui reviennent (déjà venus un jour précédent).</p><div class="bars">' +
      a.days.map(function (x) {
        var h = Math.round((x.connected / max) * 100);
        var r = x.connected ? Math.round((x.returning / x.connected) * 100) : 0;
        return '<div class="bar-col" title="' + esc(fmtDay(x.day) + ' : ' + x.connected + ' connecté(s), dont ' + x.returning + ' revenu(s)') + '">' +
          '<span class="bar-n">' + esc(x.connected) + '</span><div class="bar-track"><div class="bar-fill" data-h="' + h + '"><div class="bar-ret" data-h="' + r + '"></div></div></div>' +
          '<span class="bar-d">' + esc(fmtDay(x.day).replace(/ \d{4}$/, '')) + '</span></div>';
      }).join('') + '</div></div>';
    var fails = p.failures.length ? '<table><thead><tr><th>Date</th><th>Client</th><th>Objet</th><th>Raison donnée par la banque</th><th>État</th></tr></thead><tbody>' + p.failures.map(function (f) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(f.payment_failed_at)) + '</td><td>' + (f.client_id ? '<a href="#clients/' + esc(f.client_id) + '"><b>' + esc(f.client_name) + '</b></a>' : esc(f.company || 'Non rattaché')) +
        '</td><td class="small">' + esc(f.offer_title) + (f.payment_failures > 1 ? ' <span class="muted">(' + esc(f.payment_failures) + ' essais)</span>' : '') + '</td><td class="small">' + esc(f.last_payment_error) +
        '</td><td>' + tag(MONTAGE_STATUS[f.status], f.status) + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun paiement en échec ces 30 derniers jours.');
    var alerts = [];
    if (p.unattached) alerts.push(p.unattached + ' paiement' + (p.unattached > 1 ? 's' : '') + ' reçu' + (p.unattached > 1 ? 's' : '') + ' sans client rattaché (demande faite hors espace client, e-mail inconnu).');
    if (d.accessEmailFailures7d) alerts.push(d.accessEmailFailures7d + ' envoi' + (d.accessEmailFailures7d > 1 ? 's' : '') + ' de code d’accès en échec ces 7 derniers jours (voir les fiches concernées).');
    if (p.to_quote) alerts.push(p.to_quote + ' demande' + (p.to_quote > 1 ? 's' : '') + ' de montage à chiffrer.');
    return head + errorBox() + tiles + (alerts.length ? '<div class="warn mb">' + alerts.map(esc).join('<br>') + '</div>' : '') +
      week + section('Paiements en échec', p.failures.length, fails);
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
    acces_envoye: 'Code d’accès envoyé',
    acces_envoye_auto: 'Code d’accès envoyé automatiquement',
    acces_echec_envoi: 'Échec d’envoi du code d’accès',
    acces_lien_cree: 'Code d’accès généré à la main',
    client_connexion: 'Connexion du client avec son code',
    acces_retabli: 'Accès rétabli',
    acces_coupe: 'Accès coupé',
    marketing_reponse: 'Réponse sur les campagnes marketing',
  };

  var FIELD_NAMES = {
    name: 'nom', company: 'entreprise', email: 'e-mail', broadcastDate: 'date de diffusion', packageLabel: 'package',
    notes: 'notes', logoKey: 'logo', sector: 'secteur', marketingOptin: 'consentement marketing', marketingOptinSource: 'origine du consentement',
  };

  function describe(e) {
    var d = e.detail || {};
    if (d.identifiant && !d.email) return d.identifiant + (d.motif ? ' — ' + d.motif : '');
    if (d.email) return d.email + (d.role ? ' (' + (d.role === 'super_admin' ? 'super admin' : 'admin') + ')' : '') + (d.motif ? ' — ' + d.motif : '');
    if (d.marketing && !d.champs) return d.marketing === 'oui' ? 'accepte d’être contacté' : 'refuse d’être contacté';
    if (d.title && d.programme) return d.title + ' (' + d.programme + ')';
    if (d.name) return d.name;
    if (d.title) return d.title;
    if (d.champs) return 'Modifié : ' + d.champs.map(function (k) { return FIELD_NAMES[k] || k; }).join(', ') + (d.marketing ? ' (marketing : ' + d.marketing + ')' : '');
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
    scheduled: 'wait', sent: 'ok', failed: 'err', revoked: 'off', no_email: 'wait', no_date: 'wait', no_video: 'wait',
  };
  var ACCESS_FILTERS = [
    ['', 'Tous les accès'],
    ['scheduled', 'Envoi programmé'],
    ['sent', 'Code envoyé'],
    ['no_video', 'En attente de la vidéo'],
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
    if (!m.clientSiteConfigured) return '<div class="error mb">Adresse de l’espace client non configurée sur le serveur (CLIENT_SITE_URL) : aucun code d’accès ne peut être envoyé.</div>';
    if (!m.ready) return '<div class="warn mb"><b>Les codes ne partiront pas automatiquement.</b> ' + esc(m.problem) + '</div>';
    if (m.redirectTo) return '<div class="note mb"><b>Mode test :</b> tous les e-mails partent vers ' + esc(m.redirectTo) + ', pas vers les clients.</div>';
    return '';
  }

  function loadClients() {
    if (S.sub && S.sub !== 'nouveau' && S.sub !== 'import') {
      if (!S.client || S.client.client.id !== S.sub) S.client = null;
      var wanted = S.sub;
      // Une réponse arrivée après un changement de page est ignorée : elle ne doit jamais remplacer la fiche affichée
      return api('GET', '/admin/clients/' + encodeURIComponent(wanted))
        .then(function (d) { if (S.page !== 'clients' || S.sub !== wanted) return; S.client = d; S.mail = d.mail; render(); })
        .catch(function (e) { if (S.page !== 'clients' || S.sub !== wanted) return; S.error = e.message; S.client = { missing: true }; render(); });
    }
    if (!S.sub) {
      return api('GET', '/admin/clients')
        .then(function (d) { if (S.page !== 'clients' || S.sub) return; S.clients = d.clients; S.mail = d.mail; render(); })
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
    return '<div class="head"><div><h1>Clients</h1><p class="muted">Le code d’accès de chaque client part automatiquement par e-mail le jour de la diffusion de sa vidéo, à partir de ' +
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
      '<label>E-mail<input name="email" type="email" maxlength="200" value="' + esc(c.email) + '" placeholder="Le code d’accès sera envoyé à cette adresse"></label>' +
      '<label>Date de diffusion prévue<input name="broadcastDate" type="date" value="' + esc(c.broadcastDate || '') + '"></label>' +
      '<label>Package<input name="packageLabel" maxlength="200" value="' + esc(c.packageLabel) + '" placeholder="Ex. BFM Business + immersion"></label>' +
      '<label class="wide">Notes internes <span class="muted">(jamais visibles par le client)</span><textarea name="notes" rows="3" maxlength="2000">' + esc(c.notes) + '</textarea></label>';
  }

  function pageClientNew() {
    return '<p><a href="#clients">← Tous les clients</a></p><div class="head"><div><h1>Nouveau client</h1>' +
      '<p class="muted">Avec un e-mail et une date de diffusion, son lien d’accès partira automatiquement ce jour-là.</p></div></div>' +
      '<div class="card"><form data-form="client-new" class="form-2" novalidate>' + errorBox() + clientFields() +
      '<div class="wide"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Créer le client</button></div></form></div>';
  }

  var ORDER_TYPES = { capsules: 'Capsules', subtitles: 'Interview sous-titrée', visuels: 'Visuels', publications: 'Publications', photo: 'Photo' };
  var ORDER_STATUS = {
    draft: ['Brouillon', 'off'], validated: ['Validée', 'info'], paid: ['Payée', 'info'], submitting: ['En fabrication', 'wait'],
    processing: ['En fabrication', 'wait'], postprocessing: ['En finition', 'wait'], ready: ['Prête', 'ok'], error: ['Erreur', 'err'],
  };
  var MONTAGE_STATUS = { awaiting_payment: ['En attente de paiement', 'wait'], paid: ['Payée', 'ok'], to_quote: ['Devis à faire', 'info'], cancelled: ['Annulée', 'off'] };
  var PUB_STATUS = {
    submitting: ['Envoi', 'wait'], scheduled: ['Programmée', 'info'], in_progress: ['En cours', 'wait'], published: ['Publiée', 'ok'],
    partial: ['En partie publiée', 'wait'], failed: ['Échec', 'err'],
  };
  function tag(pair, fallback) { var p = pair || [fallback, 'off']; return '<span class="tag ' + p[1] + '">' + esc(p[0]) + '</span>'; }
  function euros(cents) { return cents == null ? '—' : (cents / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' }); }
  function section(title, count, inner) {
    return '<div class="card"><h2>' + esc(title) + (count !== null && count !== undefined ? ' <span class="count">' + esc(count) + '</span>' : '') + '</h2>' + inner + '</div>';
  }
  function emptyLine(text) { return '<p class="muted small">' + esc(text) + '</p>'; }

  function marketingLine(c) {
    var m = c.marketing || {};
    var answer = m.optin === true ? '<span class="tag ok">Accepte</span>' : m.optin === false ? '<span class="tag off">Refuse</span>' : '<span class="tag wait">Pas encore répondu</span>';
    var detail = m.optin === null || m.optin === undefined
      ? 'La question lui sera posée dans son espace, à sa première connexion.'
      : 'Réponse donnée le ' + fmtDate(m.at) + (m.source ? ' (' + m.source.toLowerCase() + ')' : '') + '.';
    return '<div class="sub"><h3>Campagnes marketing</h3><p>' + answer + '</p><p class="small muted">' + esc(detail) + '</p></div>';
  }

  function pageClientDetail() {
    var d = S.client;
    if (!d) return '<p><a href="#clients">← Tous les clients</a></p><div class="card empty">Chargement…</div>';
    if (d.missing) return '<p><a href="#clients">← Tous les clients</a></p>' + errorBox();
    var c = d.client;
    var a = c.access;
    var mailLine = {
      scheduled: 'Le code partira par e-mail le ' + fmtDay(a.day) + ' à ' + a.hour + ' h, jour de diffusion de la vidéo.',
      sent: 'Code envoyé par e-mail le ' + fmtDate(a.at) + '.',
      failed: 'Envoi du code par e-mail en échec : ' + (a.error || '') + '.',
      no_email: 'Ajoutez l’e-mail du client pour que ce code lui parte automatiquement.',
      no_video: 'Le code partira par e-mail le jour de diffusion de la vidéo, une fois celle-ci déposée.',
      no_date: 'Indiquez la date de diffusion de la vidéo pour programmer l’envoi du code par e-mail.',
    }[a.code] || '';

    var emails = d.emails.length ? '<table class="compact"><tbody>' + d.emails.map(function (m) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(m.created_at)) + '</td><td class="small">' + esc(m.subject || 'E-mail') +
        (m.automatic ? ' <span class="muted">(automatique)</span>' : '') +
        (m.redirected_to ? '<br><span class="muted">Mode test : reçu par ' + esc(m.redirected_to) + '</span>' : '') +
        (m.error ? '<br><span class="muted">' + esc(m.error) + '</span>' : '') + '</td><td>' +
        (m.status === 'envoye' ? '<span class="tag ok">Envoyé</span>' : '<span class="tag err">Échec</span>') + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun e-mail envoyé à ce client pour le moment.');

    var contents = d.contents.length ? '<table><thead><tr><th>Date</th><th>Contenu</th><th>Émission</th><th>Fichiers</th><th>État</th></tr></thead><tbody>' + d.contents.map(function (o) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(o.created_at)) + '</td><td>' + esc(ORDER_TYPES[o.type] || o.type) + '</td><td class="small">' + esc(o.programme || '—') +
        '</td><td class="small">' + esc(o.files || 0) + '</td><td>' + tag(ORDER_STATUS[o.status], o.status) + (o.error ? '<br><span class="small muted">' + esc(o.error) + '</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Le client n’a encore généré aucun contenu.');
    var pubs = d.publications.length ? '<h3>Publications sur les réseaux</h3><table class="compact"><tbody>' + d.publications.map(function (p) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(p.scheduled_at || p.created_at)) + '</td><td class="small">' + esc(p.video_title || 'Vidéo') +
        ' <span class="muted">· ' + esc((p.platforms || []).join(', ')) + '</span></td><td>' + tag(PUB_STATUS[p.status], p.status) + '</td></tr>';
    }).join('') + '</tbody></table>' : '';

    var payments = (d.payments.length ? '<table><thead><tr><th>Date</th><th>Objet</th><th>Montant TTC</th><th>État</th></tr></thead><tbody>' + d.payments.map(function (p) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(p.paid_at || p.created_at)) + '</td><td>Montage sur mesure · ' + esc(p.offer_title) + '</td><td class="nowrap">' + esc(euros(p.amount_ttc_cents)) +
        '</td><td>' + (p.status !== 'paid' && p.payment_failures
          ? '<span class="tag err">Échec de paiement</span><br><span class="small muted">' + esc(p.last_payment_error) + (p.payment_failures > 1 ? ' (' + p.payment_failures + ' essais)' : '') + '</span>'
          : p.status === 'paid' && p.has_invoice
          ? '<button class="tag ok linkish" type="button" data-a="payment-invoice" data-id="' + esc(p.id) + '" title="Voir la facture">Payée · voir la facture</button>'
          : tag(MONTAGE_STATUS[p.status], p.status)) + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun paiement pour le moment.')) +
      '<p class="small muted mt">Les factures (Pennylane) et les recharges de crédits s’ajouteront ici avec le lot 6.</p>';

    var history = d.history.length ? '<table class="compact"><tbody>' + d.history.map(function (e) {
      return '<tr><td class="small nowrap">' + esc(fmtDate(e.at)) + '</td><td class="small">' + esc(e.actor_label) + '</td><td class="small">' + esc(ACTIONS[e.action] || e.action) +
        (describe(e) ? ' <span class="muted">— ' + esc(describe(e)) + '</span>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucune action enregistrée.');

    var subtitle = [c.company !== c.name ? c.company : null, c.packageLabel, c.email].filter(Boolean).join(' · ') || 'Client';
    return '<p><a href="#clients">← Tous les clients</a></p><div class="head"><div><h1>' + esc(c.name) + '</h1><p class="muted">' + esc(subtitle) + '</p></div></div>' +
      mailBanner(d.mail) + errorBox() +
      '<div class="cols"><div class="card"><h2>Informations</h2><form data-form="client-edit" class="form-2" novalidate>' + clientFields(c) +
      '<div class="wide"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Enregistrer</button></div></form></div>' +
      '<div><div class="card"><h2>Accès à l’espace client</h2>' +
      (d.accessCode ? '<div class="codebox' + (a.code === 'revoked' ? ' off' : '') + '"><span class="small muted">Code de connexion</span><b class="access-code">' + esc(d.accessCode) + '</b>' +
        '<button class="btn small secondary" type="button" data-a="copy-code">Copier</button></div>' : '<p class="small muted">Code en cours de création…</p>') +
      (a.code === 'revoked'
        ? '<p class="mt"><span class="tag off">Accès coupé</span> <span class="small muted">depuis le ' + esc(fmtDate(a.at)) + ' : le code ne permet plus de se connecter.</span></p>' +
          '<div class="btns left"><button class="btn" type="button" data-a="client-restore"' + (S.busy ? ' disabled' : '') + '>Rétablir l’accès</button></div>'
        : '<p class="small muted mt">' + esc(mailLine) + '</p>' +
          '<div class="btns left"><button class="btn danger" type="button" data-a="client-revoke"' + (S.busy ? ' disabled' : '') + '>Couper l’accès</button></div>') +
      marketingLine(c) + '</div>' +
      section('E-mails envoyés', d.emails.length, emails) + '</div></div>' +
      videoCard(d) +
      section('Contenus générés', d.contents.length, contents + pubs) +
      section('Paiements et factures', d.payments.length, payments) +
      section('Historique des actions sur la fiche', null, history);
  }

  function fmtDuration(sec) {
    if (!sec) return '';
    var s = Math.round(sec);
    return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0');
  }

  function videoCard(d) {
    var c = d.client;
    var up = S.upload && S.upload.clientId === c.id ? S.upload : null;
    var active = d.videos.filter(function (v) { return v.active; });
    var list = d.videos.length ? '<table><thead><tr><th>Émission</th><th>Diffusion</th><th>Durée</th><th>Espace client</th><th></th></tr></thead><tbody>' + d.videos.map(function (v) {
      return '<tr class="' + (v.active ? '' : 'retired') + '"><td><b>' + esc(v.title) + '</b><br><span class="small muted">' + esc(v.programmeTitle) + ' · ajoutée le ' + esc(fmtDate(v.createdAt)) + '</span></td>' +
        '<td class="small nowrap">' + esc(fmtDay(v.broadcastDate)) + '</td><td class="small nowrap">' + esc(fmtDuration(v.durationSec) || '—') + '</td>' +
        '<td>' + (v.active ? '<span class="tag ok">Visible</span>' : '<span class="tag off">Retirée</span>') + '</td>' +
        '<td class="actions">' + (v.active ? '<button class="btn small secondary" type="button" data-a="video-preview" data-id="' + esc(v.id) + '">Voir</button>' +
        '<button class="btn small danger" type="button" data-a="video-remove" data-id="' + esc(v.id) + '">Retirer</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted small">Aucune émission pour le moment : le code d’accès partira dès qu’une vidéo sera déposée.</p>';
    var options = (d.programmes || []).map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.title) + '</option>'; }).join('');
    var form = up
      ? '<div class="upload"><p class="small"><b>Envoi de ' + esc(up.name) + '</b> — ne fermez pas cette page.</p>' +
        '<div class="bar"><i id="upload-bar"></i></div><p class="small muted" id="upload-pct">' + up.pct + ' %</p></div>'
      : '<form data-form="video-add" class="form-2 mt" novalidate>' +
        '<label class="wide">Fichier vidéo <span class="muted">(MP4, MOV… telle que reçue de la chaîne)</span><input name="file" type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv" required></label>' +
        '<label>Émission<select name="programmeId">' + options + '</select></label>' +
        '<label>Date de diffusion <span class="muted">(déclenche l’envoi du code)</span><input name="broadcastDate" type="date" required value="' + esc(c.broadcastDate || '') + '"></label>' +
        '<label class="wide">Titre affiché au client <span class="muted">(facultatif : « Émission — date » par défaut)</span><input name="title" maxlength="200"></label>' +
        '<div class="wide"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Déposer la vidéo</button></div></form>';
    return '<div class="card"><h2>Émissions du client <span class="count">' + esc(active.length) + '</span></h2>' + list +
      '<h2 class="mt">Ajouter une vidéo</h2>' + form + '</div>';
  }

  /** Durée de la vidéo lue dans le navigateur (sans l'envoyer), ou null. */
  function videoDuration(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var url = URL.createObjectURL(file);
      var done = function (val) { URL.revokeObjectURL(url); resolve(val); };
      var t = setTimeout(function () { done(null); }, 8000);
      v.preload = 'metadata';
      v.onloadedmetadata = function () { clearTimeout(t); done(isFinite(v.duration) ? v.duration : null); };
      v.onerror = function () { clearTimeout(t); done(null); };
      v.src = url;
    });
  }

  /** Envoi direct navigateur → stockage, avec progression. */
  function putFile(url, file, headers, onProgress) {
    return new Promise(function (resolve, reject) {
      var x = new XMLHttpRequest();
      x.open('PUT', url);
      Object.keys(headers || {}).forEach(function (k) { x.setRequestHeader(k, headers[k]); });
      x.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(Math.floor((e.loaded / e.total) * 100)); };
      x.onload = function () { x.status >= 200 && x.status < 300 ? resolve() : reject(new Error('Le stockage a refusé le fichier (erreur ' + x.status + ').')); };
      x.onerror = function () { reject(new Error('Envoi interrompu : vérifiez votre connexion. Si le problème persiste, la règle CORS du stockage n’autorise peut-être pas encore le back-office (redémarrez le serveur).')); };
      x.send(file);
    });
  }

  function setUploadPct(pct) {
    if (!S.upload) return;
    S.upload.pct = pct;
    var bar = document.getElementById('upload-bar');
    var txt = document.getElementById('upload-pct');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = pct + ' %';
  }

  window.addEventListener('beforeunload', function (e) {
    if (S.upload) { e.preventDefault(); e.returnValue = ''; }
  });

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
      if (el.type === 'password' || el.type === 'file' || el.classList.contains('code')) return;
      saved[el.form.dataset.form + '|' + el.name] = el.value;
    });
    return saved;
  }
  function restoreFields(saved) {
    app.querySelectorAll('form[data-form] input[name], form[data-form] select[name]').forEach(function (el) {
      var k = el.form.dataset.form + '|' + el.name;
      if (el.type !== 'file' && Object.prototype.hasOwnProperty.call(saved, k)) el.value = saved[k];
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
    app.querySelectorAll('[data-h]').forEach(function (el) { el.style.height = el.dataset.h + '%'; });
    var bar = document.getElementById('upload-bar');
    if (bar) bar.style.width = (S.upload ? S.upload.pct : 0) + '%';
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
    if (S.page === 'accueil') loadDashboard();
    if (S.page === 'equipe' && isSuper()) {
      api('GET', '/admin/team').then(function (d) { S.team = d.users; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'journal' && isSuper()) {
      S.audit = null;
      api('GET', '/admin/audit?limit=200').then(function (d) { S.audit = d.entries; render(); }).catch(function (e) { S.error = e.message; S.audit = []; render(); });
    }
    render();
  }

  function loadDashboard() {
    return api('GET', '/admin/dashboard').then(function (d) { S.dash = d; render(); }).catch(function (e) { S.error = e.message; render(); });
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
    'video-add': function (f) {
      var file = f.file.files && f.file.files[0];
      if (!file) return Promise.reject(new Error('Choisissez le fichier vidéo.'));
      var c = S.client.client;
      var programmeId = f.programmeId.value;
      var programme = (S.client.programmes || []).filter(function (p) { return p.id === programmeId; })[0];
      var date = f.broadcastDate.value;
      if (!date) return Promise.reject(new Error('Indiquez la date de diffusion de l’émission : c’est elle qui déclenche l’envoi du code au client.'));
      var title = f.title.value.trim() || ((programme ? programme.title : 'Émission') + (date ? ' — ' + fmtDay(date) : ''));
      var key;
      var duration;
      return videoDuration(file).then(function (sec) {
        duration = sec;
        return api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/videos/upload', { fileName: file.name, contentType: file.type || 'video/mp4' });
      }).then(function (u) {
        key = u.key;
        S.upload = { clientId: c.id, name: file.name, pct: 0 };
        render();
        return putFile(u.uploadUrl, file, u.headers, setUploadPct);
      }).then(function () {
        return api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/videos', {
          programmeId: programmeId, title: title, sourceKey: key, broadcastDate: date || null, durationSec: duration,
        });
      }).then(function () {
        S.upload = null;
        toast('Vidéo ajoutée : le client la voit dans son espace');
        return loadClients();
      }, function (e) {
        S.upload = null;
        throw e;
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
    'copy-code': function () {
      var el = app.querySelector('.access-code');
      if (!el) return;
      (navigator.clipboard ? navigator.clipboard.writeText(el.textContent) : Promise.reject()).then(function () { toast('Code copié'); }, function () { toast('Sélectionnez le code et copiez-le'); });
    },
    'copy-link': function () {
      var input = app.querySelector('.linkbox input');
      if (!input) return;
      (navigator.clipboard ? navigator.clipboard.writeText(input.value) : Promise.reject())
        .then(function () { toast('Lien copié'); }, function () { input.select(); toast('Sélectionnez le lien et copiez-le (Ctrl+C)'); });
    },
    'reload-audit': function () { loadPage(); },
    'reload-dash': function () { S.dash = null; loadPage(); },
    'client-restore': function () {
      var c = S.client.client;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/restore').then(function () {
        toast('Accès rétabli : le même code fonctionne à nouveau');
        return loadClients();
      }));
    },
    'client-revoke': function () {
      var c = S.client.client;
      if (!window.confirm('Couper l’accès de ' + c.name + ' ? Son code ne fonctionnera plus et il sera déconnecté de tous ses appareils. Vous pourrez le rétablir.')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/revoke').then(function () {
        S.clientLink = null;
        toast('Accès coupé');
        return loadClients();
      }));
    },
    'payment-invoice': function (id) {
      var w = window.open('', '_blank');
      api('GET', '/admin/clients/' + encodeURIComponent(S.client.client.id) + '/payments/' + encodeURIComponent(id) + '/invoice')
        .then(function (d) {
          if (w) w.location = d.url; else window.location.href = d.url;
          if (d.kind === 'recu') toast('Paiement antérieur aux factures : reçu de paiement Stripe affiché');
        })
        .catch(function (e) { if (w) w.close(); S.error = e.message; render(); window.scrollTo(0, 0); });
    },
    'video-preview': function (id) {
      var w = window.open('', '_blank');
      api('GET', '/admin/clients/' + encodeURIComponent(S.client.client.id) + '/videos/' + encodeURIComponent(id) + '/preview')
        .then(function (d) { if (w) w.location = d.url; else window.location.href = d.url; })
        .catch(function (e) { if (w) w.close(); S.error = e.message; render(); });
    },
    'video-remove': function (id) {
      var v = S.client.videos.filter(function (x) { return x.id === id; })[0];
      if (!v || !window.confirm('Retirer « ' + v.title + ' » de l’espace du client ? Il ne la verra plus (le fichier est conservé).')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(S.client.client.id) + '/videos/' + encodeURIComponent(id) + '/disable').then(function () {
        toast('Vidéo retirée');
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
