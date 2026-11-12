'use strict';
/**
 * Abstraction du paiement.
 * Un fournisseur doit, lorsqu'un paiement est CONFIRMÉ côté serveur, appeler onPaymentConfirmed(orderId, ref).
 *
 *  - MockPaymentProvider (test) : bouton « Simuler le paiement » → confirmation immédiate.
 *  - Plus tard, StripePaymentProvider : createCheckout() + route webhook Stripe qui appelle
 *    onPaymentConfirmed() uniquement sur l'événement « checkout.session.completed » vérifié.
 *    Aucune modification de la logique OpusClip ne sera nécessaire.
 */
const crypto = require('crypto');

class PaymentProvider {
  /** @param {(orderId: string, ref: string) => Promise<object|null>} onPaymentConfirmed */
  constructor(onPaymentConfirmed) {
    this.onPaymentConfirmed = onPaymentConfirmed;
  }
  // eslint-disable-next-line no-unused-vars
  async startPayment(order) {
    throw new Error('non implémenté');
  }
}

class MockPaymentProvider extends PaymentProvider {
  get name() {
    return 'mock';
  }
  /** Simule un paiement réussi. Renvoie la commande payée, ou null si elle l'était déjà / pas validée. */
  async startPayment(order) {
    const ref = `mock_${crypto.randomBytes(6).toString('hex')}`;
    return this.onPaymentConfirmed(order.id, ref);
  }
}

module.exports = { PaymentProvider, MockPaymentProvider };
