# OpenStudio : tests manuels du parcours OpusClip + habillage

**Préparation.**
- Le serveur est déployé, et `GET /health` renvoie `storage`, `opus` et `webhook` à `true`.
- `CONFIG.API_URL` est renseigné dans `index.html`.
- Ouvrez le site avec `?debug=opus` pour voir la requête envoyée à OpusClip dans l'écran de suivi.

**Légende.**
- ✅ : vérifié dans cette session, avec un faux OpusClip et un faux stockage S3 en local (Chromium + FFmpeg).
- ⏳ : à faire avec le vrai compte OpusClip et le vrai bucket R2.

## 1. Dépôt par l'équipe

| # | Test | Résultat attendu | |
|---|---|---|---|
| 1.1 | Fiche client > « Ajouter des contenus » > une vidéo **horizontale** (MP4 1080p) > Ajouter | La vidéo passe par le statut « En cours d'envoi 0…100 % » puis « Prête », dans la fiche client et chez le client. `v.w`/`v.h` valent 1920/1080. | ✅ local, ⏳ R2 |
| 1.2 | Même chose avec une vidéo **verticale** | « Prête », `v.w < v.h`. Côté client, en choisissant 16:9, l'avertissement « Cette vidéo est verticale… » apparaît. | ✅ |
| 1.3 | Couper le réseau pendant l'envoi | Statut « Erreur d'envoi », bouton « Réessayer l'envoi ». Le client ne peut pas lancer de demande. | ⏳ |
| 1.4 | Recharger la page après le dépôt, côté équipe puis côté client | La vidéo est toujours là, avec son statut. La fiche vidéo se lit grâce à un lien temporaire. | ✅ |
| 1.5 | Nouveau client avec un logo PNG transparent, puis avec un logo SVG | `c.logoKey` est renseigné ; le SVG est converti en PNG sur le serveur. | ⏳ |
| 1.6 | Fiche média : logo clair, logo foncé, logo interdit, mention | Clés `logoLightKey` / `logoDarkKey` renseignées. | ✅ (logo clair en SVG) |
| 1.7 | Fiche média : jingle 16:9 seul, position « Début et fin » | Message « Pas de version 9:16 ni 1:1 : le jingle 16:9 sera recadré… ». | ✅ |
| 1.8 | Importer un fichier 16:9 dans l'emplacement 9:16 | Message d'alerte « ce fichier mesure … il sera recadré ». | ⏳ |

## 2. Demande du client : chaque combinaison type × durée × format

Sans consommer de crédit, la commande `npm run payloads -- Émission` affiche les 21 requêtes. Recommencez avec `Reportage` pour vérifier le passage à `ClipAnything`.

| Type | Durées | Formats | Modèle | Particularités de la requête |
|---|---|---|---|---|
| Capsule | 15, 30, 45, 60 s | 9:16, 1:1, 16:9 | `ClipBasic` (Émission, Interview) ou `ClipAnything` (Reportage, Immersion) | `clipDurations` en tranches, `layoutAspectRatio` |
| Teaser | 20, 30, 40 s | 9:16, 1:1, 16:9 | Toujours `ClipAnything` | Avec `customPrompt` « bande-annonce » |

Dans l'interface, pour chaque combinaison (avec `?debug=opus`) :
- l'écran de suivi affiche la requête ;
- vérifiez `layoutAspectRatio`, `clipDurations`, `brandTemplateId` (selon le style), `enableAutoHook: false`, `importPref.sourceLang: "fr"`, et `range` seulement si l'on part d'un moment fort.

**Statut** :
- ✅ capsule 9:16 30 s et teaser 16:9 20 s de bout en bout ;
- ✅ les 21 requêtes générées ;
- ⏳ appels réels.

**Appels de test réels prioritaires** (au moins 10 crédits chacun) :
1. capsule 9:16 30 s (Émission) ;
2. capsule 1:1 45 s ;
3. capsule 16:9 15 s ;
4. teaser 16:9 30 s (Reportage).

**À noter pour chacun :**
- l'URL signée R2 est-elle acceptée, ou le serveur passe-t-il par le repli (journal `[opus] URL signée refusée`) ?
- unité de `timeRanges` : les minutages affichés « De m:ss à m:ss » correspondent-ils à la vidéo ?
- `renderPref` et le modèle de marque produisent-ils bien le bon format ?
- l'endpoint `GET /api/clip-projects/:id` existe-t-il ? Si oui, les étapes du suivi avancent réellement.
- contenu du webhook (journal `[opus] webhook reçu`).

