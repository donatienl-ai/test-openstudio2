// Journaux structurés (une ligne JSON par événement). Les adresses email sont masquées.
export const maskEmail = e => {
  const s = String(e || ''); const [u, d] = s.split('@'); if (!d) return s ? '***' : '';
  return `${u.slice(0, 1)}***@${d}`;
};

export function createLogger(write = line => process.stdout.write(line + '\n')) {
  const out = (level, msg, fields = {}) => {
    const f = { ...fields };
    for (const k of Object.keys(f)) if (typeof f[k] === 'string' && f[k].includes('@')) f[k] = maskEmail(f[k]);
    write(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...f }));
  };
  return { info: (m, f) => out('info', m, f), warn: (m, f) => out('warn', m, f), error: (m, f) => out('error', m, f) };
}
