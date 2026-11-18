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
      '<input type="hidden" name="login" autocomplete="username" value="' + esc(i.username) + '">' +
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
    ['clients', 'Clients', 'lot 2'],
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
    if (S.page === 'equipe' && isSuper()) page = pageTeam();
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
  };

  function describe(e) {
    var d = e.detail || {};
    if (d.identifiant && !d.email) return d.identifiant + (d.motif ? ' — ' + d.motif : '');
    if (d.email) return d.email + (d.role ? ' (' + (d.role === 'super_admin' ? 'super admin' : 'admin') + ')' : '') + (d.motif ? ' — ' + d.motif : '');
    if (d.name) return d.name;
    if (d.title) return d.title;
    if (d.champs) return 'Champs : ' + d.champs.join(', ');
    if (d.erreur) return 'Erreur : ' + d.erreur;
    return e.target_id ? (e.target_type || '') + ' ' + e.target_id : '';
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
    var views = { login: viewLogin, code: viewCode, invite: viewInvite, 'invite-key': viewInviteKey, app: viewApp };
    app.innerHTML = S.view === 'loading' ? '<div class="auth"><div class="auth-card">' + brand() + '<p class="muted">Chargement…</p></div></div>'
      : S.view === 'error' ? '<div class="auth"><div class="auth-card">' + brand() + errorBox() + '<p class="mt"><a href="./">Revenir à la connexion</a></p></div></div>'
        : views[S.view]();
    restoreFields(saved);
    var first = app.querySelector('input:not([readonly])');
    if (first && S.view !== 'app') first.focus();
  }

  function loadPage() {
    S.error = '';
    if (S.page === 'equipe' && isSuper()) {
      api('GET', '/admin/team').then(function (d) { S.team = d.users; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'journal' && isSuper()) {
      S.audit = null;
      api('GET', '/admin/audit?limit=200').then(function (d) { S.audit = d.entries; render(); }).catch(function (e) { S.error = e.message; S.audit = []; render(); });
    }
    render();
  }

  function enterApp(user) {
    S.user = user;
    S.view = 'app';
    S.error = '';
    S.page = (location.hash || '#accueil').slice(1) || 'accueil';
    loadPage();
  }

  window.addEventListener('hashchange', function () {
    if (S.view !== 'app') return;
    S.page = location.hash.slice(1) || 'accueil';
    S.lastLink = null;
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
  };

  app.addEventListener('click', function (ev) {
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
