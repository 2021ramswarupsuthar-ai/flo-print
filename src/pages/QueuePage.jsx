import { useCallback, useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { fmtBytes } from '../../shared/pages.js';
import { fmtDateTime, newKey, shortId, timeAgo } from '../util.js';
import StatusBadge from '../components/StatusBadge.jsx';

const ACTIVE = ['UPLOADING', 'QUEUED', 'CLAIMED', 'PRINTING', 'NEEDS_REVIEW'];
const FILTERS = [['active', 'Active'], ['COMPLETED', 'Completed'], ['FAILED', 'Failed'], ['CANCELLED', 'Cancelled'], ['all', 'All']];

export default function QueuePage({ session, notify }) {
  const admin = session.user.role === 'admin';
  const [filter, setFilter] = useState('active');
  const [scopeAll, setScopeAll] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (filter !== 'all') p.set('status', filter);
    if (q.trim()) p.set('q', q.trim());
    if (admin && scopeAll) p.set('scope', 'all');
    try { setData(await get(`/jobs?${p}`)); } catch { /* keep showing the last data */ }
  }, [filter, q, scopeAll, admin]);

  useEffect(() => {
    const t0 = setTimeout(load, q ? 250 : 0);
    const t = setInterval(() => { if (!document.hidden) load(); }, 6000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [load, q]);

  async function act(job, what, body = {}) {
    setBusy(job.id + what);
    try {
      await post(`/jobs/${job.id}/${what}`, body);
      notify(what === 'cancel' ? 'Job cancelled.' : what === 'requeue' ? 'Added to the queue again.' : 'Updated.', 'ok');
      await load();
    } catch (e) {
      notify(e.message, 'bad');
    }
    setBusy('');
  }

  const counts = data?.counts || {};
  const countFor = (f) => (f === 'active' ? ACTIVE.reduce((s, k) => s + (counts[k] || 0), 0) : f === 'all' ? Object.values(counts).reduce((s, n) => s + n, 0) : counts[f] || 0);

  return (
    <section className="stack">
      <div className="toolbar">
        <div className="chips" role="tablist">
          {FILTERS.map(([f, label]) => (
            <button key={f} role="tab" aria-selected={filter === f} className={`chip ${filter === f ? 'on' : ''}`} onClick={() => setFilter(f)}>
              {label} <b>{data ? countFor(f) : ''}</b>
            </button>
          ))}
        </div>
        <input className="search" placeholder="Search file name" aria-label="Search file name" value={q} onChange={(e) => setQ(e.target.value)} />
        {admin ? (
          <label className="check"><input type="checkbox" checked={scopeAll} onChange={(e) => setScopeAll(e.target.checked)} /> Everyone&apos;s jobs</label>
        ) : null}
      </div>

      {data === null ? <div className="muted">Loading…</div> : null}
      {data && data.jobs.length === 0 ? <div className="card empty">Nothing here yet.</div> : null}

      <ul className="cards">
        {data?.jobs.map((j) => (
          <li key={j.id} className="card job">
            <div className="job-head">
              <div className="jobmain">
                <strong className="fname">{j.filename}</strong>
                <span className="muted small">
                  Job {shortId(j.id)} · {j.printer} · {j.copies} {j.copies === 1 ? 'copy' : 'copies'} · {j.color === 'bw' ? 'B&W' : 'Colour'} · {j.orientation} · pages {j.pages === 'all' ? 'all' : j.pages.length > 24 ? `${j.pages.slice(0, 24)}…` : j.pages} · {fmtBytes(j.bytes)}
                  {scopeAll && admin ? ` · ${j.user}` : ''}
                </span>
              </div>
              <StatusBadge status={j.status} />
            </div>
            <div className={j.raw_status === 'FAILED' || j.raw_status === 'REJECTED' ? 'bad-text' : 'muted'}>{j.message}</div>
            <div className="job-foot">
              <span className="muted small">{timeAgo(j.completed || j.created)}</span>
              <div className="actions">
                {['UPLOADING', 'QUEUED'].includes(j.raw_status) ? <button className="btn small" disabled={!!busy} onClick={() => act(j, 'cancel')}>Cancel</button> : null}
                {j.can_requeue ? <button className="btn small" disabled={!!busy} onClick={() => act(j, 'requeue', { key: newKey() })}>Print again</button> : null}
                {admin && j.raw_status === 'NEEDS_REVIEW' ? (
                  <>
                    <button className="btn small primary" disabled={!!busy} onClick={() => act(j, 'resolve', { outcome: 'printed' })}>It printed</button>
                    <button className="btn small" disabled={!!busy} onClick={() => act(j, 'resolve', { outcome: 'not-printed' })}>It did not print</button>
                  </>
                ) : null}
                <button className="btn ghost small" onClick={() => setOpenId(j.id)}>Details</button>
              </div>
            </div>
          </li>
        ))}
      </ul>
      {openId ? <Drawer id={openId} onClose={() => setOpenId(null)} /> : null}
    </section>
  );
}

function Drawer({ id, onClose }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    let stop = false;
    const load = async () => { try { const r = await get(`/jobs/${id}`); if (!stop) setD(r); } catch { /* ignore */ } };
    load();
    const t = setInterval(load, 6000);
    return () => { stop = true; clearInterval(t); };
  }, [id]);
  const j = d?.job;
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Job details">
        <div className="drawer-head">
          <h2>Job {shortId(id)}</h2>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        {!j ? <div className="muted">Loading…</div> : (
          <>
            <p><strong>{j.filename}</strong></p>
            <StatusBadge status={j.status} />
            <p className="muted">{j.message}</p>
            <dl className="facts">
              <dt>Printer</dt><dd>{j.printer}</dd>
              <dt>Settings</dt><dd>{j.copies} × {j.color === 'bw' ? 'B&W' : 'Colour'}, {j.orientation}, pages {j.pages === 'all' ? 'all' : j.pages}</dd>
              <dt>Size</dt><dd>{fmtBytes(j.bytes)}{j.page_count ? ` · ${j.page_count} pages in file` : ''}</dd>
              <dt>Submitted</dt><dd>{fmtDateTime(j.created)} by {j.user}</dd>
              {j.completed ? <><dt>Finished</dt><dd>{fmtDateTime(j.completed)}</dd></> : null}
              {j.evidence ? <><dt>Result</dt><dd>{j.evidence}</dd></> : null}
            </dl>
            <h3>Timeline</h3>
            <ol className="timeline">
              {d.events.map((e, i) => (
                <li key={i}><b>{e.event}</b><span className="muted small"> {fmtDateTime(e.at)} · {e.actor}</span>{e.detail ? <div className="muted small">{e.detail}</div> : null}</li>
              ))}
            </ol>
          </>
        )}
      </aside>
    </div>
  );
}
