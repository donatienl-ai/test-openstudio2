'use strict';
/**
 * Limite le nombre de tentatives par adresse IP (connexion, code, activation).
 * En mémoire : suffisant pour un seul service Render ; le verrouillage par compte, lui, est en base.
 */
class AttemptLimiter {
  constructor({ max = 20, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  /** Enregistre une tentative ; renvoie false si la limite est atteinte. */
  hit(key) {
    const t = this.now();
    const recent = (this.hits.get(key) || []).filter((x) => t - x < this.windowMs);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    if (this.hits.size > 10000) this.prune();
    return true;
  }

  reset(key) {
    this.hits.delete(key);
  }

  prune() {
    const t = this.now();
    for (const [k, list] of this.hits) {
      if (!list.some((x) => t - x < this.windowMs)) this.hits.delete(k);
    }
  }
}

module.exports = { AttemptLimiter };
