'use strict';
/**
 * Prestations réalisées par nos monteurs, proposées dans le formulaire « Confier ma vidéo à un monteur ».
 * Tarifs de la plaquette OpenMedias (HT). Le prix payé est TOUJOURS celui de cette liste : le navigateur
 * n'envoie que l'identifiant de la prestation. priceHT null = prix à définir (pas de paiement en ligne).
 */
const OFFERS = [
  { id: 'capsules', title: 'Capsules vidéo tirées de la vidéo finale', priceHT: 780, desc: 'Les meilleurs moments de votre vidéo, montés par nos monteurs pour vos réseaux.' },
  { id: 'teaser', title: 'Teaser vidéo de 30 à 40 secondes', priceHT: 680, desc: 'Un teaser rythmé pour annoncer votre passage ou le relancer.' },
  { id: 'sous-titres-fr', title: 'Sous-titres en français', priceHT: 420, desc: 'Sous-titres réalisés et relus par nos équipes, intégrés à votre vidéo.' },
  { id: 'sous-titres-langue', title: 'Sous-titres dans une autre langue', priceHT: 420, desc: 'Votre vidéo sous-titrée dans la langue de votre choix.' },
  { id: 'rushes', title: 'Rushes', priceHT: 480, desc: 'Toutes les images brutes du tournage, pour vos propres montages.' },
  { id: 'media-training', title: 'Media training avec une présentatrice', priceHT: null, desc: 'Une séance de préparation à la prise de parole face caméra.' },
];

const byId = (id) => OFFERS.find((o) => o.id === id) || null;
/** Montant TTC en centimes à partir d'un prix HT en euros (arrondi au centime). */
const ttcCents = (priceHT, vatRate) => Math.round(priceHT * 100 * (1 + vatRate));

module.exports = { OFFERS, byId, ttcCents };