## 3. Propositions

| # | Test | Résultat attendu | |
|---|---|---|---|
| 3.1 | Fin de l'analyse | 4 propositions, avec aperçu `<video>`, logos en surimpression, durée réelle et sans barre de score. Le texte OpusClip est échappé. | ✅ |
| 3.2 | « Proposer d'autres extraits » | Affiche les clips suivants du même projet, puis une confirmation avant toute nouvelle analyse. | ✅ |
| 3.3 | Relancer la même demande (même vidéo et mêmes options) | Aucun nouveau projet OpusClip : réutilisation du cache. | ✅ |
| 3.4 | « Créer un teaser » depuis la fiche vidéo, puis depuis la page Capsules | Type Teaser présélectionné, 30 s, 16:9. | ✅ |
| 3.5 | « Créer la capsule » sur un moment fort d'une vidéo réelle | `range` autour du moment, et mention « Extraits recherchés autour du moment choisi ». | ⏳ |
| 3.6 | Kit de lancement d'un client dont la vidéo est réelle | Le bouton ouvre le même parcours. | ⏳ |

## 4. Habillage (téléchargement)

Chaque cas a été produit localement par `npm run test:brand` ; le son sort à -14 LUFS dans tous les cas.

| # | Cas | Résultat attendu | |
|---|---|---|---|
| 4.1 | Deux logos (9:16, 1:1, 16:9) | Entreprise en haut à gauche, média en haut à droite, ombre légère. En 9:16, les logos sont à 8 % de la hauteur. | ✅ |
| 4.2 | Client sans logo | Son nom en DM Sans ExtraBold, à la place du logo. | ✅ |
| 4.3 | Média qui interdit son logo | Mention texte « Vu dans … » à droite. | ✅ |
| 4.4 | Jingle au bon format, position « Début et fin » | Jingle, puis extrait, puis jingle, au même niveau sonore. | ✅ |
| 4.5 | Jingle 16:9 pour une capsule 9:16 | Jingle recadré en mode « cover ». | ✅ |
| 4.6 | Fond clair sous le logo du média | Le logo foncé est choisi automatiquement. | ✅ |
| 4.7 | **Contrôle visuel sur de vrais clips OpusClip, dans chaque format et chaque modèle** | Les logos ne chevauchent ni les sous-titres ni l'accroche. | ⏳ |
| 4.8 | Deuxième téléchargement du même clip au même format | Immédiat, grâce au fichier en cache. | ✅ |
| 4.9 | Nom du fichier | `capsule_<titre>_9x16_<durée>s.mp4` ou `teaser_…`. | ✅ |

## 5. Robustesse

| # | Test | Résultat attendu | |
|---|---|---|---|
| 5.1 | Mode démo : `CONFIG.API_URL` vide | Tout fonctionne comme avant, y compris pour les vidéos `v1`, `v2` et `v3`. Rien n'est écrit dans les clés OpusClip du `localStorage`. | ✅ |
| 5.2 | Lien expiré : attendre plus de 24 h, ou mettre `DOWNLOAD_URL_TTL=60`, puis retélécharger depuis « Mes créations » | Le serveur génère un nouveau lien ; le téléchargement aboutit. | ⏳ (logique vérifiée : chaque appel génère une nouvelle URL) |
| 5.3 | Quota OpusClip atteint (réponse `403` avec `API_MONTHLY_CAP_REACHED`) | Message « Le quota mensuel d'analyses vidéo est atteint… » ; bouton « Réessayer ». | ✅ (test unitaire) |
| 5.4 | Recharger la page pendant l'analyse | « Reprendre là où vous en étiez », puis les propositions s'affichent, sans projet en double. | ✅ |
| 5.5 | Fermer l'onglet pendant l'analyse, revenir 10 minutes plus tard | Bandeau « Reprendre », propositions prêtes. | ⏳ |
| 5.6 | Plus de 30 minutes d'analyse | Message « délai dépassé », bouton « Vérifier à nouveau ». | ⏳ |
| 5.7 | Redémarrer le serveur Render pendant un habillage | Le navigateur continue d'interroger le serveur, qui relance la tâche automatiquement. | ⏳ |
| 5.8 | Webhook non signé | Réponse 401. | ✅ |
| 5.9 | Appel depuis une autre origine | Aucun en-tête CORS : le navigateur bloque l'appel. | ✅ |
