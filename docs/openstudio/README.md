# OpenStudio — intégration OpusClip

```
render.yaml                  Blueprint Render (service back-end + base Postgres)
openstudio-backend/          Service Node.js : commandes, OpusClip, ffmpeg, stockage, téléchargements
frontend/                    À copier dans le site statique : openstudio-api.js, mes-commandes.html
frontend/INTEGRATION.md      Comment brancher les boutons de l'onglet « Créer »
```

## Fonctionnement

1. **Espace client** : l'équipe crée chaque client (avec le logo de son entreprise) et enregistre
   les vidéos de **son package** (ex. un passage BFM Business ; ou un passage BFM + une immersion).
   Le client reçoit un lien d'accès et ne voit que ses vidéos à l'étape 1 de la page Capsules.
2. Le client choisit ses réglages et **valide**. Le serveur contrôle chaque option et refuse
   clairement une vidéo hors package, une durée ou un style non configurés, etc.
3. **Paiement** : simulé en test (`MockPaymentProvider`). Le traitement démarre uniquement quand la
   commande est validée **et** payée, une seule fois même si la confirmation arrive plusieurs fois.
4. **Capsules vidéo** : la vidéo du package est envoyée à OpusClip (`upload-links`), puis le projet
   est créé avec la durée (15/30/45/60 s), le format (9:16, 1:1, 16:9) et le style (Impact,
   Classique, Discret → brand kits). Les clips sont récupérés, le logo de l'entreprise (en haut à
   gauche) et celui du média (en haut à droite) sont ajoutés avec ffmpeg.
