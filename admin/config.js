/* Adresse du serveur OpenStudio (service Render « openstudio-backend »).
   Si elle change, mettez aussi à jour connect-src dans la balise Content-Security-Policy d'index.html. */
window.OPENSTUDIO_ADMIN_CONFIG = {
  // Back-office de recette (adresse contenant « recette ») : serveur de recette
  API_URL: /recette/.test(location.hostname) ? 'https://openstudio-backend-recette.onrender.com' : 'https://openstudio-backend.onrender.com',
};

// Recette : pastille visible en permanence, pour ne jamais confondre avec la production
if (/recette/.test(location.hostname)) {
  document.addEventListener('DOMContentLoaded', function () {
    var b = document.createElement('div');
    b.textContent = 'RECETTE · données de test';
    b.className = 'env-recette';
    document.body.appendChild(b);
  });
}
