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