5. **Sous-titres** (vidéo entière, français ou anglais) :
   - fichier **.srt / .vtt** importé → lu, recalé, découpé si l'option est cochée, puis rendu
     localement : **aucun crédit OpusClip** ;
   - sans fichier (production) → OpusClip transcrit la vidéo (`skipCurate: true`), la
     transcription mot à mot (`GET /api/transcripts`) est transformée en sous-titres.
   Dans les deux cas : style unique **DM Sans Regular, blanc, contour noir, sans fond**, avec la
   taille et le contour choisis, et trois livrables : **.srt**, **.vtt** et **vidéo sous-titrée**
   (avec le logo de l'entreprise, et celui du média si le programme est indiqué).
6. OpusClip prévient le serveur par **webhook signé** (signature, horodatage et rejeu vérifiés).
   Si le service Render dormait, une vérification régulière prend le relais.
7. Les fichiers finaux sont stockés dans **Cloudflare R2 / S3**. Le client les retrouve dans
   **mes-commandes.html** (aperçu, téléchargement par fichier ou zip, liens signés de courte durée).

Les commandes **Visuels** et **Publications** ne déclenchent jamais OpusClip.

## Espace client (équipe)

Toutes ces requêtes portent l'en-tête `Authorization: Bearer <ADMIN_TOKEN>`.

```bash
API=https://openstudio-backend.onrender.com
AUTH="Authorization: Bearer $ADMIN_TOKEN"

# 1. Créer le client → renvoie client.id et clientToken
curl -X POST $API/api/admin/clients -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Ecoval Industries","company":"Ecoval Industries","logoKey":"clients/ecoval/logo.png"}'

# 2. Ajouter les vidéos de son package (fichiers déjà déposés dans le stockage)
curl -X POST $API/api/admin/clients/<CLIENT_ID>/videos -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"programmeId":"bfm-business","title":"Vision d’entreprises — 12 mars","sourceKey":"clients/ecoval/bfm-business.mp4","broadcastDate":"2026-03-12"}'

# 3. Lien à envoyer au client
#    https://VOTRE-SITE/?client=<CLIENT_ID>&clientToken=<CLIENT_TOKEN>
```

Programmes disponibles (logos, langue) : `programmes` dans `src/opusclip.config.js`
(BFM Business, BFM, Capital — à compléter). Les logos sont des PNG blancs sur fond transparent
déposés dans le stockage ; leur clé est indiquée dans `logoKey`.

## Codes de connexion

Chaque client reçoit un code aléatoire au format `OM-XXXX-XX` (celui de l'écran de connexion) dès sa création.
Le client le saisit sur la page d'accueil : le serveur le vérifie (`POST /api/login`) et ouvre son espace.

- Variable `LOGIN_CODE_SECRET` obligatoire (générée par Render, voir `render.yaml`) ; **ne jamais la changer**,
  sinon tous les codes déjà donnés cessent de fonctionner. Sans elle, la connexion par code est désactivée.
- En base : une empreinte du code (pour la connexion) et une copie chiffrée, lisible par l'équipe jusqu'à l'envoi
  du mail du jour J.
- Essais ratés limités à `LOGIN_MAX_FAILS` (10) par adresse IP sur `LOGIN_FAIL_WINDOW_MIN` (15) minutes.
- Les codes de démonstration de `index.html` restent valables pour l'équipe ; ils sont vérifiés en premier.
- Au démarrage, les clients créés avant l'arrivée des codes en reçoivent un automatiquement.

```bash
# Code d'un client (tant qu'il n'a pas été envoyé)
curl $API/api/admin/clients/<CLIENT_ID>/code -H "$AUTH"
# Nouveau code (code perdu) : l'ancien cesse aussitôt de fonctionner
curl -X POST $API/api/admin/clients/<CLIENT_ID>/code -H "$AUTH"
```

La création d'un client (`POST /api/admin/clients`) renvoie aussi son code dans `loginCode`.

## Synchronisation avec le planning de diffusion

OpenStudio relit le planning du dashboard toutes les `PLANNING_SYNC_MIN` minutes (60 par défaut) via sa route
d'export en lecture seule (`PLANNING_EXPORT_URL` + `PLANNING_EXPORT_KEY`, même clé que `OPENSTUDIO_EXPORT_KEY`
côté dashboard).

| Statut dans le planning | Effet dans OpenStudio |
|---|---|
| BDC envoyé, pas signé (`bdc_attente`) | Rien |
| Confirmée | Ligne `diffusions` active ; client créé s'il n'existe pas (avec son code), e-mail du signataire du BDC |
| À programmer | Ligne en attente de date (`date_pending`) |
| Date modifiée | Date mise à jour (report) |
| Annulée | Ligne `cancelled` (aucun mail) ; réactivée si la diffusion revient |

Un client = un espace : les diffusions d'une même entreprise (nom normalisé : sans accents, ponctuation ni
forme juridique) sont rattachées au même client. L'e-mail du client est complété s'il manquait, jamais écrasé.

```bash
curl $API/api/admin/diffusions -H "$AUTH"                  # diffusions + compte rendu de la dernière lecture
curl -X POST $API/api/admin/planning/sync -H "$AUTH"       # relire le planning tout de suite
```

## Google Drive : dossiers des diffusions et vidéos des monteurs

Dans le Drive partagé `DRIVE_ROOT_FOLDER_ID`, OpenStudio crée automatiquement (toutes les `DRIVE_SYNC_MIN` minutes) :

```
<Entreprise>/
  2026-12-03 – BFM Business 1&2 – Plateau TV/     ← le monteur dépose la vidéo ici
  date à fixer – Capital – Immersion/
Annulées/                                         ← dossiers des diffusions annulées (jamais supprimés)
```

- Les dossiers sont renommés en cas de report et rangés dans « Annulées » en cas d'annulation. Une étiquette
  invisible relie chaque dossier à sa diffusion : renommer ou déplacer un dossier à la main ne casse pas le lien.
- Une vidéo déposée est importée dès qu'elle n'a plus été modifiée depuis `DRIVE_SETTLE_MIN` minutes (envoi
  terminé), copiée dans le stockage et rattachée au client. Si plusieurs vidéos sont présentes, la plus récente.
- La vidéo n'apparaît dans l'espace du client **qu'à partir du jour de diffusion** (heure de Paris), et jamais
  tant que la date est à fixer ou si la diffusion est annulée. Un report déplace aussi la date de la vidéo.
