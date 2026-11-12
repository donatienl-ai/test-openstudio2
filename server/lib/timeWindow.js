// Plage d'envoi des emails non transactionnels : 9 h - 20 h, heure de Paris (heure d'été comprise).
// forward : l'envoi est reporté au prochain créneau (relances).
// backward : l'envoi est avancé au dernier créneau autorisé (avis : jamais après J+30).
export const TZ = 'Europe/Paris';

const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function parisParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}
// Heure locale de Paris -> instant UTC (gère les changements d'heure).
export function parisToUtc(y, m, d, h, mi = 0) {
  let guess = Date.UTC(y, m - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = parisParts(new Date(guess));
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi);
    guess += Date.UTC(y, m - 1, d, h, mi) - asUtc;
  }
  return new Date(guess);
}
const addDaysLocal = (p, n) => { const t = new Date(Date.UTC(p.y, p.m - 1, p.d + n)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() }; };

export function parseWindow(spec = '9-20') {
  const [a, b] = String(spec).split('-').map(Number);
  return { start: Number.isFinite(a) ? a : 9, end: Number.isFinite(b) ? b : 20 };
}

export function inWindow(date, win = parseWindow()) {
  const p = parisParts(date); return p.h >= win.start && p.h < win.end;
}

export function fitWindow(date, win = parseWindow(), direction = 'forward') {
  if (inWindow(date, win)) return date;
  const p = parisParts(date);
  if (direction === 'forward') {
    const day = p.h >= win.end ? addDaysLocal(p, 1) : p;
    return parisToUtc(day.y, day.m, day.d, win.start, 0);
  }
  // Dernier créneau avant l'échéance : 30 minutes avant la fin de la plage.
  const day = p.h < win.start ? addDaysLocal(p, -1) : p;
  return parisToUtc(day.y, day.m, day.d, win.end - 1, 30);
}
