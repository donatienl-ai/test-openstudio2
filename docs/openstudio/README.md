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
(BFM Business, BFM, Immersion — à compléter).

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

## API

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/api/catalog` | Options configurées |
| GET | `/api/me` | Client + vidéos de son package |
| GET | `/api/me/orders` | Commandes du client |
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