- `POST /api/admin/drive/sync` lance un passage tout de suite.
- Médias sans logo configuré (Le Figaro, TIME…) : à ajouter dans `programmes` de `src/opusclip.config.js`.

## Jour de diffusion : mail au client et alertes à l'équipe

Toutes les 10 minutes, OpenStudio regarde les diffusions actives (`src/broadcastDay.js`) :

| Situation | Ce qui se passe |
|---|---|
| Jour J, vidéo + e-mail présents, à partir de `MAIL_SEND_HOUR` (8 h, Paris) | **Premier mail** du client : code de connexion, arguments, crédits valables 30 jours (la vidéo n'est pas dans le mail : le client la trouve dans son espace). Le code n'est ensuite plus lisible par l'équipe (un nouveau peut être généré). |
| Client déjà prévenu pour une diffusion précédente | Mail « votre nouvelle émission est en ligne » (même code, pas de nouveaux crédits) |
| Jour J incomplet (vidéo ou e-mail manquant) | Pas de mail ; alerte à `TEAM_ALERT_EMAIL`. Le mail part dès que l'élément arrive (jusqu'à 7 jours après la date). |
| J-2 / J-1 incomplet | Alerte à l'équipe, une fois par diffusion |

Destinataire : toujours l'e-mail du client (rempli depuis le signataire du BDC ou le contact Salesforce, corrigeable par l'équipe).
Pas de mail client avant 8 h ni après 20 h. Une diffusion n'est jamais envoyée deux fois (réservation avant envoi).

**Tests :** tant que `MAIL_ALLOW_REAL_RECIPIENTS` n'est pas à `1`, tout part vers `MAIL_REDIRECT_TO` avec `[TEST]`
dans le sujet. Les modèles Mailjet de l'équipe communication (`MJ_TPL_*`) reçoivent les variables `prenom`,
`entreprise`, `nom_emission`, `code`, `lien`, `date_expiration` ; sans eux, un contenu de secours est utilisé.

```bash
curl -X POST $API/api/admin/broadcast/run -H "$AUTH"                     # passage immédiat
curl -X PATCH $API/api/admin/clients/<CLIENT_ID>/email -H "$AUTH" -H 'Content-Type: application/json' \
     -d '{"email":"claire@entreprise.fr"}'                               # corriger l'e-mail du client
```

## Mode test : dépôt de vidéo par le client

Deux variables, à retirer en production (voir `render.yaml`) :
- `CLIENT_UPLOADS_ENABLED=true` : la page Capsules vidéo affiche un bloc « Déposer une vidéo » ; la vidéo est envoyée
  au stockage puis ajoutée au package du client (`POST /api/me/videos`). En production (`false`), seule l'équipe ajoute
  les vidéos (`POST /api/admin/clients/:id/videos`) et le client les voit directement.
- `TEST_CLIENT_NAME` : un client de test est créé au démarrage s'il n'existe pas ; le lien d'accès à son espace est
  écrit dans les logs Render (ligne `[test] Lien de l'espace client`).

## Mise en route

### 1. Stockage (Cloudflare R2)
- Créer un bucket (ex. `openstudio`) et une clé API R2 (lecture/écriture sur ce bucket).
- Règle CORS du bucket, pour permettre l'envoi direct depuis le navigateur :
  ```json
  [{ "AllowedOrigins": ["https://VOTRE-SITE.onrender.com"],
     "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["Content-Type"], "MaxAgeSeconds": 3600 }]
  ```
- Déposer les logos des programmes (`programmes/<id>/logo.png`, PNG transparent), puis pour
  chaque client son logo et les vidéos de son package (ex. `clients/<client>/…`).

### 2. Render
- Placer `render.yaml` et le dossier `openstudio-backend/` à la racine du dépôt GitHub.
- Render → **New → Blueprint** → choisir le dépôt. Cela crée le service et la base.
- Renseigner les variables marquées `sync: false` (voir `openstudio-backend/.env.example`).
  `PUBLIC_BASE_URL` = URL du service back-end, `FRONTEND_ORIGIN` = URL du site statique.
