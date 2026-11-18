// Thin fetch wrapper. Every state-changing call carries the CSRF header the server expects.
export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'flo-print' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Network problem. Please check your internet connection.');
  }
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON response */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') window.dispatchEvent(new Event('flo:unauth'));
    throw new ApiError(res.status, (data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b = {}) => api('PATCH', p, b);
export const put = (p, b = {}) => api('PUT', p, b);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, tries = 3) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      const transient = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!transient || i >= tries - 1) throw e;
      await sleep(600 * (i + 1));
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(blob);
  });
}

// Uploads one file in parts (Vercel limits request size), then asks the server to finish and queue it.
export async function uploadJobFile(job, file, onProgress) {
  for (let n = 0; n < job.total_chunks; n++) {
    const data = await blobToBase64(file.slice(n * job.chunk_size, (n + 1) * job.chunk_size));
    await withRetry(() => post(`/jobs/${job.id}/chunk/${n}`, { data }));
    onProgress((n + 1) / job.total_chunks);
  }
  return (await withRetry(() => post(`/jobs/${job.id}/finish`, {}))).job;
}
