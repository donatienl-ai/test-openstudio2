# Back-office OpenStudio (espace équipe)

Application réservée à l'équipe OpenMedias, séparée du site client. Aucun fichier de ce dossier n'est livré aux clients.

- `index.html`, `style.css`, `app.js` : l'application, sans dépendance ni étape de construction.
- `config.js` : l'adresse du serveur (`openstudio-backend`).

## Mise en ligne sur Render (une seule fois)

1. **New → Static Site**, dépôt `test-openstudio2`, branche `main` (ou la branche de recette pour tester).
   - *Root Directory* : `admin`
   - *Build Command* : laisser vide
   - *Publish Directory* : `.`
2. **Headers** du site statique, chemin `/*` :
   - `X-Frame-Options: DENY`
   - `X-Content-Type-Options: nosniff`
   - `Referrer-Policy: no-referrer`
   - `Strict-Transport-Security: max-age=31536000`
3. **Settings → Custom Domains** : ajouter `admin.openstudio.fr`. Render indique alors l'enregistrement **CNAME** à créer chez le gestionnaire du domaine `openstudio.fr`.
4. Sur le service **openstudio-backend**, renseigner les variables du back-office (voir plus bas), puis redéployer.
5. Ouvrir les logs du service `openstudio-backend` : au démarrage, la ligne `[back-office] Lien d'activation du super admin …` donne le lien d'activation du premier compte, valable 72 heures.

Si l'adresse du serveur change, modifier `config.js` **et** `connect-src` dans la balise `Content-Security-Policy` d'`index.html`.

## Variables du serveur `openstudio-backend`

