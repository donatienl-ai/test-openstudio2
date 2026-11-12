# Serveur OpenStudio (Render)

Ce serveur fait trois choses pour `index.html` :

1. **Stockage** : il génère les URL signées pour déposer les vidéos brutes, les logos et les jingles sur Cloudflare R2 ou AWS S3. Il génère aussi les liens de lecture et de téléchargement temporaires.
2. **Relais OpusClip** : il crée les projets, suit leur avancement, reçoit le webhook signé et renvoie les clips sous une forme normalisée. La clé OpusClip reste ici, elle n'est jamais envoyée au navigateur.
3. **Habillage OpenMedias** (FFmpeg) : il ajoute le logo de l'entreprise, le logo ou la mention du média, une accroche facultative, le jingle d'intro et/ou d'outro, normalise le son, puis encode en H.264/AAC. Il dépose ensuite le MP4 final dans le stockage.

La route `/ai/json`, qui sert à la rédaction par IA, n'est pas gérée ici.

## Déploiement sur Render

1. Créez un **Web Service** de type **Docker**, avec le dossier `server/` comme répertoire racine. Le `Dockerfile` installe FFmpeg depuis Debian.
   - Pourquoi pas `ffmpeg-static` : la version Debian inclut à coup sûr `drawtext` (avec freetype), `loudnorm` et `libx264`, sa version est figée par l'image, et rien n'est téléchargé au démarrage.
2. **Choisissez une offre payante, avec au moins 2 Go de mémoire.** L'offre gratuite se met en veille : elle ne recevrait pas les webhooks et perdrait la file d'attente. Encoder en 1080×1920 demande aussi de la mémoire.
3. Renseignez les variables d'environnement décrites dans `.env.example`.
4. Indiquez l'adresse du service dans `index.html` : `const CONFIG = { API_URL: 'https://openstudio-api.onrender.com' };`.
5. Vérifiez que tout répond : `GET https://…onrender.com/health` doit renvoyer `{"ok":true,"storage":true,"opus":true,"webhook":true}`.

### Variables

| Variable | Rôle |
|---|---|
| `SITE_ORIGIN` | Origine(s) autorisée(s) par le CORS, par exemple `https://openmedias.fr`. Si elle est vide, toutes les origines sont acceptées : un avertissement s'affiche au démarrage. |
| `PUBLIC_URL` | Adresse publique du service. L'URL du webhook déclarée à OpusClip vaut `PUBLIC_URL/opus/webhook`. |
| `OPUSCLIP_API_KEY` | Clé API OpusClip. **Ce doit être la première clé créée sur le compte** : c'est elle qui signe les webhooks. |
| `OPUSCLIP_ORG_ID` | Facultatif : à renseigner seulement si le compte appartient à plusieurs organisations. |
| `OPUS_TPL_IMPACT`, `OPUS_TPL_CLASSIQUE`, `OPUS_TPL_MINIMAL` | Identifiants (`templateId`) des 3 modèles de marque. |
| `OPUS_DURATION_MODE` | `buckets` par défaut : tranches documentées `[0,30]`, `[30,60]`… La valeur `free` donne un intervalle libre `[durée-5, durée+10]` ; ne l'activez qu'après un appel de test concluant. |
| `OPUS_UPLOAD_FALLBACK` | `1` par défaut : si OpusClip refuse l'URL signée, le serveur lui envoie le fichier lui-même (`upload-links`). |
| `STORAGE_*` | Accès au stockage, voir plus bas. |
| `MAX_VIDEO_MB`, `MAX_IMAGE_MB`, `MAX_JINGLE_MB`, `RENDER_TIMEOUT_MS`, `DOWNLOAD_URL_TTL` | Limites, avec des valeurs par défaut raisonnables. |
| `ADMIN_SECRET` | Facultatif, vide pendant les tests internes. S'il est renseigné, le dépôt de fichiers exige l'en-tête `X-Admin-Secret`. L'interface ne l'envoie pas encore. |

## Stockage (R2 recommandé)

1. Dans Cloudflare : **R2 → Create bucket**, par exemple `openstudio`.
2. Créez un jeton dans **R2 → Manage API tokens**, avec le droit *Object Read & Write* limité à ce bucket. Reportez dans Render :
   - `STORAGE_ACCESS_KEY_ID` et `STORAGE_SECRET_ACCESS_KEY` ;
   - `STORAGE_ENDPOINT=https://<ID_COMPTE>.r2.cloudflarestorage.com` ;
   - `STORAGE_REGION=auto` ;
   - `STORAGE_BUCKET=openstudio`.
3. **Configurez le CORS du bucket.** C'est indispensable : le navigateur de l'équipe envoie les fichiers directement au bucket.