- Laisser `OPUSCLIP_DRY_RUN=true` pour les premiers tests : tout le parcours fonctionne,
  les requêtes OpusClip sont affichées dans les logs sans être envoyées (0 crédit).

### 3. Brand templates
```bash
cd openstudio-backend && npm install
OPUSCLIP_API_KEY=sk-... npm run opus:templates
```
Copier les identifiants dans `src/opusclip.config.js`.

### 4. Configurer les correspondances
Dans `openstudio-backend/src/opusclip.config.js` : remplacer les presets provisoires des styles
Impact / Classique / Discret par vos brand kits, compléter les programmes, et aligner les
libellés **Taille** et **Contour** de la page Sous-titres.
Déposer **DMSans-Regular.ttf** (police libre, Google Fonts) dans `openstudio-backend/assets/fonts/`.

### 5. Front
Copier `frontend/openstudio-api.js` et `frontend/mes-commandes.html` dans le site, puis
brancher les boutons comme décrit dans `frontend/INTEGRATION.md`.

### 6. Passer en réel
`OPUSCLIP_DRY_RUN=false`. Commencer par une commande courte pour contrôler la consommation
de crédits (suivi : `GET /api/admin/orders` avec `Authorization: Bearer <ADMIN_TOKEN>`).

## Test réel avec un client de test

`OPUSCLIP_DRY_RUN=true` laisse toutes les commandes en dry run, **sauf** celles des clients listés dans
`OPUSCLIP_LIVE_CLIENTS` : elles sont réellement envoyées à OpusClip (crédits consommés), puis passent
par le post-traitement (logos) et la livraison comme en production. Garde-fous : `OPUSCLIP_API_KEY`
obligatoire, vidéo de `OPUSCLIP_LIVE_MAX_MINUTES` minutes au plus (10 par défaut), budget
`OPUSCLIP_CREDIT_BUDGET`. `/health` indique `liveTestClients` (nombre de clients concernés).
Vider `OPUSCLIP_LIVE_CLIENTS` en production.

## Publication sur les réseaux sociaux (Upload-Post) et Performances

Le client publie une vidéo prête sur YouTube, Instagram, TikTok, LinkedIn et Facebook depuis
OpenStudio, puis suit ses statistiques dans « Performances ». Tout passe par le serveur : la clé
Upload-Post et la clé Claude ne sont jamais envoyées au navigateur.

- **Profil** : un profil Upload-Post par client, créé automatiquement au premier clic sur un réseau
  (nom du profil = identifiant interne du client).
- **Connexion** : Connect API (`POST /api/uploadposts/oauth/{platform}/start`, appelée par le serveur
  avec la clé API) → fenêtre officielle du réseau → retour sur `GET /api/social/connected`, qui
  transmet `connect_status` à la page OpenStudio puis se ferme. Instagram (compte professionnel requis)
  et Facebook (Page requise) affichent un mini-tuto en cas de problème. Connexion expirée : icône
  « Reconnectez votre compte X ».
- **Légendes** : générées une fois par vidéo par l'API Claude (`ANTHROPIC_API_KEY`, modèle
  `CAPTIONS_MODEL`, défaut `claude-opus-5-5`) à partir de la transcription du clip, enregistrée à la
  livraison. Règles par réseau : `openstudio-backend/config/caption-rules.json`. 5 régénérations par
  vidéo. Échec de l'IA → textes simples (titre + émission), la publication n'est pas bloquée.
- **Publication** : un seul `POST /api/upload` avec un texte par réseau, la vidéo passée par URL signée
  (7 jours), `external_id` = identifiant de la publication. Programmation : heure de Paris, 7 jours
  maximum. Statut : notification `upload_completed` signée (`POST /api/webhooks/upload-post`) et,
  en secours, interrogation de `GET /api/uploadposts/status` toutes les 2 minutes.
- **Performances** : `GET /api/uploadposts/post-analytics/{request_id}`, mis en cache en base.
  Actualisation automatique au-delà de 24 h (à l'ouverture de la page et par le worker quand le
  service est éveillé) et bouton « Actualiser » limité à une fois par 15 minutes.

