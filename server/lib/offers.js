// Catalogue des offres côté serveur (copie de OFFERS dans index.html) : le prix et l'intitulé d'une commande
// sont repris d'ici, jamais du navigateur. Modifier les deux ensemble.
export const OFFERS = {
  'capsules-pro': { title: 'Capsules vidéo', price: 780 },
  'teaser': { title: 'Teaser vidéo de 30 à 40 secondes', price: 680 },
  'st-fr': { title: 'Sous-titres en français', price: 420 },
  'st-lang': { title: 'Sous-titres dans une autre langue', price: 420 },
  'rushes': { title: 'Rushes', price: 480 },
  'traduction': { title: "Traduction de l'article dans une autre langue", price: 120 },
  'pack-com': { title: 'Pack communication', price: 980 },
  'posts-rs': { title: 'Publications réseaux sociaux', price: null }, // sur devis : parcours Devis
  'drone': { title: "Utilisation d'un drone", price: 580 }
};
export const fmtPrice = p => p == null ? 'Sur devis' : `${p.toLocaleString('fr-FR')} € HT`;
