// Page-selection parser shared by the browser and the server.
// Accepts "all", "3", "1-3", "1,3,5", "1-3,5". Returns a normalised, sorted, de-duplicated list.
export function parsePages(input, maxPages = 300) {
  const raw = String(input ?? 'all').trim().toLowerCase();
  if (raw === '' || raw === 'all') return { ok: true, value: 'all', list: null };
  if (!/^[0-9,\-\s]+$/.test(raw)) return { ok: false, error: 'Pages can only contain numbers, commas and dashes (example: 1-3,5).' };
  const set = new Set();
  for (const part of raw.split(',')) {
    const p = part.replace(/\s+/g, '');
    if (!p) return { ok: false, error: 'Page list has an empty entry (check for a stray comma).' };
    const m = /^(\d+)(?:-(\d+))?$/.exec(p);
    if (!m) return { ok: false, error: `"${p}" is not a valid page or range.` };
    const a = Number(m[1]);
    const b = m[2] === undefined ? a : Number(m[2]);
    if (a < 1) return { ok: false, error: 'Page numbers start at 1.' };
    if (b < a) return { ok: false, error: `Range ${p} must go from a lower to a higher page.` };
    if (b > maxPages) return { ok: false, error: `Page numbers above ${maxPages} are not allowed.` };
    for (let i = a; i <= b; i++) set.add(i);
  }
  const list = [...set].sort((x, y) => x - y);
  return { ok: true, value: list.join(','), list };
}

export const NOT_SUPPORTED = 'Not Supported: only PDF and JPG/JPEG files can be printed.';

export function fileKind(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  return null;
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