```json
[{ "AllowedOrigins": ["https://openmedias.fr"], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

4. Le bucket reste **privé**. Tous les accès passent par des URL signées, y compris celle transmise à OpusClip, valable 7 jours.

Organisation des fichiers :

| Dossier | Contenu |
|---|---|
| `raw/<client>/` | Vidéos brutes |
| `logos/<client ou media-…>/` | Logos (les SVG sont convertis en PNG) |
| `jingles/media-<id>/` | Jingles des médias |
| `renders/<projet>/<clip>/<format>-<version>.mp4` | Fichiers finaux habillés, réutilisés tant que le clip, le format et les logos ne changent pas |
| `state/…json` | État des projets et des tâches, pour qu'ils survivent à un redémarrage |

## Les 3 modèles OpusClip à créer

Dans le tableau de bord OpusClip, menu **Brand templates** (modèles classiques, pas les Brand Kits), créez **trois modèles qui ne contiennent que les sous-titres** :

| Modèle | Style visé, à l'image de l'aperçu dans OpenStudio |
|---|---|
| **Impact** | Sous-titres gras, mot clé surligné à la couleur d'accent |
| **Classique** | Sous-titres sur bandeau sombre semi-transparent |
| **Minimal** (« Discret » dans l'interface) | Texte fin blanc avec une ombre légère |

**Dans chaque modèle :**
- aucun logo, filigrane, intro, outro ni accroche (« auto hook ») ;
- sous-titres placés dans le **tiers bas** de l'image : le haut est réservé à nos logos, à 8 % de la hauteur en 9:16 et à 4,5 % de la largeur en 1:1 et 16:9.

Récupérez ensuite les identifiants et reportez-les dans `OPUS_TPL_IMPACT`, `OPUS_TPL_CLASSIQUE` et `OPUS_TPL_MINIMAL` :

```bash
OPUSCLIP_API_KEY=… npm run templates
```

Le script affiche aussi un avertissement si un modèle contient un filigrane. La doc ne dit pas si un modèle couvre les trois formats : si OpusClip impose un format par modèle, il faudra une variante par format (voir les tests).

## Webhook

L'URL à déclarer est `PUBLIC_URL/opus/webhook`. Le serveur l'envoie lui-même dans `conclusionActions` à chaque projet, avec `notifyFailure: true`.

Chaque appel est vérifié selon la page « Securing your webhook » :
- signature `HMAC-SHA256(clé, corps brut + sel)` ;
- horodatage valable 5 minutes ;
- sel déjà utilisé refusé, contre le rejeu.

## Routes

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/health` | État de la configuration |
| POST | `/storage/upload-url` | `{ kind: video\|logo\|jingle, name, type, size, owner }` → `{ key, url }` (URL d'envoi signée, PUT) |
| POST | `/storage/logo-finalize` | `{ key }` → contrôle du logo et conversion SVG vers PNG |
| GET | `/storage/read-url?key=` | Lien de lecture temporaire (6 h) |
| POST | `/opus/projects` | `{ videoId, storageKey, options, dryRun? }` → `{ projectId, request }`. Avec `dryRun: true`, la requête est seulement affichée, sans rien envoyer ni consommer. |
| GET | `/opus/projects/:id/status` | `{ status: running\|done\|failed, stage, step, error }` |
| GET | `/opus/projects/:id/clips?dur=` | `{ clips: [{ id, title, description, hashtags, text, startSec, endSec, durSec, previewUrl, … }] }` |
| POST | `/opus/webhook` | Notification OpusClip signée |
| POST | `/render/brand` | `{ projectId, clipId, fmt, clientLogoKey, clientName, media: {…}, hook?, fileName }` → `{ jobId, status }` |
| GET | `/render/:jobId` | `{ status, progress, position, url? }`. Chaque appel génère une nouvelle URL signée, ce qui règle les liens expirés. |

Le lien de téléchargement OpusClip (`uriForExport`) n'est **pas** transmis au navigateur, pour qu'aucune version sans habillage ne circule. Il est remplacé par la valeur `"serveur"`.

## Commandes utiles

```bash
npm install
npm start
```

Les commandes suivantes ne demandent ni OpusClip ni stockage :

```bash
npm run test:brand -- ./test-out    # habillage des 8 cas de test sur des vidéos de synthèse
npm run payloads -- Reportage       # requête OpusClip pour chaque combinaison type × durée × format
```

## Limites connues de cette étape

- Clients, médias, vidéos, créations et projets sont mémorisés dans le navigateur de l'équipe et du client (`localStorage`). Le serveur reçoit à chaque demande ce qu'il faut pour l'habillage. **La vraie solution est une base de données côté serveur**, à prévoir à l'étape suivante.
- Les routes de dépôt ne sont protégées que par le CORS, et par `ADMIN_SECRET` s'il est renseigné. Il n'y a pas encore de vraie authentification.
- La file d'habillage traite une vidéo à la fois sur une seule instance. Si le volume augmente, il faudra plusieurs instances ou un service de traitement dédié.