| Variable | Rôle |
|---|---|
| `ADMIN_ORIGIN` | Adresse du back-office, sans barre finale : `https://admin.openstudio.fr`. Sert au CORS et aux liens d'activation. |
| `ADMIN_ENCRYPTION_KEY` | Clé de chiffrement des secrets de double authentification, 32 caractères minimum. Générée par Render. **Ne jamais la changer** : les comptes devraient tous être réactivés. |
| `ADMIN_BOOTSTRAP_EMAIL` | E-mail du super admin, créé automatiquement au premier démarrage. |
| `ADMIN_BOOTSTRAP_NAME` | Nom affiché du super admin. |
| `ADMIN_SESSION_HOURS` | Durée d'une session, 12 h par défaut. |
| `ADMIN_REQUIRE_2FA` | `true` pour exiger un code à 6 chiffres (Google Authenticator…) en plus du mot de passe. Désactivé par défaut. Les comptes déjà activés devront refaire leur activation (« Réinitialiser l'accès ») pour configurer le code. |
| `CLIENT_SITE_URL` | Adresse de l'espace client, utilisée dans les liens d'accès (par défaut : la première adresse de `FRONTEND_ORIGIN`). |
| `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` | Clés Mailjet, les mêmes que sur l'ancien serveur. Sans elles, aucun lien ne part par e-mail. |
| `MAILJET_FROM_EMAIL` | Expéditeur, `communication@openmedias.fr` par défaut. |
| `MAIL_REDIRECT_TO` | **Tests** : tous les e-mails partent vers cette adresse au lieu des clients. |
| `MAIL_ALLOW_REAL_RECIPIENTS` | `1` pour envoyer réellement aux clients (au lancement). Sans cette valeur ni `MAIL_REDIRECT_TO`, rien ne part. |
| `MJ_TPL_CLIENT_ACCESS` | Identifiant du modèle Mailjet du code d'accès (variables `nom`, `entreprise`, `lien`, `code`, `date_diffusion`, `credits_jusqu_au`). Vide : e-mail texte simple. |
| `TEAM_ALERT_EMAIL` | Adresse qui reçoit les alertes « diffusion incomplète » (`communication@openmedias.fr`). |
| `PLANNING_EXPORT_URL`, `PLANNING_EXPORT_KEY` | Lecture du planning du dashboard (rubrique Diffusions). La clé est la même que `OPENSTUDIO_EXPORT_KEY` sur le dashboard. |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `DRIVE_ROOT_FOLDER_ID` | Dossiers Google Drive des diffusions et import des vidéos déposées par les monteurs. |
| `MJ_TPL_CREDITS_RECHARGE` | Identifiant du modèle Mailjet de la confirmation de recharge (variables `nom`, `entreprise`, `pack`, `credits`, `montant_ttc`, `solde`, `valable_jusqu_au`, `lien`). Vide : e-mail texte simple. |
| `ADMIN_TOKEN` | Ancien jeton technique, encore accepté pendant la transition (droits admin, pas super admin). **À supprimer avant la mise en production.** |

## Comptes et sécurité

- Deux rôles : **super admin** (tout, plus la gestion des comptes de l'équipe et le journal d'activité) et **admin**.
- Un compte est créé par le super admin, qui transmet le lien d'activation (valable 72 h, utilisable une fois). La personne choisit son mot de passe (9 caractères minimum, avec au moins une lettre et un chiffre, par exemple 8 chiffres et 1 lettre), puis, si `ADMIN_REQUIRE_2FA=true`, configure la double authentification dans une application comme Google Authenticator.
- Identifiant de connexion : la partie avant le @ de l'e-mail (`thomas.d@openmedias.fr` → `thomas.d`), modifiable à la création du compte. L'e-mail complet est aussi accepté.
- Connexion : identifiant et mot de passe ; avec `ADMIN_REQUIRE_2FA=true`, un code à 6 chiffres en plus (un code ne sert qu'une fois).
- Après 5 échecs, le compte est bloqué 15 minutes. Chaque adresse IP est limitée à 20 tentatives par quart d'heure.
- Mot de passe oublié ou téléphone perdu : le super admin clique sur « Réinitialiser l'accès » et transmet le nouveau lien. L'ancien accès est coupé immédiatement.
- La base ne contient ni jeton utilisable (les jetons sont hachés) ni secret de double authentification en clair (il est chiffré).
- Les actions sensibles sont inscrites au journal d'activité : connexions, comptes, clients, vidéos, relances de commandes.

## Clients et codes d'accès

- Chaque client a un **code d'accès** personnel au format `OM-XXXX-XX` (6 caractères tirés au hasard, sans O, I, L, 0 ni 1). Il s'affiche en permanence sur la fiche client. Le serveur le garde chiffré (`ADMIN_ENCRYPTION_KEY`) pour l'afficher, et vérifie les connexions avec son empreinte.
- Le client saisit son code sur la page de connexion de l'espace client (ou ouvre le lien de l'e-mail, qui le remplit pour lui). Son navigateur reste ensuite connecté 180 jours : il n'a pas à ressaisir le code à chaque visite.
- **Le jour de la diffusion de la vidéo, à partir de 8 h** (heure de Paris), un code est créé et envoyé à l'e-mail du client. Tant qu'aucune vidéo n'est déposée, rien ne part. En cas d'échec, nouvel essai toutes les heures, 5 fois au plus.
- Depuis la fiche client : **envoyer le code tout de suite**, **générer un nouveau code** à transmettre soi-même, ou **couper l'accès**. Un nouveau code remplace l'ancien pour se connecter ; les navigateurs déjà connectés le restent, sauf si l'accès est coupé (tous sont alors déconnectés).
- Connexion par code limitée à 10 essais par quart d'heure et par adresse IP.
- Les anciens liens (`?client=…&clientToken=…`) des clients créés avant les codes restent valables jusqu'au premier code généré.
- **Import CSV** : colonnes `nom`, `entreprise`, `email`, `date de diffusion` (JJ/MM/AAAA), `package`, `notes`. Séparateur `;` (Excel) ou `,`. Les e-mails déjà présents sont ignorés. Le consentement marketing n'est pas importé : le client le donne lui-même.
- **Fiche client** : informations, réponse du client sur les campagnes marketing (posée dans son espace à la première connexion), e-mails envoyés, émissions (retirées comprises), contenus générés et publications, paiements et factures, historique des actions.
- **Émissions proposées** : BFM TV, BFM Business, Capital, Le Figaro (`src/opusclip.config.js`). Le logo du Figaro reste à fournir.
- **Espace client** : le client voit et lit la vidéo de son émission déposée par l'équipe ; sans vidéo, « Votre vidéo sera bientôt disponible ». Il ne peut pas déposer de vidéo lui-même (mettre `CLIENT_UPLOADS_ENABLED=false` sur le serveur).

## Diffusions (planning, Google Drive, alertes)

La rubrique **Diffusions** montre les diffusions vidéo du planning du dashboard (formats Plateau TV et Immersion), relues toutes les heures (bouton « Relire le planning » pour ne pas attendre).

- **Diffusion confirmée dans le planning** : la fiche client est créée si l'entreprise n'en a pas encore (même entreprise = même fiche, accents, casse et forme juridique ignorés), avec son code d'accès et ses crédits offerts. L'e-mail vient du signataire du bon de commande DocuSign, à défaut du contact de l'opportunité Salesforce ; il complète la fiche s'il manquait, sans jamais remplacer un e-mail existant. La date de la fiche suit la première diffusion tant que le code n'est pas parti.
- **Report ou annulation dans le planning** : la diffusion, son dossier Drive et sa vidéo suivent. Un BDC envoyé mais pas signé ne crée rien.
- **Google Drive** : un dossier par client et un sous-dossier par diffusion (`2026-12-03 – BFM Business 1&2 – Plateau TV`, « date à fixer » sinon, « Annulées » pour les annulations). La vidéo déposée par le monteur est importée dès que l'envoi est terminé et rattachée à la fiche avec sa date de diffusion. Une vidéo déposée à la main sur la fiche, à la même date, compte aussi.
- **Code d'accès** : il part le jour de la diffusion à partir de 8 h, à l'e-mail du client, seulement si la vidéo est là. L'e-mail contient le code, les raisons d'utiliser OpenStudio et la date de fin de validité des crédits (30 jours), pas la vidéo.
- **Alertes** à `TEAM_ALERT_EMAIL` quand une diffusion est incomplète (vidéo ou e-mail manquant) : à J-2, avancé au vendredi si J-2 tombe un week-end (J-3 pour un lundi), puis le jour J si rien n'a bougé. Rien n'est envoyé quand tout est en ordre.
