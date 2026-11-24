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
    diff: null,             // rubrique Diffusions : { diffusions, lastSync, lastDrive, setup }
    diffFilter: { q: '', view: 'avenir' },
    ord: null,              // rubrique Commandes : { orders, counts, production }
    ordFilter: { q: '', view: 'actives', family: '' },
    ordDetail: null,
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
    ['diffusions', 'Diffusions', null],
    ['emissions', 'Émissions', null],
    ['commandes', 'Commandes', null],
    ['tarifs', 'Tarifs', null],
    ['emails', 'E-mails', null],
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
    else if (S.page === 'diffusions') page = pageDiffusions();
    else if (S.page === 'equipe' && isSuper()) page = pageTeam();
    else if (S.page === 'journal' && isSuper()) page = pageAudit();
    else if (S.page === 'accueil') page = pageHome();
    else if (S.page === 'tarifs' || S.page === 'credits') page = pageCredits();
    else if (S.page === 'emissions') page = pageEmissions();
    else if (S.page === 'commandes') page = S.sub ? pageOrderDetail() : pageOrders();
    else if (S.page === 'alertes' || S.page === 'emails') page = pageEmails();
    else page = pageSoon();
    return '<div class="shell"><nav class="side" aria-label="Navigation">' + brand('Espace équipe') + nav + navSuper +
      '<div class="me"><span><b>' + esc(S.user.name) + '</b><br>' + (isSuper() ? 'Super admin' : 'Admin') + '</span>' +
      '<button type="button" data-a="logout">Se déconnecter</button></div></nav><main>' + page + '</main></div>';
  }

  function pageHome() {
    var d = S.dash;
    var period = S.dashDays || '30';
    var periods = [['7', '7 jours'], ['30', '30 jours'], ['90', '90 jours'], ['all', 'Depuis le début']];
    var head = '<div class="head"><div><h1>Bonjour ' + esc(S.user.name) + '</h1><p class="muted">Activité de la plateforme.</p></div>' +
      '<div class="btns"><div class="seg" role="group" aria-label="Période">' + periods.map(function (x) {
        return '<button type="button" data-a="dash-period" data-id="' + x[0] + '" aria-pressed="' + (period === x[0]) + '"' + (period === x[0] ? ' class="on"' : '') + '>' + esc(x[1]) + '</button>';
      }).join('') + '</div><button class="btn secondary" type="button" data-a="reload-dash">Actualiser</button></div></div>';
    if (!d) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var a = d.accounts;
    var p = d.payments;
    var tile = function (label, value, sub, tone, href) {
      return '<' + (href ? 'a href="' + href + '"' : 'div') + ' class="tile ' + (tone || '') + '"><span class="tile-l">' + esc(label) + '</span><b class="tile-v">' + esc(value) + '</b>' +
        (sub ? '<span class="tile-s">' + esc(sub) + '</span>' : '') + '</' + (href ? 'a' : 'div') + '>';
    };
    var st = d.stats;
    var per = st.days ? 'sur ' + st.days + ' jours' : 'depuis le début';
    var vids = st.videos;
    var vidTotal = vids.capsules.ready + vids.teaser.ready + vids.subtitles.ready;
    var pct = function (a, b) { return b ? Math.round((a / b) * 100) + ' %' : '—'; };
    var kpis = '<div class="tiles five">' +
      tile('Comptes actifs', st.accounts.activated, 'sur ' + st.accounts.total + ' comptes (' + pct(st.accounts.activated, st.accounts.total) + ') · ' + st.accounts.newActivated + ' nouveau' + (st.accounts.newActivated > 1 ? 'x' : '') + ' ' + per, '', '#clients') +
      tile('Connexions ' + per, st.connections.visits, st.connections.clients + ' client' + (st.connections.clients > 1 ? 's' : '') + ' différent' + (st.connections.clients > 1 ? 's' : '') + ', dont ' + st.connections.returning + ' revenu' + (st.connections.returning > 1 ? 's' : ''), '') +
      tile('Vidéos générées ' + per, vidTotal, vids.capsules.ready + ' capsule' + (vids.capsules.ready > 1 ? 's' : '') + ' · ' + vids.teaser.ready + ' teaser' + (vids.teaser.ready > 1 ? 's' : '') + ' · ' + vids.subtitles.ready + ' sous-titrée' + (vids.subtitles.ready > 1 ? 's' : ''), 'ok') +
      tile('Échecs de génération ' + per, st.failures.count, st.failures.reasons.length ? 'Principale raison : ' + st.failures.reasons[0].reason : 'aucun échec', st.failures.count ? 'err' : '') +
      tile('Chiffre d’affaires ' + per, euros(st.revenue.total.ht) + ' HT', euros(st.revenue.total.ttc) + ' TTC · ' + st.revenue.total.count + ' paiement' + (st.revenue.total.count > 1 ? 's' : ''), 'ok') +
      '</div>';
    var maxV = Math.max(1, vids.capsules.ready, vids.teaser.ready, vids.subtitles.ready);
    var vrow = function (label, v, unit) {
      return '<div class="hbar"><span class="hbar-l">' + esc(label) + '</span><div class="hbar-track"><div class="hbar-fill" data-w="' + Math.round((v.ready / maxV) * 100) + '"></div></div>' +
        '<span class="hbar-v"><b>' + esc(v.ready) + '</b> <span class="small muted">commande' + (v.ready > 1 ? 's' : '') + ' · ' + esc(v.files) + ' ' + unit + (v.files > 1 ? 's' : '') + (v.running ? ' · ' + v.running + ' en cours' : '') + '</span></span></div>';
    };
    var videosCard = '<div class="card"><h2>Vidéos générées par type <span class="small muted">' + esc(per) + '</span></h2>' +
      vrow('Projets de capsules', vids.capsules, 'vidéo') + vrow('Teasers', vids.teaser, 'vidéo') + vrow('Interviews sous-titrées', vids.subtitles, 'fichier') +
      '<p class="small muted mt">Crédits consommés ' + esc(per) + ' : <b>' + nb(st.credits.spent) + '</b>' + (st.credits.expired ? ' · ' + nb(st.credits.expired) + ' crédits arrivés à échéance sans être utilisés' : '') + '.</p></div>';
    var revCard = '<div class="card"><h2>Chiffre d’affaires <span class="small muted">' + esc(per) + '</span></h2><table class="compact"><thead><tr><th></th><th class="num">Paiements</th><th class="num">HT</th><th class="num">TTC</th></tr></thead><tbody>' +
      [['Recharges de crédits', st.revenue.recharge], ['Montages sur mesure', st.revenue.montage]].map(function (r) {
        return '<tr><td>' + esc(r[0]) + '</td><td class="num">' + esc(r[1].count) + '</td><td class="num nowrap">' + esc(euros(r[1].ht)) + '</td><td class="num nowrap">' + esc(euros(r[1].ttc)) + '</td></tr>';
      }).join('') + '<tr class="total"><td><b>Total</b></td><td class="num"><b>' + esc(st.revenue.total.count) + '</b></td><td class="num nowrap"><b>' + esc(euros(st.revenue.total.ht)) + '</b></td><td class="num nowrap"><b>' + esc(euros(st.revenue.total.ttc)) + '</b></td></tr></tbody></table></div>';
    var TYPES = { capsules: 'Capsules', teaser: 'Teaser', subtitles: 'Sous-titres' };
    var failCard = section('Échecs de génération · ' + per, st.failures.count, st.failures.count
      ? '<table class="compact"><thead><tr><th>Raison</th><th class="num">Nombre</th><th>Dernier</th></tr></thead><tbody>' + st.failures.reasons.map(function (r) {
          return '<tr><td>' + esc(r.reason) + '</td><td class="num">' + esc(r.count) + '</td><td class="small nowrap">' + esc(fmtDate(r.last)) + '</td></tr>';
        }).join('') + '</tbody></table><h3 class="mt">Derniers échecs</h3><table class="compact"><tbody>' + st.failures.recent.map(function (f) {
          return '<tr><td class="small nowrap">' + esc(fmtDate(f.at)) + '</td><td>' + (f.clientId ? '<a href="#clients/' + esc(f.clientId) + '">' + esc(f.clientName) + '</a>' : '—') + '</td><td class="small">' + esc(TYPES[f.type] || f.type) +
            '</td><td class="small" title="' + esc(f.error || '') + '">' + esc(f.reason) + '</td></tr>';
        }).join('') + '</tbody></table><p class="small muted">Les crédits des créations en échec sont rendus automatiquement aux clients.</p>'
      : emptyLine('Aucune génération en échec ' + per + '.'));
    var tiles = '<div class="tiles three">' +
      tile('Connectés aujourd’hui', a.connectedToday, a.returningToday ? a.returningToday + ' revenus (déjà venus un autre jour)' : 'aucun retour aujourd’hui', '') +
      tile('Paiements reçus · 30 jours', p.paid, euros(p.paid_cents) + ' TTC' + (p.recharges ? ' · dont ' + p.recharges + ' recharge' + (p.recharges > 1 ? 's' : '') + ' de crédits' : ''), 'ok') +
      tile('Paiements non aboutis · 30 jours', p.failed + p.abandoned, p.abandoned + ' abandonné' + (p.abandoned > 1 ? 's' : '') + ', ' + p.failed + ' refusé' + (p.failed > 1 ? 's' : '') + ' · ' + p.awaiting + ' en cours', (p.failed + p.abandoned) ? 'err' : '') +
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
    var fails = p.failures.length ? '<table><thead><tr><th>Date</th><th>Client à relancer</th><th>Montage</th><th>Ce qui s’est passé</th><th>État</th></tr></thead><tbody>' + p.failures.map(function (f) {
      var contact = [f.contact_name, f.contact_email, f.contact_phone].filter(Boolean).join(' · ');
      var why = f.status === 'abandoned'
        ? 'Page de paiement fermée sans payer' + (f.last_payment_error ? ' après un refus : ' + f.last_payment_error : '')
        : (f.last_payment_error || 'Paiement refusé');
      return '<tr><td class="small nowrap">' + esc(fmtDate(f.at)) + '</td><td>' + (f.client_id ? '<a href="#clients/' + esc(f.client_id) + '"><b>' + esc(f.client_name) + '</b></a>' : '<b>' + esc(f.company || 'Non rattaché') + '</b>') +
        (contact ? '<br><span class="small muted">' + esc(contact) + '</span>' : '') +
        '</td><td class="small">' + esc(f.offer_title) + (f.payment_failures > 1 ? ' <span class="muted">(' + esc(f.payment_failures) + ' essais)</span>' : '') + '</td><td class="small">' + esc(why) + originTag(f.status === 'abandoned' && !f.failure_origin ? 'client' : f.failure_origin) +
        '</td><td>' + tag(MONTAGE_STATUS[f.status], f.status) + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun paiement de montage à relancer ces 7 derniers jours.');
    var alerts = [];
    if (p.unattached) alerts.push(p.unattached + ' paiement' + (p.unattached > 1 ? 's' : '') + ' reçu' + (p.unattached > 1 ? 's' : '') + ' sans client rattaché (demande faite hors espace client, e-mail inconnu).');
    if (d.accessEmailFailures7d) alerts.push(d.accessEmailFailures7d + ' envoi' + (d.accessEmailFailures7d > 1 ? 's' : '') + ' de code d’accès en échec ces 7 derniers jours (voir les fiches concernées).');
    if (p.to_quote) alerts.push(p.to_quote + ' demande' + (p.to_quote > 1 ? 's' : '') + ' de montage à chiffrer.');
    return head + errorBox() + (alerts.length ? '<div class="warn mb">' + alerts.map(esc).join('<br>') + '</div>' : '') + kpis +
      '<div class="two">' + videosCard + revCard + '</div>' + failCard +
      '<h2 class="sec-title">Aujourd’hui et paiements en cours</h2>' + tiles + week + section('Montages à relancer · paiement non abouti (7 jours)', p.failures.length, fails);
  }

  var POS_LABELS = { 'top-left': 'Haut gauche', 'top-right': 'Haut droite', 'bottom-left': 'Bas gauche', 'bottom-right': 'Bas droite' };
  var POS_ARROWS = { 'top-left': '↖', 'top-right': '↗', 'bottom-left': '↙', 'bottom-right': '↘' };

  /** Fiche client : logos de l'entreprise et du média, leur position, et l'habillage des vidéos. */
  function logosCard(d) {
    var L = d.logos;
    if (!L) return '';
    var busy = S.logoBusy || '';
    function one(kind, title, hint) {
      var x = L[kind];
      var picker = '<div class="pos-grid" role="group" aria-label="Position du ' + esc(title.toLowerCase()) + '">' + L.positions.map(function (p) {
        return '<button type="button" class="pos-btn' + (x.position === p ? ' on' : '') + '" data-a="logo-pos" data-id="' + kind + ':' + p + '" aria-pressed="' + (x.position === p) + '" title="' + esc(POS_LABELS[p]) + '"' + (S.busy ? ' disabled' : '') + '><span aria-hidden="true">' + POS_ARROWS[p] + '</span>' + esc(POS_LABELS[p]) + '</button>';
      }).join('') + '</div>';
      return '<div class="logo-col"><h3>' + esc(title) + '</h3>' +
        '<div class="logo-box">' + (busy === kind ? '<span class="small muted">Envoi en cours…</span>' : x.url ? '<img src="' + esc(x.url) + '" alt="' + esc(title) + '">' : '<span class="small muted">Aucun logo</span>') + '</div>' +
        (kind === 'media' ? '<p class="small ' + (x.url ? 'muted' : '') + '">' + (x.source === 'programme'
          ? 'Logo de l’émission ' + esc(x.programmeTitle) + ', repris automatiquement.'
          : x.source === 'client' ? 'Logo propre à ce client' + (x.programmeTitle ? ' (à la place de celui de ' + esc(x.programmeTitle) + ')' : '') + '.'
          : x.programmeTitle ? 'Aucun logo pour l’émission ' + esc(x.programmeTitle) + ' : déposez-le dans <a href="#emissions">Émissions</a>, il servira à tous ses clients.'
          : 'Émission pas encore connue : elle le sera avec la vidéo ou la diffusion du client.') + '</p>' : '') +
        '<div class="btns left"><label class="btn small secondary file-btn">' + (kind === 'media' && x.source === 'programme' ? 'Remplacer pour ce client' : x.url ? 'Remplacer' : 'Ajouter le logo') + '<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="' + kind + '"' + (busy ? ' disabled' : '') + '></label>' +
        (kind === 'company' && x.url ? '<button class="btn small secondary" type="button" data-a="logo-remove" data-id="company"' + (S.busy ? ' disabled' : '') + '>Retirer</button>' : '') +
        (kind === 'media' && x.source === 'client' ? '<button class="btn small secondary" type="button" data-a="logo-remove" data-id="media"' + (S.busy ? ' disabled' : '') + '>' + (x.programmeTitle ? 'Revenir au logo de l’émission' : 'Retirer') + '</button>' : '') + '</div>' +
        '<span class="small muted">' + esc(hint) + '</span>' +
        '<span class="small strong mt">Position sur la vidéo</span>' + picker + '</div>';
    }
    // Aperçu : vidéo verticale, logos côte à côte quand ils partagent un coin (entreprise puis média)
    var corners = {};
    [['company', L.company], ['media', L.media]].forEach(function (e) { if (e[1].url) (corners[e[1].position] = corners[e[1].position] || []).push(e[1].url); });
    var marks = Object.keys(corners).map(function (p) {
      return '<div class="pv-corner pv-' + p + '">' + corners[p].map(function (u) { return '<img src="' + esc(u) + '" alt="">'; }).join('') + '</div>';
    }).join('');
    var missing = [!L.company.url && 'le logo de l’entreprise', !L.media.url && 'le logo du média'].filter(Boolean);
    var b = L.bumpers;
    return '<div class="card"><div class="card-head"><h2>Logos</h2></div>' +
      (missing.length ? '<div class="warn mb">Il manque ' + esc(missing.join(' et ')) + ' : ' + (L.company.url ? 'les vidéos seront livrées sans le logo du média.' : 'le client ne pourra pas lancer de capsules tant qu’il manque.') + '</div>' : '') +
      '<div class="logos-grid">' + one('company', 'Logo de l’entreprise', 'PNG à fond transparent de préférence. Il apparaît aussi en ouverture des vidéos.') +
      one('media', 'Logo du média', 'PNG à fond transparent de préférence.') +
      '<div class="logo-col"><h3>Aperçu</h3><div class="pv-frame">' + marks + '</div><span class="small muted">Vidéo verticale, logos à 14 % de la largeur.</span></div></div>' +
      (b ? '<div class="bumper-line"><div><b class="small">Habillage des ' + esc(b.kinds.map(function (k) { return k === 'teaser' ? 'teasers' : k; }).join(' et ')) + '</b>' +
        '<span class="small muted">Ouverture (' + b.introSec + ' s) : logo de l’entreprise sur l’image floutée de la vidéo, couleurs d’origine, puis fondu vers la vidéo. Fin (' + b.outroSec + ' s) : fondu vers le logo OpenMedias blanc sur le bleu nuit OpenMedias.</span></div>' +
        '<div class="om-logo"><span class="logo-box dark sm">' + (busy === 'openmedias' ? '<span class="small">Envoi…</span>' : '<img src="' + esc(L.openmedias.url || 'om-default.png') + '" alt="Logo OpenMedias">') + '</span>' +
        '<label class="btn small secondary file-btn">Remplacer<input type="file" accept="image/png,image/webp" data-logo="openmedias"' + (busy ? ' disabled' : '') + '></label>' +
        (L.openmedias.custom ? '<button class="btn small secondary" type="button" data-a="logo-om-reset"' + (S.busy ? ' disabled' : '') + '>Logo par défaut</button>' : '') +
        '<span class="small muted">Commun à tous les clients</span></div></div>' : '') +
      '</div>';
  }

  /** Rubrique Émissions : un logo par émission, repris automatiquement sur les vidéos de tous ses clients. */
  function pageEmissions() {
    var head = '<div class="head"><div><h1>Émissions</h1><p class="muted">Le logo de chaque émission s’applique automatiquement aux vidéos de tous ses clients : rien à déposer à la création d’une fiche.</p></div></div>';
    if (!S.progLogos) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var busy = S.logoBusy || '';
    return head + errorBox() + '<div class="prog-grid">' + S.progLogos.map(function (p) {
      var k = 'prog:' + p.id;
      return '<div class="card prog-card"><h2>' + esc(p.title) + '</h2>' +
        '<div class="logo-box">' + (busy === k ? '<span class="small muted">Envoi en cours…</span>' : p.url ? '<img src="' + esc(p.url) + '" alt="Logo ' + esc(p.title) + '">' : '<span class="small muted">Aucun logo</span>') + '</div>' +
        '<div class="btns left"><label class="btn small secondary file-btn">' + (p.url ? 'Remplacer' : 'Ajouter le logo') + '<input type="file" accept="image/png,image/jpeg,image/webp" data-logo="' + esc(k) + '"' + (busy ? ' disabled' : '') + '></label>' +
        (p.uploaded ? '<button class="btn small secondary" type="button" data-a="prog-logo-remove" data-id="' + esc(p.id) + '"' + (S.busy ? ' disabled' : '') + '>Retirer</button>' : '') + '</div>' +
        (!p.url ? '<span class="tag err">À déposer</span>' : '') + '</div>';
    }).join('') + '</div>' +
      '<p class="small muted">PNG à fond transparent de préférence. Pour un client particulier, le logo peut être remplacé sur sa fiche (bloc Logos). Le média de la diffusion (planning) ou la vidéo du client désigne son émission.</p>';
  }

  function uploadLogo(kind, file) {
    if (kind.indexOf('prog:') === 0) {
      var pid = kind.slice(5);
      if (file.size > 10 * 1024 * 1024) { S.error = 'Logo trop lourd (10 Mo maximum).'; return render(); }
      S.logoBusy = kind;
      return withBusy(api('POST', '/admin/programme-logos/upload', { programmeId: pid, fileName: file.name, contentType: file.type }).then(function (u) {
        return putFile(u.uploadUrl, file, u.headers, function () {}).then(function () { return api('POST', '/admin/programme-logos', { programmeId: pid, key: u.key }); });
      }).then(function () {
        S.logoBusy = ''; toast('Logo de l’émission enregistré : il s’applique à tous ses clients');
        return api('GET', '/admin/programme-logos').then(function (d) { S.progLogos = d.programmes; });
      }, function (e) { S.logoBusy = ''; throw e; }));
    }
    var c = S.client.client;
    var om = kind === 'openmedias';
    var base = om ? '/admin/branding/openmedias-logo' : '/admin/clients/' + encodeURIComponent(c.id) + '/logos';
    if (file.size > 10 * 1024 * 1024) { S.error = 'Logo trop lourd (10 Mo maximum).'; return render(); }
    S.logoBusy = kind;
    withBusy(api('POST', base + '/upload', { kind: kind, fileName: file.name, contentType: file.type }).then(function (u) {
      return putFile(u.uploadUrl, file, u.headers, function () {}).then(function () {
        return api('POST', base, om ? { key: u.key } : { kind: kind, key: u.key });
      });
    }).then(function () {
      S.logoBusy = '';
      toast(om ? 'Logo OpenMedias remplacé' : 'Logo enregistré');
      return loadClients();
    }, function (e) { S.logoBusy = ''; throw e; }));
  }

  function nb(n) { return Number(n || 0).toLocaleString('fr-FR').replace(/\u202f/g, '\u00a0'); }

  var CREDIT_KINDS = {
    inclus: ['Crédits offerts', 'ok'], recharge: ['Recharge payée', 'ok'], debit: ['Création', 'info'],
    remboursement: ['Crédits rendus (échec)', 'wait'], expiration: ['Échéance', 'off'], ajustement: ['Ajustement', 'info'],
  };

  /** Fiche client : solde, échéance, décompte des crédits et ajustement manuel. */
  function creditsCard(d) {
    var cr = d.credits;
    if (!cr) return '';
    var used = cr.history.filter(function (h) { return h.kind === 'debit'; }).reduce(function (t, h) { return t - h.credits; }, 0) -
      cr.history.filter(function (h) { return h.kind === 'remboursement'; }).reduce(function (t, h) { return t + h.credits; }, 0);
    var until = cr.expiresAt ? 'Valables jusqu’au ' + fmtDay(new Date(new Date(cr.expiresAt).getTime() - 1000).toISOString().slice(0, 10)) + ' inclus'
      : 'Échéance : ' + cr.validityDays + ' jours après la diffusion (date de diffusion à renseigner)';
    var expired = cr.expiresAt && new Date(cr.expiresAt) <= new Date();
    var rows = cr.history.length ? '<table><thead><tr><th>Date</th><th>Mouvement</th><th>Détail</th><th class="num">Crédits</th><th class="num">Solde</th></tr></thead><tbody>' + cr.history.map(function (h) {
      var k = CREDIT_KINDS[h.kind] || [h.kind, ''];
      return '<tr><td class="small nowrap">' + esc(fmtDate(h.at)) + '</td><td>' + tag(k) + '</td><td class="small">' + esc(h.label || '') +
        (h.actor && h.kind === 'ajustement' ? ' <span class="muted">· par ' + esc(h.actor) + '</span>' : '') +
        '</td><td class="num nowrap ' + (h.credits > 0 ? 'pos' : 'neg') + '">' + (h.credits > 0 ? '+' : '−') + nb(Math.abs(h.credits)) + '</td><td class="num nowrap">' + nb(h.balanceAfter) + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun mouvement pour le moment.');
    return '<div class="card"><div class="card-head"><h2>Crédits</h2></div>' +
      '<div class="credit-sum"><div><span class="small muted">Solde disponible</span><b class="credit-bal">' + nb(cr.balance) + '</b><span class="small ' + (expired ? 'err-text' : 'muted') + '">' + esc(until) + '</span></div>' +
      '<div><span class="small muted">Consommés en créations</span><b>' + nb(used) + '</b></div></div>' +
      '<details class="mt"><summary class="small">Ajuster le solde (geste commercial, correction)</summary>' +
      '<form data-form="credits-adjust" class="form-inline mt" novalidate><label>Crédits<input name="credits" type="number" step="1" placeholder="+300 ou -300" required></label>' +
      '<label class="grow">Motif<input name="reason" maxlength="300" placeholder="Ex. geste commercial suite à un souci de génération" required></label>' +
      '<button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Appliquer</button></form></details>' +
      '<h3 class="mt">Décompte</h3>' + rows + '</div>';
  }

  /** Tarifs : crédits par production et prix des recharges (modifiables par l'équipe, reportés dans Stripe). */
  function pageCredits() {
    var head = '<div class="head"><div><h1>Tarifs</h1><p class="muted">Crédits demandés pour chaque production et prix des recharges. Les changements s’affichent aussitôt dans l’espace des clients.</p></div></div>';
    var st = S.creditSettings;
    if (!st) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var v = st.settings; var p = v.prices;
    var sync = st.stripe;
    var syncBox = !sync ? '' : sync.skipped ? '<div class="note mb">' + esc(sync.skipped) + '</div>'
      : sync.ok ? '<div class="ok-box mb">Stripe' + (sync.mode === 'live' ? '' : ' (mode test)') + ' : ' + esc(sync.changes.length ? sync.changes.join(' · ') : 'catalogue déjà à jour') + '.</div>'
      : '<div class="error mb"><b>Tarifs enregistrés, mais Stripe n’a pas pu être mis à jour :</b> ' + esc(sync.error) +
        '. Les paiements utilisent quand même les nouveaux prix. <button class="btn small secondary" type="button" data-a="tarifs-sync">Réessayer</button></div>';
    var packs = v.packs.map(function (x, i) {
      var perProd = p.capsules && x.credits ? (Math.round(x.priceHT / (x.credits / p.capsules) * 100) / 100).toLocaleString('fr-FR') + ' € HT' : '—';
      return '<tr><td><input name="pk_label_' + i + '" value="' + esc(x.label) + '" maxlength="60" aria-label="Nom du pack"></td>' +
        '<td><input name="pk_credits_' + i + '" type="number" min="1" step="1" value="' + esc(x.credits) + '" aria-label="Crédits"></td>' +
        '<td><input name="pk_price_' + i + '" type="number" min="1" step="0.01" value="' + esc(x.priceHT) + '" aria-label="Prix HT"></td>' +
        '<td class="small nowrap">' + esc(euros(Math.round(x.priceHT * 100 * (1 + st.vatRate)))) + '</td><td class="small nowrap">' + esc(perProd) + '</td>' +
        '<td><label class="check"><input type="checkbox" name="pk_once_' + i + '"' + (x.once ? ' checked' : '') + '> une seule fois</label><input type="hidden" name="pk_id_' + i + '" value="' + esc(x.id) + '"></td>' +
        '<td><button class="btn small secondary" type="button" data-a="tarifs-del" data-id="' + i + '"' + (v.packs.length < 2 ? ' disabled' : '') + ' aria-label="Retirer ce pack">Retirer</button></td></tr>';
    }).join('');
    return head + errorBox() + syncBox +
      '<form data-form="credit-settings" novalidate>' +
      '<div class="card"><h2>Crédits par production</h2><div class="form-2">' +
      '<label>Projet de capsules (3 propositions)<input name="capsules" type="number" min="0" step="1" value="' + esc(p.capsules) + '"></label>' +
      '<label>Teaser de 15 s<input name="teaser" type="number" min="0" step="1" value="' + esc(p.teaser) + '"></label>' +
      '<label>Interview sous-titrée, par tranche de 5 min entamée<input name="subtitlesPer5Min" type="number" min="0" step="1" value="' + esc(p.subtitlesPer5Min) + '"></label>' +
      '<label>Traduction des sous-titres, par langue et tranche de 5 min<input name="translationPer5Min" type="number" min="0" step="1" value="' + esc(p.translationPer5Min) + '"></label></div></div>' +
      '<div class="card"><h2>Prix des recharges</h2><table class="edit"><thead><tr><th>Nom affiché au client</th><th>Crédits</th><th>Prix HT (€)</th><th>Prix TTC</th><th>Prix par production</th><th></th><th></th></tr></thead><tbody>' + packs + '</tbody></table>' +
      '<div class="btns left mt"><button class="btn small secondary" type="button" data-a="tarifs-add">Ajouter un pack</button></div>' +
      '<p class="small muted mt">Les prix sont reportés dans le catalogue Stripe à l’enregistrement (un produit par pack, l’ancien prix est archivé). Une « production » = ' + nb(p.capsules) + ' crédits.</p></div>' +
      '<div class="card"><h2>Compte client</h2><div class="form-2">' +
      '<label>Crédits offerts à la création du compte<input name="included" type="number" min="0" step="1" value="' + esc(v.included) + '"></label>' +
      '<label>Validité des crédits (jours)<span class="small muted">après la diffusion, puis relancée à chaque recharge</span><input name="validityDays" type="number" min="1" max="365" step="1" value="' + esc(v.validityDays) + '"></label></div></div>' +
      '<div class="btns left"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Enregistrer les tarifs</button>' +
      (st.dirty ? '<span class="small muted">Modifications non enregistrées</span>' : '') + '</div></form>';
  }

  /** Lit le formulaire des tarifs (sert à l'enregistrement et à l'ajout / retrait d'un pack). */
  function readTarifs(f) {
    var st = S.creditSettings.settings;
    return {
      included: Number(f.included.value), validityDays: Number(f.validityDays.value),
      prices: { capsules: Number(f.capsules.value), teaser: Number(f.teaser.value), subtitlesPer5Min: Number(f.subtitlesPer5Min.value), translationPer5Min: Number(f.translationPer5Min.value) },
      packs: st.packs.map(function (x, i) {
        return { id: f['pk_id_' + i].value, label: f['pk_label_' + i].value, credits: Number(f['pk_credits_' + i].value), priceHT: Number(String(f['pk_price_' + i].value).replace(',', '.')), once: f['pk_once_' + i].checked };
      }),
    };
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
            (self ? (u.role === 'super_admin' ? '<span class="tag super">Super admin</span>' : 'Admin')
              : '<select class="role-select" data-id="' + esc(u.id) + '" aria-label="Rôle de ' + esc(u.name) + '"' + (S.busy ? ' disabled' : '') + '><option value="admin"' + (u.role === 'admin' ? ' selected' : '') + '>Admin</option><option value="super_admin"' + (u.role === 'super_admin' ? ' selected' : '') + '>Super admin</option></select>') + '</td><td>' + statusTag(u) +
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
      '<label>Identifiant<input name="username" required autocapitalize="none" spellcheck="false" maxlength="40" placeholder="rempli avec le début de l’e-mail"></label>' +
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
    role_modifie: 'Rôle modifié',
    alertes_modifiees: 'Destinataires des alertes modifiés',
    emails_actives: 'E-mails automatiques activés / mis en pause',
    email_test_envoye: 'E-mail de test envoyé',
    emails_test_adresses: 'Adresses de test des e-mails modifiées',
    montage_avancement: 'Avancement d’un montage',
    facture_creee: 'Facture créée',
    client_cree: 'Client créé',
    client_modifie: 'Client modifié',
    video_ajoutee: 'Vidéo ajoutée',
    video_retiree: 'Vidéo retirée',
    commande_relancee: 'Commande relancée',
    clients_importes: 'Import de clients',
    acces_envoye: 'Code d’accès envoyé',
    apercu_email_envoye: 'Aperçu de l’e-mail envoyé',
    acces_envoye_auto: 'Code d’accès envoyé automatiquement',
    acces_echec_envoi: 'Échec d’envoi du code d’accès',
    acces_lien_cree: 'Code d’accès généré à la main',
    client_connexion: 'Connexion du client avec son code',
    logo_modifie: 'Logo modifié',
    logo_openmedias_modifie: 'Logo OpenMedias de fin modifié',
    logo_emission_modifie: 'Logo d’émission modifié',
    acces_retabli: 'Accès rétabli',
    acces_coupe: 'Accès coupé',
    marketing_reponse: 'Réponse sur les campagnes marketing',
    credits_ajustes: 'Crédits ajustés',
    bareme_credits_modifie: 'Tarifs modifiés',
    tarifs_stripe_synchronises: 'Tarifs synchronisés avec Stripe',
  };

  var FIELD_NAMES = {
    name: 'nom', company: 'entreprise', email: 'e-mail', broadcastDate: 'date de diffusion', packageLabel: 'package',
    notes: 'notes', logoKey: 'logo', sector: 'secteur', marketingOptin: 'consentement marketing', marketingOptinSource: 'origine du consentement',
  };

  function describe(e) {
    var d = e.detail || {};
    var ROLE = { super_admin: 'super admin', admin: 'admin' };
    if (e.action === 'role_modifie') return (d.email || '') + ' : ' + (ROLE[d.avant] || d.avant) + ' → ' + (ROLE[d.apres] || d.apres);
    if (e.action === 'emails_test_adresses') return (d.avant || '') + ' → ' + (d.apres || '');
    if (e.action === 'email_test_envoye') return (d.objet || '') + ' → ' + (d.redirige_vers || d.email || '');
    if (e.action === 'emails_actives') return Object.keys(d).map(function (k) { return k + ' : ' + d[k]; }).join(' · ');
    if (e.action === 'alertes_modifiees') return Object.keys(d).map(function (k) { return k + ' : ' + d[k]; }).join(' · ');
    if (e.action === 'montage_avancement') return (d.etat || '') + (d.note ? ' — ' + d.note : '');
    if (e.action === 'facture_creee') return 'facture ' + (d.numero || '');
    if (d.identifiant && !d.email) return d.identifiant + (d.motif ? ' — ' + d.motif : '');
    if (d.email) return d.email + (d.role ? ' (' + (d.role === 'super_admin' ? 'super admin' : 'admin') + ')' : '') + (d.motif ? ' — ' + d.motif : '');
    if (d.emission) return 'logo ' + d.emission + ' ' + (d.action || '');
    if (d.logo) return 'logo ' + d.logo + (d.action ? ' ' + d.action : '') + (d.position ? ' — position ' + (POS_LABELS[d.position] || d.position).toLowerCase() : '');
    if (d.credits !== undefined && d.motif) return (d.credits > 0 ? '+' : '') + nb(d.credits) + ' crédits — ' + d.motif + ' (solde ' + nb(d.solde) + ')';
    if (d.apres && d.apres.packs) return 'crédits par production et prix des recharges mis à jour' + (typeof d.stripe === 'string' ? ' — Stripe : ' + d.stripe : '');
    if (d.stripe !== undefined) return typeof d.stripe === 'string' ? 'Stripe : ' + d.stripe : (d.stripe.length ? d.stripe.join(', ') : 'déjà à jour');
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

  /* ------------------------------------------------------------ Diffusions */

  var DIFF_VIEWS = [
    ['avenir', 'À venir'],
    ['completer', 'À compléter'],
    ['passees', 'Passées'],
    ['annulees', 'Annulées'],
    ['toutes', 'Toutes'],
  ];

  /** Date du jour à Paris, « AAAA-MM-JJ ». */
  function parisToday() {
    var p = {};
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }

  function loadDiffusions() {
    return api('GET', '/admin/diffusions')
      .then(function (d) { if (S.page !== 'diffusions') return; S.diff = d; render(); })
      .catch(function (e) { if (S.page !== 'diffusions') return; S.error = e.message; S.diff = S.diff || { diffusions: [], setup: {} }; render(); });
  }

  function filteredDiffusions() {
    var today = parisToday();
    var q = S.diffFilter.q.trim().toLowerCase();
    var v = S.diffFilter.view;
    return (S.diff.diffusions || []).filter(function (d) {
      if (q && [d.client.company, d.client.name, d.entreprise, d.client.email, d.media, d.format].join(' ').toLowerCase().indexOf(q) === -1) return false;
      var cancelled = d.state === 'cancelled';
      var pending = d.state === 'date_pending' || !d.dateDiffusion; // date à fixer : toujours « à venir »
      var past = !pending && d.dateDiffusion < today;
      if (v === 'annulees') return cancelled;
      if (v === 'toutes') return true;
      if (cancelled) return false;
      if (v === 'passees') return past;
      if (v === 'completer') return d.status.tone === 'wait' || d.status.tone === 'err';
      return !past; // à venir : aujourd'hui, plus tard ou date à fixer
    }).sort(function (a, b) {
      var pa = a.state === 'date_pending' || !a.dateDiffusion;
      var pb = b.state === 'date_pending' || !b.dateDiffusion;
      if (pa !== pb) return pa ? 1 : -1; // dates à fixer en fin de liste
      var cmp = String(a.dateDiffusion).localeCompare(String(b.dateDiffusion));
      return v === 'passees' || v === 'annulees' ? -cmp : cmp; // passées : la plus récente d'abord
    });
  }

  function diffSetupNotes(st, last) {
    var out = '';
    if (!st.planning) out += '<div class="warn mb"><b>Lecture du planning pas encore branchée.</b> Renseignez PLANNING_EXPORT_URL et PLANNING_EXPORT_KEY sur le serveur : les diffusions du dashboard apparaîtront ici automatiquement.</div>';
    else if (last && !last.ok) out += '<div class="error mb">Dernière lecture du planning en échec : ' + esc(last.error) + '</div>';
    if (!st.drive) out += '<div class="note mb"><b>Google Drive pas encore branché.</b> En attendant, déposez les vidéos depuis la fiche du client : elles sont reconnues ici si leur date de diffusion est la même.</div>';
    if (st.redirectTo) out += '<div class="note mb"><b>Mode test :</b> les codes d’accès et les alertes partent vers ' + esc(st.redirectTo) + ', pas vers les clients.</div>';
    else if (st.mailProblem) out += '<div class="warn mb"><b>Aucun e-mail ne partira.</b> ' + esc(st.mailProblem) + '</div>';
    return out;
  }

  function videoCell(d) {
    var drive = d.driveUrl ? '<br><a class="small ext" href="' + esc(d.driveUrl) + '" target="_blank" rel="noopener">Dossier Drive</a>' : '';
    if (d.state === 'cancelled') return '<span class="small muted">—</span>' + drive;
    if (d.videoId) return '<span class="tag ok">Reçue</span>' + drive;
    if (d.videoImportError) return '<span class="tag err">Import en échec</span><br><span class="small muted">' + esc(d.videoImportError) + '</span>' + drive;
    return '<span class="tag ' + (d.status.tone === 'err' ? 'err' : 'wait') + '">Manquante</span>' + drive;
  }

  /** Haut de la rubrique Diffusions : indicateurs du jour et liste des diffusions du jour. */
  function diffToday(all) {
    var today = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date());
    var tomorrow = new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris' }).format(new Date(Date.now() + 864e5));
    var list = all.filter(function (d) { return d.state !== 'cancelled' && d.dateDiffusion === today; });
    var next = all.filter(function (d) { return d.state !== 'cancelled' && d.dateDiffusion === tomorrow; });
    var bad = list.filter(function (d) { return d.status.tone === 'err' || d.status.tone === 'wait'; });
    var miss = { 'vidéo': 0, 'e-mail du client': 0 };
    bad.forEach(function (d) { (d.status.missing || []).forEach(function (m) { miss[m] = (miss[m] || 0) + 1; }); });
    var missTxt = Object.keys(miss).filter(function (k) { return miss[k]; }).map(function (k) { return miss[k] + ' ' + k + (k === 'vidéo' ? (miss[k] > 1 ? 's manquantes' : ' manquante') : (miss[k] > 1 ? 's manquants' : ' manquant')); }).join(' · ');
    var nextBad = next.filter(function (d) { return d.status.tone === 'err' || d.status.tone === 'wait'; }).length;
    var check = !list.length ? '<span class="tag off">Pas de diffusion aujourd’hui</span>'
      : bad.length ? '<span class="tag err">' + bad.length + ' à compléter</span><span class="small">' + esc(missTxt || 'voir la liste') + '</span>'
      : '<span class="tag ok">Tout est en ordre</span><span class="small muted">Vidéos déposées et e-mails renseignés</span>';
    var rows = list.length ? '<ul class="today-list">' + list.map(function (d) {
      var c = d.client || {};
      return '<li><a href="#clients/' + esc(c.id) + '"><b>' + esc(c.company || d.entreprise) + '</b></a><span class="small muted">' + esc([d.media, d.sousMedia].filter(Boolean).join(' ')) + (d.format ? ' · ' + esc(d.format) : '') + '</span>' +
        '<span class="tag ' + esc(d.status.tone) + '">' + esc(d.status.label) + '</span></li>';
    }).join('') + '</ul>' : '<p class="small muted">Aucune diffusion vidéo prévue aujourd’hui.</p>';
    return '<div class="today"><div class="card today-kpi"><span class="tile-l">Diffusions aujourd’hui</span><b class="tile-v">' + list.length + '</b>' +
      '<div class="today-check">' + check + '</div>' +
      '<span class="small muted">Demain : ' + next.length + ' diffusion' + (next.length > 1 ? 's' : '') + (nextBad ? ', dont ' + nextBad + ' à compléter' : '') + '</span></div>' +
      '<div class="card today-names"><span class="tile-l">Diffusions du jour</span>' + rows + '</div></div>';
  }

  function pageDiffusions() {
    var head = '<div class="head"><div><h1>Diffusions</h1><p class="muted">Les diffusions vidéo du planning : vidéo reçue des monteurs et envoi du code d’accès au client, le jour J à partir de ' +
      esc((S.diff && S.diff.setup && S.diff.setup.sendHour) || 8) + ' h.</p></div><div class="btns">' +
      (S.diff && S.diff.setup && S.diff.setup.drive ? '<button type="button" class="btn secondary" data-a="diff-drive"' + (S.busy ? ' disabled' : '') + '>Vérifier le Drive</button>' : '') +
      '<button type="button" class="btn secondary" data-a="diff-sync"' + (S.busy ? ' disabled' : '') + '>Relire le planning</button></div></div>';
    if (!S.diff) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var st = S.diff.setup || {};
    var last = S.diff.lastSync;
    var lastLine = last && last.ok ? '<p class="small muted">Planning relu le ' + esc(fmtDate(last.at)) + ' : ' + esc(last.received) + ' diffusion' + (last.received > 1 ? 's' : '') + ' vidéo lue' + (last.received > 1 ? 's' : '') +
      (last.created || last.updated ? ', ' + esc(last.created) + ' ajoutée' + (last.created > 1 ? 's' : '') + ', ' + esc(last.updated) + ' mise' + (last.updated > 1 ? 's' : '') + ' à jour' : ', rien de nouveau') +
      '. Relecture automatique toutes les ' + esc(st.planningEveryMin || 60) + ' min.</p>' : '';
    var list = filteredDiffusions();
    var all = S.diff.diffusions || [];
    var todo = all.filter(function (d) { return d.state !== 'cancelled' && (d.status.tone === 'wait' || d.status.tone === 'err'); }).length;
    var table;
    if (!all.length) table = '<div class="empty">Aucune diffusion pour le moment.' + (st.planning ? ' Les diffusions vidéo confirmées dans le planning apparaîtront ici.' : '') + '</div>';
    else if (!list.length) table = '<div class="empty">Aucune diffusion dans cette vue.</div>';
    else {
      table = '<table class="rows"><thead><tr><th>Diffusion</th><th>Client</th><th>Émission</th><th>Vidéo</th><th>Code d’accès</th></tr></thead><tbody>' +
        list.map(function (d) {
          var c = d.client;
          var email = c.email ? '<span class="small">' + esc(c.email) + '</span>'
            : (d.accessSentAt ? '' : '<span class="small text-err">E-mail à renseigner</span>');
          return '<tr data-href="#clients/' + esc(c.id) + '"><td class="nowrap">' + (d.state === 'date_pending' || !d.dateDiffusion ? '<span class="muted">Date à fixer</span>' : esc(fmtDay(d.dateDiffusion))) + '</td>' +
            '<td><a href="#clients/' + esc(c.id) + '"><b>' + esc(c.company || d.entreprise) + '</b></a>' + (c.name && c.name !== c.company ? '<br><span class="small muted">' + esc(c.name) + '</span>' : '') + '<br>' + email + '</td>' +
            '<td class="small">' + esc([d.media, d.sousMedia].filter(Boolean).join(' ')) + '<br><span class="muted">' + esc(d.format || '') + '</span></td>' +
            '<td>' + videoCell(d) + '</td>' +
            '<td><span class="tag ' + esc(d.status.tone) + '">' + esc(d.status.label) + '</span></td></tr>';
        }).join('') + '</tbody></table>';
    }
    var views = DIFF_VIEWS.map(function (v) {
      return '<option value="' + v[0] + '"' + (S.diffFilter.view === v[0] ? ' selected' : '') + '>' + esc(v[1] + (v[0] === 'completer' && todo ? ' (' + todo + ')' : '')) + '</option>';
    }).join('');
    return head + diffSetupNotes(st, last) + errorBox() + diffToday(all) + lastLine +
      '<form data-form="diff-filter" class="filters" novalidate><input name="q" type="search" placeholder="Rechercher une entreprise, un e-mail, une émission…" aria-label="Rechercher" value="' + esc(S.diffFilter.q) + '">' +
      '<select name="view" aria-label="Diffusions affichées">' + views + '</select><span class="small muted">' + esc(list.length + ' diffusion' + (list.length > 1 ? 's' : '')) + '</span></form>' +
      '<div class="card flush">' + table + '</div>' +
      '<p class="small muted">Pour corriger un e-mail ou envoyer le code plus tôt, ouvrez la fiche du client. Les dates et les annulations se modifient dans le planning du dashboard.</p>';
  }

  /* ------------------------------------------------------------ E-mails automatiques */

  function loadEmails() {
    S.emailsCfg = null; S.alerts = null; S.redirect = null;
    return Promise.all([api('GET', '/admin/email-settings'), api('GET', '/admin/alert-settings'), api('GET', '/admin/email-redirect')])
      .then(function (r) { S.emailsCfg = r[0]; S.alerts = r[1]; S.redirect = r[2]; render(); })
      .catch(function (e) { S.error = e.message; render(); });
  }
  function saveEmailToggles(disabled) {
    return api('PUT', '/admin/email-settings', { disabled: disabled }).then(function (d) { S.emailsCfg = d; });
  }
  function pageEmails() {
    var head = '<div class="head"><div><h1>E-mails</h1><p class="muted">Tous les e-mails envoyés automatiquement par la plateforme. Mettez-en un en pause pour qu’il ne parte plus. « M’envoyer un test » vous l’envoie avec des données d’exemple, même en pause ; les envois faits à la main depuis une fiche client restent aussi possibles.</p></div>';
    if (!S.emailsCfg || !S.alerts) return head + '</div>' + errorBox() + '<div class="card empty">Chargement…</div>';
    var list = S.emailsCfg.emails;
    var paused = list.filter(function (e) { return !e.enabled; }).length;
    head += '<div class="btns">' + (paused < list.length ? '<button type="button" class="btn secondary" data-a="emails-all-off"' + (S.busy ? ' disabled' : '') + '>Tout mettre en pause</button>' : '') +
      (paused ? '<button type="button" class="btn" data-a="emails-all-on"' + (S.busy ? ' disabled' : '') + '>Tout réactiver</button>' : '') + '</div></div>';
    var row = function (e) {
      var t = (S.alerts.types || []).filter(function (x) { return x.id === e.id; })[0];
      var chips = '';
      if (e.alert && t) {
        chips = '<div class="chips">' + (t.recipients.length ? t.recipients.map(function (m) {
          return '<span class="chip">' + esc(m) + '<button type="button" data-a="alert-del" data-id="' + esc(t.id + '|' + m) + '" aria-label="Retirer ' + esc(m) + '" title="Retirer"' + (S.busy ? ' disabled' : '') + '>×</button></span>';
        }).join('') : '<span class="small text-err">Aucun destinataire.</span>') + '</div>' +
          '<form data-form="alert-add" data-id="' + esc(t.id) + '" class="form-inline" novalidate><label class="grow">Ajouter un destinataire<input name="email" type="email" placeholder="prenom@openmedias.fr" autocomplete="off"></label><button class="btn secondary small" type="submit"' + (S.busy ? ' disabled' : '') + '>Ajouter</button></form>';
      }
      return '<div class="card email-row' + (e.enabled ? '' : ' off') + '"><div class="email-head"><div><h2>' + esc(e.label) + '</h2><p class="small muted">' + esc(e.when) + '</p></div>' +
        '<div class="email-actions"><button type="button" class="btn secondary small" data-a="email-test" data-id="' + esc(e.id) + '"' + (S.busy ? ' disabled' : '') + ' title="Cet e-mail avec des données d’exemple, envoyé à votre adresse (même en pause)">M’envoyer un test</button>' +
        '<button type="button" class="switch' + (e.enabled ? ' on' : '') + '" role="switch" aria-checked="' + e.enabled + '" data-a="email-toggle" data-id="' + esc(e.id) + '"' + (S.busy ? ' disabled' : '') + '><span></span>' + (e.enabled ? 'Actif' : 'En pause') + '</button></div></div>' +
        (e.enabled ? '' : '<p class="small paused-note">En pause : ' + esc(e.paused) + '</p>') + chips + '</div>';
    };
    var group = function (aud, title) {
      var items = list.filter(function (e) { return e.audience === aud; });
      return '<h2 class="email-group">' + esc(title) + '</h2>' + items.map(row).join('');
    };
    var previews = (S.emailsCfg.previews || []).map(function (e) {
      return '<div class="card email-row draft"><div class="email-head"><div><p class="small email-step">' + esc(e.step) + '</p><h2>' + esc(e.label) + '</h2><p class="small muted">' + esc(e.when) + '</p></div>' +
        '<div class="email-actions"><button type="button" class="btn secondary small" data-a="email-test" data-id="' + esc(e.id) + '"' + (S.busy ? ' disabled' : '') + ' title="Cet e-mail avec des données d’exemple, envoyé à votre adresse">M’envoyer un test</button>' +
        '<span class="tag off">Test uniquement</span></div></div></div>';
    }).join('');
    var draftGroup = previews ? '<h2 class="email-group">Séquence de relance et commande · en préparation</h2><p class="small muted">Ces e-mails ne partent pas encore automatiquement : ils ne sont envoyés qu’en test, à votre adresse, avec des données d’exemple.</p>' + previews : '';
    var rd = S.redirect || { list: [], mode: 'reel' };
    var modeLine = rd.mode === 'test'
      ? '<p class="small"><span class="tag wait">Mode test</span> Tous les e-mails (clients, alertes, tests) partent vers ' + (rd.list.length > 1 ? 'ces adresses' : 'cette adresse') + ' à la place des vrais destinataires, avec « [TEST] » dans l’objet.</p>'
      : rd.mode === 'reel' ? '<p class="small"><span class="tag ok">Envoi réel</span> Les e-mails partent aux vrais destinataires (clients et équipe). Ajouter une adresse ici fait repasser la plateforme en mode test.</p>'
      : '<p class="small text-err">Aucune adresse de test et envoi réel non autorisé : aucun e-mail ne part.</p>';
    var redirectCard = '<div class="card redirect-card"><h2>Mode test : qui reçoit les e-mails</h2>' + modeLine +
      '<div class="chips">' + rd.list.map(function (m) {
        return '<span class="chip">' + esc(m) + '<button type="button" data-a="redirect-del" data-id="' + esc(m) + '" aria-label="Retirer ' + esc(m) + '" title="Retirer"' + (S.busy ? ' disabled' : '') + '>×</button></span>';
      }).join('') + '</div>' +
      '<form data-form="redirect-add" class="form-inline" novalidate><label class="grow">Ajouter une adresse de test (@openmedias.fr uniquement)<input name="email" type="email" placeholder="prenom@openmedias.fr" autocomplete="off"></label><button class="btn secondary small" type="submit"' + (S.busy ? ' disabled' : '') + '>Ajouter</button></form>' +
      (rd.fromEnv && rd.list.length ? '<p class="small muted">Adresse reprise de la configuration du serveur (MAIL_REDIRECT_TO) : elle sera remplacée par cette liste dès la première modification.</p>' : '') +
      (rd.updatedAt ? '<p class="small muted">Modifié le ' + esc(fmtDate(rd.updatedAt)) + (rd.updatedBy ? ' par ' + esc(rd.updatedBy) : '') + '.</p>' : '') + '</div>';
    return head + errorBox() + redirectCard + group('client', 'E-mails aux clients') + draftGroup + group('equipe', 'Alertes à l’équipe') +
      (S.emailsCfg.updatedAt ? '<p class="small muted">Dernière modification le ' + esc(fmtDate(S.emailsCfg.updatedAt)) + (S.emailsCfg.updatedBy ? ' par ' + esc(S.emailsCfg.updatedBy) : '') + '.</p>' : '');
  }

  /* ------------------------------------------------------------ Alertes */

  function pageAlerts() {
    var head = '<div class="head"><div><h1>Alertes</h1><p class="muted">Qui reçoit les e-mails automatiques envoyés à l’équipe. Ajoutez ou retirez des destinataires : c’est pris en compte tout de suite.</p></div></div>';
    if (!S.alerts) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    return head + errorBox() + S.alerts.types.map(function (t) {
      var chips = t.recipients.length ? t.recipients.map(function (e) {
        return '<span class="chip">' + esc(e) + '<button type="button" data-a="alert-del" data-id="' + esc(t.id + '|' + e) + '" aria-label="Retirer ' + esc(e) + '" title="Retirer"' + (S.busy ? ' disabled' : '') + '>×</button></span>';
      }).join('') : '<span class="small text-err">Aucun destinataire : cette alerte n’est envoyée à personne.</span>';
      return '<div class="card"><h2>' + esc(t.label) + '</h2><p class="small muted">' + esc(t.description) + '</p><div class="chips">' + chips + '</div>' +
        (t.fromEnv && t.recipients.length ? '<p class="small muted">Adresse reprise de la configuration du serveur : elle sera remplacée par cette liste dès la première modification.</p>' : '') +
        '<form data-form="alert-add" data-id="' + esc(t.id) + '" class="form-inline mt" novalidate><label class="grow">Ajouter un destinataire<input name="email" type="email" placeholder="prenom@openmedias.fr" autocomplete="off"></label><button class="btn secondary" type="submit"' + (S.busy ? ' disabled' : '') + '>Ajouter</button></form></div>';
    }).join('') + (S.alerts.updatedAt ? '<p class="small muted">Dernière modification le ' + esc(fmtDate(S.alerts.updatedAt)) + (S.alerts.updatedBy ? ' par ' + esc(S.alerts.updatedBy) : '') + '.</p>' : '');
  }
  function saveAlerts(type, list) {
    var body = {}; body[type] = list;
    return api('PUT', '/admin/alert-settings', body).then(function (d) { S.alerts = d; });
  }

  /* ------------------------------------------------------------ Commandes */

  var KIND_LABELS = { capsules: 'Capsules', teaser: 'Teaser', subtitles: 'Interview sous-titrée', montage: 'Montage sur mesure', visuels: 'Visuels', publications: 'Publications', photo: 'Photo' };
  var PROD_TONES = { todo: 'wait', in_progress: 'info', delivered: 'ok' };
  var ORD_VIEWS = [['actives', 'À suivre'], ['erreurs', 'En erreur'], ['montages', 'Montages à faire'], ['factures', 'Factures en attente'], ['toutes', 'Toutes']];
  var RUNNING = ['validated', 'paid', 'submitting', 'processing', 'opus_done', 'postprocessing'];

  function invoiceTag(o) {
    var i = o.invoice || {};
    if (o.status !== 'paid') return '';
    if (i.status === 'created') return '<span class="tag ok">Facture ' + esc(i.number || '') + '</span>';
    if (i.provider === 'stripe' || i.status === 'stripe') return '<span class="tag off">Facture Stripe</span>';
    if (i.status === 'missing_address') return '<span class="tag wait">Facture : adresse manquante</span>';
    if (i.status === 'error') return '<span class="tag err">Facture en erreur</span>';
    return '<span class="tag wait">Facture à faire</span>';
  }
  function orderState(o) {
    if (o.family === 'montage') return tag(MONTAGE_STATUS[o.status], o.status) + (o.production ? ' ' + tag([S.ord.production[o.production], PROD_TONES[o.production]], o.production) : '');
    return tag(ORDER_STATUS[o.status] || (o.status === 'opus_done' ? ['En finition', 'wait'] : o.status === 'dry_run' ? ['Simulation', 'off'] : null), o.status) +
      (o.status === 'error' && o.error ? '<br><span class="small text-err">' + esc(o.error.slice(0, 140)) + '</span>' : '');
  }
  function filteredOrders() {
    var q = S.ordFilter.q.trim().toLowerCase(); var v = S.ordFilter.view; var fam = S.ordFilter.family;
    return (S.ord.orders || []).filter(function (o) {
      if (fam && o.family !== fam) return false;
      if (q && [o.client.company, o.client.name, o.client.email, o.programme, o.title, KIND_LABELS[o.kind], o.id].join(' ').toLowerCase().indexOf(q) === -1) return false;
      if (v === 'erreurs') return o.status === 'error';
      if (v === 'montages') return o.family === 'montage' && o.production && o.production !== 'delivered';
      if (v === 'factures') return o.family === 'montage' && o.status === 'paid' && o.invoice.provider === 'pennylane' && o.invoice.status !== 'created';
      if (v === 'actives') return o.family === 'creation' ? (RUNNING.indexOf(o.status) !== -1 || o.status === 'error') : (o.production && o.production !== 'delivered') || o.status === 'awaiting_payment';
      return true;
    });
  }
  function pageOrders() {
    var head = '<div class="head"><div><h1>Commandes</h1><p class="muted">Créations automatiques (capsules, teasers, interviews sous-titrées) et montages sur mesure : avancement, erreurs, paiements et factures.</p></div>' +
      '<div class="btns"><button type="button" class="btn secondary" data-a="ord-reload"' + (S.busy ? ' disabled' : '') + '>Actualiser</button></div></div>';
    if (!S.ord) return head + errorBox() + '<div class="card empty">Chargement…</div>';
    var c = S.ord.counts;
    var kpi = function (n, label, view, tone) { return '<button type="button" class="card kpi' + (S.ordFilter.view === view ? ' on' : '') + '" data-a="ord-view" data-id="' + view + '"><b class="' + (n && tone ? 'text-' + tone : '') + '">' + n + '</b><span class="small muted">' + esc(label) + '</span></button>'; };
    var kpis = '<div class="kpis">' + kpi(c.running, 'en fabrication', 'actives') + kpi(c.errors, 'en erreur', 'erreurs', 'err') + kpi(c.montagesTodo, 'montages à faire', 'montages') + kpi(c.invoicesPending, 'factures en attente', 'factures', 'err') + '</div>';
    var list = filteredOrders();
    var rows = list.length ? '<table class="rows"><thead><tr><th>Date</th><th>Client</th><th>Commande</th><th>État</th><th>Crédits / montant</th></tr></thead><tbody>' + list.map(function (o) {
      var href = '#commandes/' + (o.family === 'montage' ? 'm/' : 'c/') + o.id;
      var what = o.family === 'montage'
        ? '<b>' + esc(o.title) + '</b>' + (o.programme ? '<br><span class="small muted">' + esc(o.programme) + '</span>' : '') + (o.deadline ? '<br><span class="small">Pour le ' + esc(fmtDay(o.deadline)) + '</span>' : '')
        : '<b>' + esc(KIND_LABELS[o.kind] || o.kind) + '</b>' + (o.duration ? ' <span class="small muted">· ' + esc(o.duration) + ' s</span>' : '') + (o.format ? ' <span class="small muted">· ' + esc(o.format) + '</span>' : '') +
          (o.programme ? '<br><span class="small muted">' + esc(o.programme) + '</span>' : '') + (o.files ? '<br><span class="small">' + esc(o.files) + ' fichier' + (o.files > 1 ? 's' : '') + '</span>' : '');
      var money = o.family === 'montage' ? (o.amountTtcCents == null ? '<span class="muted">Sur devis</span>' : esc(euros(o.amountTtcCents)) + ' TTC<br>' + invoiceTag(o)) : (o.credits ? esc(o.credits) + ' crédits' + (o.refunded ? '<br><span class="small muted">rendus</span>' : '') : '<span class="muted">—</span>');
      return '<tr data-href="' + href + '"><td class="small nowrap">' + esc(fmtDate(o.createdAt)) + '</td><td>' + (o.client.id ? '<a href="#clients/' + esc(o.client.id) + '"><b>' + esc(o.client.company || o.client.name || 'Client') + '</b></a>' : '<b>' + esc(o.client.company || '—') + '</b>') +
        (o.client.name && o.client.name !== o.client.company ? '<br><span class="small muted">' + esc(o.client.name) + '</span>' : '') + '</td><td>' + what + '</td><td>' + orderState(o) + '</td><td class="small">' + money + '</td></tr>';
    }).join('') + '</tbody></table>' : '<div class="empty">Aucune commande dans cette vue.</div>';
    var views = ORD_VIEWS.map(function (v) { return '<option value="' + v[0] + '"' + (S.ordFilter.view === v[0] ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    var fams = [['', 'Tous les types'], ['creation', 'Créations automatiques'], ['montage', 'Montages sur mesure']].map(function (v) { return '<option value="' + v[0] + '"' + (S.ordFilter.family === v[0] ? ' selected' : '') + '>' + esc(v[1]) + '</option>'; }).join('');
    return head + errorBox() + kpis +
      '<form data-form="ord-filter" class="filters" novalidate><input name="q" type="search" placeholder="Rechercher un client, une émission, un n° de commande…" aria-label="Rechercher" value="' + esc(S.ordFilter.q) + '">' +
      '<select name="view" aria-label="Vue">' + views + '</select><select name="family" aria-label="Type">' + fams + '</select><span class="small muted">' + esc(list.length + ' commande' + (list.length > 1 ? 's' : '')) + '</span></form>' +
      '<div class="card flush">' + rows + '</div>';
  }

  function kv(label, value) { return value ? '<div><dt class="small muted">' + esc(label) + '</dt><dd>' + value + '</dd></div>' : ''; }
  function pageOrderDetail() {
    var back = '<p><a href="#commandes">← Toutes les commandes</a></p>';
    var d = S.ordDetail;
    if (!d) return back + errorBox() + '<div class="card empty">Chargement…</div>';
    if (d.montage) {
      var m = d.montage; var ct = m.contact || {}; var b = m.brief || {}; var bill = (d.client && d.client.billing) || ct.billing || null; var inv = m.invoice || {};
      var prod = m.production ? '<div class="card"><h2>Avancement du montage</h2><form data-form="ord-prod" class="form-2" novalidate>' +
        '<label>État<select name="status">' + Object.keys(d.production).map(function (k) { return '<option value="' + k + '"' + (m.production === k ? ' selected' : '') + '>' + esc(d.production[k]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="wide">Note interne <span class="muted">(monteur, lien de livraison…)</span><textarea name="note" rows="3" maxlength="2000">' + esc(m.productionNote) + '</textarea></label>' +
        '<div class="wide btns left"><button class="btn" type="submit"' + (S.busy ? ' disabled' : '') + '>Enregistrer</button>' + (m.productionUpdatedAt ? '<span class="small muted">Mis à jour le ' + esc(fmtDate(m.productionUpdatedAt)) + (m.productionBy ? ' par ' + esc(m.productionBy) : '') + '</span>' : '') + '</div></form></div>' : '';
      var invLine = m.status !== 'paid' ? '<span class="muted">Pas de facture : non payé.</span>'
        : inv.status === 'created' ? '<span class="tag ok">Facture ' + esc(inv.number || '') + '</span> <button class="btn secondary small" type="button" data-a="ord-inv-open">Ouvrir le PDF</button>'
        : inv.provider === 'pennylane' ? '<span class="tag ' + (inv.status === 'error' ? 'err' : 'wait') + '">' + esc(inv.status === 'missing_address' ? 'Adresse de facturation manquante' : 'Facture non créée') + '</span>' + (inv.error ? '<br><span class="small">' + esc(inv.error) + '</span>' : '') + '<br><button class="btn secondary small" type="button" data-a="ord-inv-retry"' + (S.busy ? ' disabled' : '') + '>Créer la facture</button>'
        : '<span class="tag off">Facture Stripe</span> <span class="small muted">(fiche client → Paiements)</span>';
      return back + errorBox() + '<div class="head"><div><h1>' + esc(m.title) + '</h1><p class="muted">Montage sur mesure · demande du ' + esc(fmtDate(m.createdAt)) + ' · n° ' + esc(m.id.slice(0, 8)) + '</p></div><div class="btns">' + tag(MONTAGE_STATUS[m.status], m.status) + '</div></div>' +
        prod +
        '<div class="card"><h2>Demande</h2><dl class="kvs">' + kv('Émission', esc(b.programme)) + kv('Formats', esc((b.formats || []).join(', '))) + kv('Pour le', b.deadline ? esc(fmtDay(b.deadline)) : '') + '</dl><p style="white-space:pre-line">' + esc(b.description || '—') + '</p></div>' +
        '<div class="card"><h2>Client</h2><dl class="kvs">' + kv('Entreprise', d.client ? '<a href="#clients/' + esc(d.client.id) + '">' + esc(d.client.company || d.client.name) + '</a>' : esc(ct.company)) + kv('Contact', esc(ct.name)) + kv('E-mail', esc(ct.email)) + kv('Téléphone', esc(ct.phone)) +
          kv('Facturation', bill ? esc([bill.company, bill.address, (bill.postalCode || '') + ' ' + (bill.city || ''), bill.vat ? 'TVA ' + bill.vat : ''].filter(function (x) { return x && x.trim(); }).join(' · ')) : '<span class="text-err">adresse non renseignée</span>') + '</dl></div>' +
        '<div class="card"><h2>Paiement et facture</h2><dl class="kvs">' + kv('Montant', esc(euros(m.amountHtCents)) + ' HT · ' + esc(euros(m.amountTtcCents)) + ' TTC') + kv('Payé le', m.paidAt ? esc(fmtDate(m.paidAt)) : '') + kv('Réf. Stripe', esc(m.stripePaymentIntent)) +
          kv('Facture', invLine) + kv('E-mail compta', m.accountingNotifiedAt ? 'envoyé le ' + esc(fmtDate(m.accountingNotifiedAt)) : (m.status === 'paid' ? '<span class="text-err">non envoyé</span>' : '')) + '</dl>' +
          (d.events && d.events.length ? '<table class="compact"><tbody>' + d.events.map(function (e) { return '<tr><td class="small nowrap">' + esc(fmtDate(e.at || e.created_at)) + '</td><td class="small">' + esc(PAY_EVENTS[e.kind] || e.kind) + (e.message ? ' · ' + esc(e.message) : '') + '</td></tr>'; }).join('') + '</tbody></table>' : '') + '</div>';
    }
    var o = d.order; var c = d.client;
    var files = d.deliverables.length ? '<table class="compact"><tbody>' + d.deliverables.map(function (f) {
      return '<tr><td><b>' + esc(f.title || f.fileName) + '</b><br><span class="small muted">' + esc(f.fileName) + '</span></td><td class="small nowrap">' + (f.durationMs ? esc(Math.round(f.durationMs / 1000)) + ' s' : '') + '</td><td>' + (f.url ? '<a class="btn secondary small" href="' + esc(f.url) + '" target="_blank" rel="noopener">Télécharger</a>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted">Aucun fichier livré pour le moment.</p>';
    var events = d.events.length ? '<table class="compact"><tbody>' + d.events.map(function (e) {
      var det = e.detail ? (typeof e.detail === 'string' ? e.detail : (e.detail.message || e.detail.error || e.detail.paymentRef || '')) : '';
      return '<tr><td class="small nowrap">' + esc(fmtDate(e.created_at)) + '</td><td class="small">' + esc(e.kind) + (det ? ' · ' + esc(String(det).slice(0, 200)) : '') + '</td></tr>';
    }).join('') + '</tbody></table>' : '<p class="muted">—</p>';
    return back + errorBox() + '<div class="head"><div><h1>' + esc(KIND_LABELS[o.kind] || o.type) + (o.options && o.options.duration ? ' · ' + esc(o.options.duration) + ' s' : '') + '</h1><p class="muted">Commande du ' + esc(fmtDate(o.created_at)) + ' · n° ' + esc(o.id.slice(0, 8)) + (o.programme ? ' · ' + esc(o.programme) : '') + '</p></div>' +
      '<div class="btns">' + tag(ORDER_STATUS[o.status], o.status) + (o.status === 'error' ? '<button class="btn" type="button" data-a="ord-retry"' + (S.busy ? ' disabled' : '') + '>Relancer</button>' : '') + '</div></div>' +
      (o.error ? '<div class="error" role="alert">' + esc(o.error) + '</div>' : '') +
      '<div class="card"><h2>Client</h2><dl class="kvs">' + kv('Entreprise', c ? '<a href="#clients/' + esc(c.id) + '">' + esc(c.company || c.name) + '</a>' : '') + kv('E-mail', c ? esc(c.email) : '') +
        kv('Crédits', Number(o.credits_cost) ? esc(o.credits_cost) + (Number(o.credits_charged) ? ' débités' : ' (rendus)') : '') + kv('Format', esc(o.options && o.options.format)) + '</dl></div>' +
      '<div class="card"><h2>Fichiers livrés</h2>' + files + '</div><div class="card"><h2>Chronologie</h2>' + events + '</div>';
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
  var MONTAGE_STATUS = { awaiting_payment: ['En cours de paiement', 'wait'], paid: ['Payée', 'ok'], to_quote: ['Devis à faire', 'info'], cancelled: ['Annulée', 'off'], abandoned: ['Abandonné', 'off'], error: ['Erreur technique', 'err'] };
  var PAY_ORIGINS = { client: 'Côté client', banque: 'Banque / Stripe', openmedias: 'Technique OpenMedias' };
  var PAY_EVENTS = { page_ouverte: 'Page de paiement ouverte', refus: 'Paiement refusé', erreur_technique: 'Erreur technique', paye: 'Payé', abandonne: 'Abandonné' };
  function originTag(o) { return o ? ' <span class="tag ' + (o === 'openmedias' ? 'err' : o === 'client' ? 'info' : 'wait') + '">' + esc(PAY_ORIGINS[o] || o) + '</span>' : ''; }
  /** Chronologie d'un paiement (fiche client). */
  function payTimeline(p) {
    if (!p.events || !p.events.length) return '';
    return '<details class="paytl"><summary class="small">Suivi du paiement (' + p.events.length + ')</summary><ol>' + p.events.map(function (e) {
      return '<li><span class="small nowrap muted">' + esc(fmtDate(e.at)) + '</span><span class="small"><b>' + esc(PAY_EVENTS[e.event] || e.event) + '</b>' + originTag(e.origin) +
        (e.message ? '<br><span class="muted">' + esc(e.message) + '</span>' : '') + '</span></li>';
    }).join('') + '</ol></details>';
  }
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
      return '<tr><td class="small nowrap">' + esc(fmtDate(p.paid_at || p.created_at)) + '</td><td>' + (p.kind === 'recharge' ? 'Recharge de crédits · ' : 'Montage sur mesure · ') + esc(p.offer_title) + '</td><td class="nowrap">' + esc(euros(p.amount_ttc_cents)) +
        '</td><td>' + (p.status === 'paid' && p.has_invoice
          ? '<button class="tag ok linkish" type="button" data-a="payment-invoice" data-id="' + esc(p.id) + '" title="Voir la facture">Payée · ' + (p.invoice_number ? 'facture ' + esc(p.invoice_number) : 'voir la facture') + '</button>'
          : p.status === 'paid' && p.invoice_provider === 'pennylane'
            ? tag('Payée', 'paid') + '<br><span class="small">' + esc(p.invoice_status === 'missing_address' ? 'Facture en attente : adresse de facturation manquante' : 'Facture Pennylane non créée' + (p.invoice_error ? ' : ' + p.invoice_error : '')) + '</span>'
          : tag(MONTAGE_STATUS[p.status], p.status) + (p.status !== 'paid' && p.last_payment_error
            ? '<br><span class="small">' + esc(p.last_payment_error) + '</span>' + originTag(p.failure_origin) + (p.payment_failures > 1 ? ' <span class="small muted">(' + p.payment_failures + ' essais)</span>' : '')
            : '')) + payTimeline(p) + '</td></tr>';
    }).join('') + '</tbody></table>' : emptyLine('Aucun paiement pour le moment.')) +
      '';

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
          '<div class="btns left"><button class="btn secondary" type="button" data-a="access-preview"' + (S.busy ? ' disabled' : '') + ' title="L’e-mail du jour J avec les données de ce client, envoyé à votre adresse ; le client ne reçoit rien">M’envoyer un aperçu de l’e-mail</button>' +
          '<button class="btn" type="button" data-a="access-send"' + (S.busy || !c.email ? ' disabled' : '') + (c.email ? '' : ' title="Renseignez d’abord l’e-mail du client"') + '>Envoyer le code au client</button>' +
          '<button class="btn danger" type="button" data-a="client-revoke"' + (S.busy ? ' disabled' : '') + '>Couper l’accès</button></div>') +
      marketingLine(c) + '</div>' +
      section('E-mails envoyés', d.emails.length, emails) + '</div></div>' +
      videoCard(d) +
      logosCard(d) +
      creditsCard(d) +
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
      saved[el.form.dataset.form + '|' + (el.form.dataset.id || '') + '|' + el.name] = el.value;
    });
    return saved;
  }
  function restoreFields(saved) {
    app.querySelectorAll('form[data-form] input[name], form[data-form] select[name]').forEach(function (el) {
      var k = el.form.dataset.form + '|' + (el.form.dataset.id || '') + '|' + el.name;
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
    app.querySelectorAll('[data-w]').forEach(function (el) { el.style.width = el.dataset.w + '%'; });
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
    if (S.page === 'diffusions') loadDiffusions();
    if (S.page === 'accueil') loadDashboard();
    if (S.page === 'commandes') loadOrders();
    if (S.page === 'alertes' || S.page === 'emails') loadEmails();
    if (S.page === 'emissions') {
      S.progLogos = null;
      api('GET', '/admin/programme-logos').then(function (d) { S.progLogos = d.programmes; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'tarifs' || S.page === 'credits') {
      S.creditSettings = null;
      api('GET', '/admin/credit-settings').then(function (d) { S.creditSettings = d; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'equipe' && isSuper()) {
      api('GET', '/admin/team').then(function (d) { S.team = d.users; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    if (S.page === 'journal' && isSuper()) {
      S.audit = null;
      api('GET', '/admin/audit?limit=200').then(function (d) { S.audit = d.entries; render(); }).catch(function (e) { S.error = e.message; S.audit = []; render(); });
    }
    render();
  }

  function loadOrders() {
    var sub = S.sub;
    if (sub) {
      var m = sub.split('/');
      S.ordDetail = null;
      return api('GET', '/admin/commandes/' + (m[0] === 'm' ? 'montages/' : 'creations/') + encodeURIComponent(m[1] || ''))
        .then(function (d) { S.ordDetail = d; render(); }).catch(function (e) { S.error = e.message; render(); });
    }
    return api('GET', '/admin/commandes').then(function (d) { S.ord = d; render(); }).catch(function (e) { S.error = e.message; render(); });
  }

  function loadDashboard() {
    return api('GET', '/admin/dashboard?days=' + encodeURIComponent(S.dashDays || '30')).then(function (d) { S.dash = d; render(); }).catch(function (e) { S.error = e.message; render(); });
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
    'ord-filter': function () { return Promise.resolve(); },
    'redirect-add': function (f) {
      var email = f.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Promise.reject(new Error('Adresse e-mail invalide.'));
      if (!/@openmedias\.fr$/i.test(email)) return Promise.reject(new Error('Seules les adresses @openmedias.fr peuvent recevoir les e-mails de test.'));
      if (S.redirect.list.indexOf(email) !== -1) return Promise.reject(new Error(email + ' reçoit déjà les e-mails de test.'));
      if (S.redirect.mode === 'reel' && !window.confirm('La plateforme envoie actuellement les e-mails aux vrais destinataires. Ajouter cette adresse la fait repasser en mode test : TOUS les e-mails partiront vers les adresses de test. Continuer ?')) return Promise.resolve();
      return api('PUT', '/admin/email-redirect', { list: S.redirect.list.concat([email]) }).then(function (d) {
        S.redirect = d;
        var cur = app.querySelector('form[data-form="redirect-add"] input[name="email"]'); if (cur) cur.value = '';
        toast(email + ' recevra les e-mails de test');
      });
    },
    'alert-add': function (f) {
      var type = f.dataset.id; var email = f.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return Promise.reject(new Error('Adresse e-mail invalide.'));
      var t = S.alerts.types.filter(function (x) { return x.id === type; })[0];
      if (t.recipients.indexOf(email) !== -1) return Promise.reject(new Error(email + ' reçoit déjà cette alerte.'));
      return saveAlerts(type, t.recipients.concat([email])).then(function () {
        var cur = app.querySelector('form[data-form="alert-add"][data-id="' + type + '"] input[name="email"]'); if (cur) cur.value = '';
        toast('Destinataire ajouté');
      });
    },
    'ord-prod': function (f) {
      var m = S.ordDetail && S.ordDetail.montage;
      return api('POST', '/admin/commandes/montages/' + encodeURIComponent(m.id) + '/production', { status: f.status.value, note: f.note.value })
        .then(function () { toast('Avancement enregistré'); return loadOrders(); });
    },
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
    'diff-filter': function () { return Promise.resolve(); },
    'client-new': function (f) {
      return api('POST', '/admin/clients', readClientForm(f)).then(function (d) {
        S.client = null;
        location.hash = '#clients/' + d.client.id;
        toast('Client créé');
      });
    },
    'credits-adjust': function (f) {
      var n = Number(f.credits.value);
      if (!Number.isInteger(n) || !n) return Promise.reject(new Error('Indiquez un nombre entier de crédits, par exemple 300 ou -300.'));
      if (!f.reason.value.trim()) return Promise.reject(new Error('Indiquez le motif de l’ajustement.'));
      return api('POST', '/admin/clients/' + encodeURIComponent(S.client.client.id) + '/credits/adjust', { credits: n, reason: f.reason.value }).then(function () {
        toast((n > 0 ? '+' : '') + nb(n) + ' crédits appliqués');
        return loadClients();
      });
    },
    'credit-settings': function (f) {
      return api('POST', '/admin/credit-settings', readTarifs(f)).then(function (d) {
        S.creditSettings.settings = d.settings; S.creditSettings.stripe = d.stripe; S.creditSettings.dirty = false;
        toast(d.stripe && d.stripe.ok === false ? 'Tarifs enregistrés (Stripe à réessayer)' : 'Tarifs enregistrés');
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
      var username = f.username.value.trim().toLowerCase();
      if (!username) return Promise.reject(new Error('Identifiant requis.'));
      return api('POST', '/admin/team', { name: name, email: f.email.value, username: username, role: f.role.value })
        .then(function (d) {
          S.lastLink = { name: d.user.name, username: d.user.username, url: d.inviteLink };
          f.reset();
          return api('GET', '/admin/team');
        })
        .then(function (d) { S.team = d.users; });
    },
  };

  /** Identifiant prérempli : la partie avant @ de l'e-mail (thomas.d@openmedias.fr → thomas.d), tant qu'il n'a pas été modifié à la main. */
  function usernameFrom(email) { return String(email || '').split('@')[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9._-]/g, '').slice(0, 40); }
  app.addEventListener('input', function (ev) {
    var f = ev.target.form;
    if (f && f.dataset.form === 'team-add') {
      if (ev.target.name === 'username') f.username.dataset.touched = f.username.value ? '1' : '';
      if (ev.target.name === 'email' && !f.username.dataset.touched) f.username.value = usernameFrom(f.email.value);
      return;
    }
    if (f && f.dataset.form === 'diff-filter') { S.diffFilter = { q: f.q.value, view: f.view.value }; return render(); }
    if (f && f.dataset.form === 'ord-filter') { S.ordFilter = { q: f.q.value, view: f.view.value, family: f.family.value }; return render(); }
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
    'diff-sync': function () {
      withBusy(api('POST', '/admin/diffusions/sync').then(function (d) {
        var r = d.lastSync;
        toast(r.created || r.updated ? 'Planning relu : ' + r.created + ' ajoutée(s), ' + r.updated + ' mise(s) à jour' : 'Planning relu : rien de nouveau');
        return loadDiffusions();
      }));
    },
    'diff-drive': function () {
      withBusy(api('POST', '/admin/diffusions/drive').then(function (d) {
        var r = d.lastDrive || {};
        toast(r.imported ? 'Une vidéo a été importée' : 'Drive vérifié : aucune nouvelle vidéo');
        return loadDiffusions();
      }));
    },
    'reload-dash': function () { S.dash = null; loadPage(); },
    'dash-period': function (p) { S.dashDays = p; S.dash = null; render(); loadDashboard(); },
    'tarifs-add': function () {
      var f = document.querySelector('form[data-form="credit-settings"]');
      var st = S.creditSettings; st.settings = readTarifs(f);
      st.settings.packs.push({ id: 'pack-' + Date.now().toString(36), label: 'Nouveau pack', credits: st.settings.prices.capsules || 300, priceHT: 69 });
      st.dirty = true; render();
    },
    'tarifs-del': function (i) {
      var f = document.querySelector('form[data-form="credit-settings"]');
      var st = S.creditSettings; st.settings = readTarifs(f);
      st.settings.packs.splice(Number(i), 1);
      st.dirty = true; render();
    },
    'tarifs-sync': function () {
      withBusy(api('POST', '/admin/credit-settings/stripe-sync').then(function (d) { S.creditSettings.stripe = d.stripe; }));
    },
    'client-restore': function () {
      var c = S.client.client;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/restore').then(function () {
        toast('Accès rétabli : le même code fonctionne à nouveau');
        return loadClients();
      }));
    },
    'logo-pos': function (arg) {
      var kp = String(arg).split(':');
      var c = S.client.client;
      if (S.client.logos[kp[0]].position === kp[1]) return;
      S.client.logos[kp[0]].position = kp[1]; render();
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/logos', { kind: kp[0], position: kp[1] }).then(function (d) {
        S.client.logos = d.logos; toast('Position enregistrée : ' + POS_LABELS[kp[1]].toLowerCase());
      }));
    },
    'logo-remove': function (kind) {
      var c = S.client.client;
      if (!window.confirm('Retirer ce logo ?')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/logos', { kind: kind, key: null }).then(function (d) { S.client.logos = d.logos; toast('Logo retiré'); }));
    },
    'prog-logo-remove': function (id) {
      if (!window.confirm('Retirer le logo de cette émission ? Ses vidéos sortiront sans logo de média, sauf pour les clients qui ont leur propre logo.')) return;
      withBusy(api('POST', '/admin/programme-logos', { programmeId: id, key: null }).then(function () {
        return api('GET', '/admin/programme-logos').then(function (d) { S.progLogos = d.programmes; toast('Logo retiré'); });
      }));
    },
    'logo-om-reset': function () {
      withBusy(api('POST', '/admin/branding/openmedias-logo', { key: null }).then(function () { toast('Logo OpenMedias par défaut rétabli'); return loadClients(); }));
    },
    'access-preview': function () {
      var c = S.client.client;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/preview').then(function (d) { toast('Aperçu envoyé à ' + d.to); }));
    },
    'access-send': function () {
      var c = S.client.client;
      if (!window.confirm('Envoyer maintenant le code d’accès à ' + c.name + ' (' + c.email + ') ? C’est le vrai e-mail du jour J.')) return;
      withBusy(api('POST', '/admin/clients/' + encodeURIComponent(c.id) + '/access/send').then(function (d) {
        toast(d.redirectedTo ? 'Mode test : e-mail envoyé à ' + d.redirectedTo : 'Code envoyé à ' + c.email);
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
    'alert-del': function (v) {
      var i = v.indexOf('|'); var type = v.slice(0, i); var email = v.slice(i + 1);
      var t = S.alerts.types.filter(function (x) { return x.id === type; })[0];
      if (!t || !window.confirm('Retirer ' + email + ' des destinataires de l’alerte « ' + t.label + ' » ?')) return;
      withBusy(saveAlerts(type, t.recipients.filter(function (e) { return e !== email; })).then(function () { toast('Destinataire retiré'); }));
    },
    'email-toggle': function (id) {
      var e = S.emailsCfg.emails.filter(function (x) { return x.id === id; })[0]; if (!e) return;
      if (e.enabled && !window.confirm('Mettre en pause « ' + e.label + ' » ?\n\n' + e.paused)) return;
      var disabled = S.emailsCfg.emails.filter(function (x) { return x.id === id ? x.enabled : !x.enabled; }).map(function (x) { return x.id; });
      withBusy(saveEmailToggles(disabled).then(function () { toast(e.enabled ? 'E-mail mis en pause' : 'E-mail réactivé'); }));
    },
    'redirect-del': function (email) {
      var rest = S.redirect.list.filter(function (x) { return x !== email; });
      if (!window.confirm(rest.length ? 'Retirer ' + email + ' ? Les e-mails de test ne lui seront plus envoyés.' : 'Retirer la dernière adresse de test ? Si l’envoi réel est autorisé sur le serveur, les e-mails partiront alors aux VRAIS clients.')) return;
      withBusy(api('PUT', '/admin/email-redirect', { list: rest }).then(function (d) { S.redirect = d; toast('Adresse retirée'); }));
    },
    'email-test': function (id) {
      withBusy(api('POST', '/admin/email-settings/' + encodeURIComponent(id) + '/test').then(function (d) { toast('Test envoyé à ' + d.to); }));
    },
    'emails-all-off': function () {
      if (!window.confirm('Mettre en pause tous les e-mails automatiques (clients et équipe) ?\n\nPlus aucun code d’accès ne partira automatiquement le jour de la diffusion, et « Code oublié » ne fonctionnera plus.')) return;
      withBusy(saveEmailToggles(S.emailsCfg.emails.map(function (x) { return x.id; })).then(function () { toast('Tous les e-mails automatiques sont en pause'); }));
    },
    'emails-all-on': function () {
      if (!window.confirm('Réactiver tous les e-mails automatiques ?')) return;
      withBusy(saveEmailToggles([]).then(function () { toast('Tous les e-mails automatiques sont actifs'); }));
    },
    'ord-reload': function () { withBusy(loadOrders()); },
    'ord-view': function (v) { S.ordFilter.view = v; render(); },
    'ord-retry': function () {
      var o = S.ordDetail && S.ordDetail.order; if (!o || !window.confirm('Relancer cette commande ? Les crédits rendus au client seront débités à nouveau.')) return;
      withBusy(api('POST', '/admin/commandes/creations/' + encodeURIComponent(o.id) + '/retry').then(function () { toast('Commande relancée'); return loadOrders(); }));
    },
    'ord-inv-retry': function () {
      var m = S.ordDetail && S.ordDetail.montage; if (!m) return;
      withBusy(api('POST', '/admin/commandes/montages/' + encodeURIComponent(m.id) + '/invoice').then(function (d) { toast('Facture ' + (d.number || '') + ' créée'); return loadOrders(); }));
    },
    'ord-inv-open': function () {
      var m = S.ordDetail && S.ordDetail.montage; if (!m) return;
      var w = window.open('', '_blank');
      api('GET', '/admin/commandes/montages/' + encodeURIComponent(m.id) + '/invoice').then(function (d) { if (w) w.location = d.url; else window.location.href = d.url; })
        .catch(function (e) { if (w) w.close(); S.error = e.message; render(); window.scrollTo(0, 0); });
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

  app.addEventListener('change', function (ev) {
    var sel = ev.target.closest('select.role-select');
    if (sel) {
      var u = (S.team || []).filter(function (x) { return x.id === sel.dataset.id; })[0];
      var label = sel.value === 'super_admin' ? 'Super admin' : 'Admin';
      if (!u || !window.confirm('Passer ' + u.name + ' en « ' + label + ' » ?' + (sel.value === 'super_admin' ? ' Il pourra gérer l’équipe et voir le journal d’activité.' : ''))) { render(); return; }
      withBusy(api('POST', '/admin/team/' + encodeURIComponent(u.id) + '/role', { role: sel.value }).then(function (d) {
        toast('Rôle de ' + d.user.name + ' : ' + label);
        return api('GET', '/admin/team');
      }).then(function (d) { S.team = d.users; }));
      return;
    }
    var inp = ev.target.closest('input[data-logo]');
    if (inp && inp.files && inp.files[0]) uploadLogo(inp.dataset.logo, inp.files[0]);
  });

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
