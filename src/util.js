export function newKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export function timeAgo(ms, now = Date.now()) {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const fmtDateTime = (ms) =>
  ms ? new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export const STATUS = {
  UPLOADING: ['Uploading', 'info'],
  QUEUED: ['Queued', 'info'],
  WAITING_FOR_AGENT: ['Waiting for printer PC', 'warn'],
  CLAIMED: ['Preparing', 'info'],
  PRINTING: ['Printing', 'info pulse'],
  COMPLETED: ['Completed', 'ok'],
  FAILED: ['Failed', 'bad'],
  REJECTED: ['Rejected', 'bad'],
  CANCELLED: ['Cancelled', 'muted'],
  NEEDS_REVIEW: ['Needs review', 'warn'],
};

export const shortId = (id) => String(id || '').slice(0, 8).toUpperCase();
