# Environnement de recette (gratuit, sur Render)

La recette est une copie de la plateforme pour tester une nouveauté **avant** qu'elle n'arrive chez les clients. Elle a son propre serveur, son propre site, son propre back-office et sa propre base de données. Aucun client ne la voit et aucune action n'y a d'effet réel.

Rien de payant : un service web gratuit, deux sites statiques gratuits, et une base créée **dans l'instance PostgreSQL existante** (`openstudio-db`), sans nouvelle instance.

## Comment on travaille

1. Chaque nouveauté arrive d'abord sur la branche **`recette`**. Les PR sont ouvertes vers `recette`.
2. Render redéploie la recette automatiquement. On teste sur les adresses de recette.
3. Quand tout est validé, une PR **`recette` → `main`** fait passer l'ensemble en production.

Les adresses contenant « recette » affichent en permanence une pastille orange **RECETTE · données de test**.

## Garde-fous (automatiques avec `APP_ENV=recette`)

| Domaine | En recette |
|---|---|
| Paiements Stripe | Clé live refusée : une clé `sk_test_…` (carte `4242 4242 4242 4242`), ou rien (paiement simulé). |
| E-mails | Jamais envoyés aux vrais destinataires : tout part vers `MAIL_REDIRECT_TO`, avec « [TEST] » dans le sujet. |
| Factures Pennylane | Simulées (numéros `TEST-…`). Pour un compte Pennylane de test : `PENNYLANE_RECETTE_ALLOWED=1`. |
| OpusClip | `OPUSCLIP_DRY_RUN=true` : aucune vidéo générée (sauf clients listés dans `OPUSCLIP_LIVE_CLIENTS`, à laisser vide). |
| Réseaux sociaux, Claude | Sans clé : désactivés. |

La page `https://openstudio-backend-recette.onrender.com/health` affiche `"env":"recette"`.

## Mise en place (une seule fois, environ 20 minutes)

### 1. La branche `recette`
Elle est créée à partir de `main` (Claude peut le faire).

### 2. La base de données
Dans Render → **openstudio-db** → **Connect** → copier la commande **PSQL Command**, la lancer dans un terminal, puis taper :
```sql
CREATE DATABASE openstudio_recette;
```
L'adresse de cette base est l'**Internal Database URL** de `openstudio-db`, en remplaçant le nom de base final par `/openstudio_recette`.

### 3. Le stockage des vidéos
Chez Backblaze, créer un bucket privé **`openstudio-recette-om`** (même région `eu-central-003`) et une clé d'application limitée à ce bucket. Le stockage gratuit (10 Go) suffit pour les tests, et les fichiers de recette restent séparés de ceux des clients.

### 4. Le serveur de recette
Render → **New → Web Service**, dépôt `test-openstudio2` :
- *Name* : **`openstudio-backend-recette`** (ce nom donne l'adresse attendue par le site) ;
- *Branch* : `recette` ;
- *Root Directory* : `openstudio-backend` ;
- *Build Command* : `npm ci || npm install`, *Start Command* : `npm start` ;
- *Region* : Frankfurt, *Instance type* : **Free**.

Variables (**Environment**) :

| Variable | Valeur |
|---|---|
| `APP_ENV` | `recette` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | adresse de l'étape 2 (`…/openstudio_recette`) |
| `DATABASE_SSL` | `false` |
| `PUBLIC_BASE_URL` | `https://openstudio-backend-recette.onrender.com` |
| `FRONTEND_ORIGIN` | `https://openstudio-recette.onrender.com` |
| `ADMIN_ORIGIN` | `https://openstudio-admin-recette.onrender.com` |
| `ADMIN_TOKEN` | une valeur aléatoire (bouton *Generate*) |
| `ADMIN_ENCRYPTION_KEY` | une valeur aléatoire **différente de la production** (*Generate*) |
| `ADMIN_BOOTSTRAP_EMAIL`, `ADMIN_BOOTSTRAP_NAME` | votre e-mail et votre nom (premier compte du back-office de recette) |
| `OPUSCLIP_DRY_RUN` | `true` |
| `STORAGE_BUCKET` | `openstudio-recette-om` |
| `STORAGE_ENDPOINT` | `https://s3.eu-central-003.backblazeb2.com` |
| `STORAGE_REGION` | `eu-central-003` |
| `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY` | la clé de l'étape 3 |
| `CLIENT_UPLOADS_ENABLED` | `true` |
| `TEST_CLIENT_NAME` | `Client recette` |
| `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` | les mêmes qu'en production |
| `MAIL_REDIRECT_TO` | **votre adresse** : tous les e-mails de la recette y arrivent |
| `STRIPE_SECRET_KEY` | facultatif : une clé `sk_test_…` (sinon paiement simulé) |
| `STRIPE_WEBHOOK_SECRET` | si `sk_test_…` : secret du webhook de test (`…/api/webhooks/stripe` sur l'adresse de recette) |

Ne pas renseigner en recette : `PLANNING_EXPORT_*`, `GOOGLE_SERVICE_ACCOUNT_JSON`, `DRIVE_ROOT_FOLDER_ID`, `UPLOAD_POST_*`, `ANTHROPIC_API_KEY`, `PENNYLANE_API_KEY`, `OPUSCLIP_LIVE_CLIENTS`.

### 5. Le site client de recette
Render → **New → Static Site**, dépôt `test-openstudio2` :
- *Name* : **`openstudio-recette`** ;
- *Branch* : `recette` ;
- *Root Directory* : vide ;
- *Build Command* : vide ;
- *Publish Directory* : `.`.

### 6. Le back-office de recette
Render → **New → Static Site** :
- *Name* : **`openstudio-admin-recette`** ;
- *Branch* : `recette` ;
- *Root Directory* : `admin` ;
- *Publish Directory* : `.` ;
- mêmes en-têtes que le back-office de production (voir `admin/README.md`).

Les logs du serveur de recette donnent au démarrage le lien d'activation du premier compte.

### 7. Vérifier
- `https://openstudio-backend-recette.onrender.com/health` → `"env":"recette"`.
- Le site et le back-office de recette affichent la pastille orange.
- Le lien du client de test est dans les logs du serveur de recette (`TEST_CLIENT_NAME`).

## Bon à savoir
- Comme la production actuelle, le serveur gratuit se met en veille après 15 minutes sans visite : la première page met environ 1 minute à répondre.
- La base de recette partage l'instance PostgreSQL de production (espace disque commun), mais ses données sont séparées : une autre base, d'autres tables.
- Pour repartir de zéro, supprimer puis recréer la base `openstudio_recette` (jamais `openstudio_backend`, qui est la production).
