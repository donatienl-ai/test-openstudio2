# Brancher les pages « Créer » sur le back-end

## 1. Inclure le script (dans chaque page qui en a besoin, avant `</body>`)

```html
<script>window.OPENSTUDIO_API = 'https://openstudio-backend.onrender.com';</script>
<script src="openstudio-api.js"></script>
```

Copiez aussi `mes-commandes.html` et `openstudio-api.js` à la racine du site.

## 2. Espace client

Chaque client reçoit de l'équipe un **lien d'accès** :
`https://votre-site/?client=<id>&clientToken=<jeton>`
Au premier passage, le script le mémorise : les appels suivants sont faits au nom de ce client.
(À remplacer plus tard par une vraie connexion.)

## 3. Capsules vidéo

### Étape 1 « Vidéo » : vidéos du package du client

La liste dépend du package du client (passage BFM Business, BFM, immersion…).

```js
const { client, videos } = await OpenStudio.getMyVideos();
// videos = [{ id, title, programme: 'BFM Business', programmeId, broadcastDate }, …]
const liste = document.querySelector('#liste-videos');
liste.innerHTML = videos.map((v) =>
  `<label><input type="radio" name="video" value="${v.id}"> ${v.programme} — ${v.title}</label>`
).join('');
```

### Étape 2 « Réglages » puis validation

Les libellés affichés sont acceptés tels quels :

```js
{
  videoId: 'id de la vidéo choisie à l'étape 1',
  duration: '30 s',          // '15 s' | '30 s' | '45 s' | '60 s'
  format: 'Vertical 9:16',   // 'Vertical 9:16' | 'Carré 1:1' | 'Horizontal 16:9'
  subtitleStyle: 'Impact',   // 'Impact' | 'Classique' | 'Discret'
}
```

Le logo de l'entreprise est pris dans la fiche client (géré par l'équipe) ; celui du média
(BFM Business…) vient du programme de la vidéo.

> ⚠️ « Proposer mes capsules » mène à l'étape 3 « Propositions ». OpusClip ne doit partir qu'à la
> **validation + paiement** : appelez `submitOrder` sur le bouton de validation final, sinon des
> crédits sont consommés avant paiement.

```js
document.querySelector('#btn-valider-capsules').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    const { link } = await OpenStudio.submitOrder('capsules', {
      videoId: document.querySelector('input[name="video"]:checked')?.value,
      duration: document.querySelector('.duree.active')?.textContent,   // « 30 s »
      format: document.querySelector('.format.active')?.dataset.format,  // « 9:16 »
      subtitleStyle: document.querySelector('.style.active')?.textContent, // « Impact »
    });
    location.href = link;
  } catch (err) {
    alert(err.message); // message clair du serveur (option manquante, vidéo hors package…)
  } finally {
    btn.disabled = false;
  }
});
```

## 4. Sous-titres

Correspondance avec la page :

| Page | Option envoyée |
|---|---|
| 1. Votre vidéo | `videoKey` (vidéo envoyée avec `uploadFile(fichier, 'video')`) |
| 2. Transcription — Importer (.srt / .vtt) | `transcriptKey` (`uploadFile(fichier, 'transcript')`). Sans fichier : transcription automatique OpusClip |
| 2. Langue parlée dans la vidéo | `spokenLanguage` : « Français » / « Anglais » |
| 2. Découper les phrases trop longues | `splitLongLines` : `true` / `false` |
| 3. Langue des sous-titres | `subtitleLanguage` (= langue parlée tant que la traduction n'est pas branchée) |
| 3. Taille / Contour | `size`, `outline` (libellés du formulaire, à aligner dans la config) |
| (facultatif) Programme d'origine | `programmeId` (ex. `bfm-business`) → ajoute le logo du média |
| 4. Télécharger | fichiers **.srt**, **.vtt** et **vidéo sous-titrée** dans Mes commandes |

La vidéo sous-titrée porte le **logo de l'entreprise** (en haut à gauche, pris dans la fiche
client : le client doit donc passer par son lien d'espace) et, si `programmeId` est fourni, le
**logo du média** en haut à droite.

> Aujourd'hui la page indique « Elle reste sur votre ordinateur : elle n'est envoyée nulle part ».
> Pour produire la vidéo sous-titrée côté serveur, la vidéo doit être envoyée : il faudra adapter
> ce texte (ex. « envoyée de façon sécurisée, supprimée après X jours »). L'aperçu en direct dans
> le navigateur peut rester tel quel.

```js
document.querySelector('#btn-valider-sous-titres').addEventListener('click', async () => {
  const video = document.querySelector('#video-upload').files[0];
  const transcript = document.querySelector('#transcription-upload').files[0];
  const progress = document.querySelector('#progression');

  const videoKey = await OpenStudio.uploadFile(video, 'video', (p) => (progress.textContent = `Envoi : ${p} %`));
  const transcriptKey = transcript ? await OpenStudio.uploadFile(transcript, 'transcript') : null;

  const { link } = await OpenStudio.submitOrder('subtitles', {
    videoKey,
    transcriptKey,
    spokenLanguage: document.querySelector('#langue-parlee').value,          // « Français »
    subtitleLanguage: document.querySelector('.langue-sous-titres.active')?.textContent || 'Français',
    splitLongLines: document.querySelector('#decouper-phrases').checked,
    size: document.querySelector('#taille').value,
    outline: document.querySelector('#contour').value,
    programmeId: document.querySelector('#programme')?.value || null, // facultatif
  });
  location.href = link;
});
```

## 5. Paiement (test)

`submitOrder` crée la commande, la valide (contrôle côté serveur), puis **simule le paiement**.
Pour ne pas le simuler : `OpenStudio.submitOrder(type, options, contact, { simulatePayment: false })`.

Les commandes `visuels` et `publications` peuvent passer par la même fonction : elles ne
déclenchent jamais OpusClip.