### Configuration
1. Render → openstudio-backend → Environment : `UPLOAD_POST_API_KEY`, `UPLOAD_POST_WEBHOOK_SECRET`,
   `ANTHROPIC_API_KEY`, et `PUBLIC_BASE_URL` = `https://openstudio-backend.onrender.com`.
2. Secret des notifications : `POST https://api.upload-post.com/api/uploadposts/users/webhook-secret`
   (en-tête `Authorization: Apikey <clé>`) → copier `webhook_secret` (`whsec_…`) dans Render.
3. URL des notifications (tableau de bord Upload-Post → Settings → Webhooks, ou API) :
   `https://openstudio-backend.onrender.com/api/webhooks/upload-post`, événements `upload_completed`
   et `social_account_reauth_required`.
4. Secteur d'activité d'un client (utilisé par les légendes) :
   `POST /api/admin/clients/<id>` avec `{"sector": "Recyclage industriel"}`.

### Tests
`TEST_DATABASE_URL=postgres://…/base_de_test npm test` : tests sur une vraie base PostgreSQL (fichiers exécutés l'un après l'autre)
(remise à zéro à chaque exécution), Upload-Post et Claude simulés. Sans `TEST_DATABASE_URL`, ces
tests sont ignorés.

## Confier ma vidéo à un monteur (paiement Stripe)

Le bloc « Et si un monteur s'en occupait ? » ouvre un formulaire en deux étapes :
1. **Votre demande** : coordonnées (préremplies), prestation, émission, description, formats, date.
2. **Paiement sécurisé** : redirection vers Stripe Checkout (carte, 3-D Secure), puis retour sur le site.

