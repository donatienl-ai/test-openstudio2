'use strict';
/**
 * Liste les brand templates de votre organisation OpusClip.
 * Usage : npm run opus:templates
 * Copiez ensuite les templateId dans src/opusclip.config.js.
 */
process.env.OPUSCLIP_DRY_RUN = 'false';
const { listBrandTemplates } = require('../src/opusclip/client');

(async () => {
  try {
    const templates = await listBrandTemplates();
    if (!templates.length) {
      console.log('Aucun template trouvé. Créez-les sur https://clip.opus.pro/brand-templates');
      return;
    }
    console.log('\nVos brand templates OpusClip :\n');
    for (const t of templates) console.log(`  ${String(t.templateId || t.id).padEnd(40)}  ${t.name || ''}`);
    console.log('\nPresets disponibles : preset-fancy-Karaoke, preset-fancy-Simple, preset-fancy-Popline, preset-fancy-Beasty,');
    console.log('  preset-fancy-Deep_Diver, preset-fancy-Youshaei, preset-fancy-Pod_P, preset-fancy-Mozi,');
    console.log('  preset-fancy-Gameplay, preset-fancy-Think_Media\n');
  } catch (e) {
    console.error('Erreur :', e.message, e.body || '');
    process.exit(1);
  }
})();