- Prestations et prix HT : `openstudio-backend/src/montage/offers.js` (tarifs de la plaquette, sans drone,
  traduction d'article ni pack communication). Le prix payé est toujours celui du serveur ; le client paie
  le TTC (TVA `VAT_RATE`, 20 % par défaut). Le media training (prix à définir) part sans paiement.
- Paiement confirmé par la notification Stripe signée `checkout.session.completed`
  (`POST /api/webhooks/stripe`), traitée une seule fois.
- Sans `STRIPE_SECRET_KEY` : page de paiement simulée (tests), aucun prélèvement.
- Demandes reçues : `GET /api/admin/montage-requests` (`Authorization: Bearer <ADMIN_TOKEN>`), en attendant
  le back-office (e-mail à l'équipe et facture automatique : étape P1).

### Brancher Stripe
1. Stripe → Développeurs → Clés API : copier la clé secrète (`sk_test_…` pour commencer) dans
   `STRIPE_SECRET_KEY` sur Render.
2. Stripe → Développeurs → Webhooks → Ajouter un endpoint :
   `https://openstudio-backend.onrender.com/api/webhooks/stripe`, événements `checkout.session.completed`,
   `checkout.session.async_payment_succeeded` et `checkout.session.expired`. Copier le secret de signature
   (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.
3. Tester avec la carte de test Stripe `4242 4242 4242 4242`, puis passer aux clés live.

## API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/catalog` | Options configurées |
| GET | `/api/me` | Client + vidéos de son package |
| GET | `/api/me/orders` | Commandes du client |
| GET | `/api/social/accounts` | Réseaux connectés / à reconnecter, Page Facebook |
| POST | `/api/social/connect/:platform` | Démarre la connexion (URL de la fenêtre officielle) |
| GET | `/api/social/connected` | Retour de la fenêtre de connexion |
| GET / POST | `/api/social/facebook/pages` · `/api/social/facebook/page` | Pages Facebook, choix de la Page |
| GET | `/api/social/videos/:id/captions` | Légendes par réseau (générées une fois) |
| POST | `/api/social/videos/:id/captions/regenerate` | Régénérer (5 fois max) |
| POST | `/api/social/publications` | Publier ou programmer |
| GET | `/api/social/publications?video=` | Statut par réseau |
| GET | `/api/social/performance` | Indicateurs et liste (période, réseau, type, émission) |
| POST | `/api/social/performance/refresh` | Actualiser (1 fois / 15 min) |
| POST | `/api/webhooks/upload-post` | Notifications Upload-Post (signées) |
| GET | `/api/montage/offers` | Prestations de nos monteurs et prix (HT, TTC) |
| POST | `/api/montage/requests` | Demande de montage → adresse de paiement Stripe |
| GET | `/api/montage/requests/:id` | Statut au retour du paiement |
| POST | `/api/webhooks/stripe` | Notifications Stripe (signées) |
| POST | `/api/uploads` | URL signée d'envoi (vidéo, transcription .srt/.vtt, logo) |
| POST | `/api/orders` | Créer une commande → `accessToken` |
| POST | `/api/orders/:id/validate` | Valider (contrôle des options) |
| POST | `/api/orders/:id/pay/simulate` | Paiement simulé (test) |
| GET | `/api/orders/:id` | Statut |
| GET | `/api/orders/:id/downloads` | Liens d'aperçu et de téléchargement |
| GET | `/api/orders/:id/download.zip` | Toutes les vidéos |
| POST | `/api/webhooks/opusclip` | Webhook OpusClip |
| POST | `/api/admin/clients` | Créer un client |
| POST | `/api/admin/clients/:id` | Modifier un client (logo…) |
| POST | `/api/admin/clients/:id/videos` | Ajouter une vidéo au package |
| POST | `/api/admin/clients/:id/videos/:videoId/disable` | Retirer une vidéo du package |
| GET | `/api/admin/orders` | Suivi équipe + crédits |
| POST | `/api/admin/orders/:id/retry` | Relancer une commande en erreur |

Les routes client exigent le jeton de commande (`X-Order-Token` / `?token=`) ou l'espace client
(`X-Client-Id` + `X-Client-Token`).

## Brancher un vrai paiement plus tard
Créer une classe dans `src/payment/` (ex. Stripe) qui ouvre le paiement et, dans la route
webhook du prestataire **vérifiée**, appelle `onPaymentConfirmed(orderId, ref)`.
Rien d'autre ne change.

## Tests
```bash
cd openstudio-backend && npm test
```
35 tests : options des pages → requêtes OpusClip (toutes les combinaisons durée × format × style),
vidéo hors package refusée, sous-titres (lecture .srt/.vtt, découpage, retour à la ligne,
décalage, transcription OpusClip → sous-titres, export .srt/.vtt), webhook (signature, corps
modifié, horodatage, rejeu), accès par jeton, idempotence du paiement, rendu ffmpeg réel.

## Points de la doc OpusClip non vérifiés (isolés dans la config ou gérés de façon tolérante)
- Valeurs exactes de `renderPref.layoutAspectRatio` (la doc cite portrait / landscape / square).
- Unité de `curationPref.clipDurations` (secondes supposées).
- `importPref` vs `importPreference` : la doc emploie les deux noms → les deux sont envoyés.
- Champs de statut de `GET /api/clip-projects/{id}` et contenu du webhook : non documentés.
  Le code cherche les valeurs usuelles et, à défaut, considère le projet terminé quand le
  nombre de clips exportables est stable entre deux vérifications.
- Coût en crédits : estimé à `OPUSCLIP_CREDITS_PER_MINUTE` × minutes de vidéo source.
  Ajuster après les premiers essais en comparant avec le tableau de bord OpusClip.
- Import SRT et réglages fins des sous-titres : absents de l'API publique → rendu ffmpeg local.
- Traduction des sous-titres (ex. vidéo en français, sous-titres en anglais) : non disponible dans
  l'API OpusClip. Refusée avec un message clair tant que `translationEnabled` est à false ; un
  service de traduction autre qu'OpusClip pourra être branché plus tard sur les sous-titres produits.
- Transcription OpusClip (`GET /api/transcripts`) : temps en secondes, mots horodatés. Si elle
  n'est pas encore prête au moment de la finalisation, la commande repasse en attente.
