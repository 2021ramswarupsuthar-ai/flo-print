import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, uploadJobFile } from '../api.js';
import { parsePages, fileKind, fmtBytes, NOT_SUPPORTED } from '../../shared/pages.js';
import { newKey, shortId } from '../util.js';
import StatusBadge from '../components/StatusBadge.jsx';
import { Seg } from '../components/Controls.jsx';

export default function PrintPage({ session, notify, goQueue }) {
  const { config } = session;
  const [printers, setPrinters] = useState(null);
  const [printerId, setPrinterId] = useState('');
  const [files, setFiles] = useState([]);
  const [copies, setCopies] = useState(1);
  const [color, setColor] = useState('bw');
  const [orientation, setOrientation] = useState('portrait');
  const [pagesMode, setPagesMode] = useState('all');
  const [pagesText, setPagesText] = useState('');
  const [phase, setPhase] = useState('edit'); // edit | sending | done | partial
  const [results, setResults] = useState([]);
  const [error, setError] = useState('');
  const [drag, setDrag] = useState(false);
  const keyRef = useRef(newKey());
  const inputRef = useRef(null);

  useEffect(() => {
    let stop = false;
    const load = async () => {
      try {
        const d = await get('/printers');
        if (stop) return;
        setPrinters(d.printers);
        setPrinterId((cur) => (cur && d.printers.some((p) => p.id === cur && p.enabled) ? cur : d.printers.find((p) => p.enabled)?.id || ''));
      } catch {
        if (!stop) setPrinters((prev) => prev || []);
      }
    };
    load();
    const t = setInterval(load, 20000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  // A new request key whenever the request itself changes, so retries of the *same* request never double-print.
  useEffect(() => { keyRef.current = newKey(); }, [printerId, copies, color, orientation, pagesMode, pagesText, files]);

  function addFiles(list) {
    const incoming = [...list];
    setFiles((prev) => {
      const next = [...prev];
      for (const f of incoming) {
        const id = `${f.name}|${f.size}|${f.lastModified}`;
        if (next.some((x) => x.id === id)) continue;
        let err = null;
        if (!fileKind(f.name)) err = NOT_SUPPORTED;
        else if (f.size === 0) err = 'The file is empty.';
        else if (f.size > config.max_file_mb * 1048576) err = `Larger than the ${config.max_file_mb} MB limit.`;
        next.push({ id, file: f, name: f.name, size: f.size, err });
      }
      return next;
    });
  }

  const pagesCheck = useMemo(() => (pagesMode === 'all' ? { ok: true, value: 'all' } : parsePages(pagesText, config.max_pages)), [pagesMode, pagesText, config.max_pages]);
  const pagesError = pagesMode === 'all' ? '' : pagesText.trim() === '' ? 'Enter the pages you want, for example 1-3,5.' : pagesCheck.ok ? '' : pagesCheck.error;
  const valid = files.filter((f) => !f.err);
  const tooMany = valid.length > config.max_files;
  const printer = printers?.find((p) => p.id === printerId);
  const canSubmit = phase === 'edit' && !!printerId && valid.length > 0 && !tooMany && !pagesError && copies >= 1 && copies <= config.max_copies;

  async function submit() {
    setError('');
    setPhase('sending');
    const toSend = files.filter((f) => !f.err);
    try {
      const start = await post('/jobs/start', {
        key: keyRef.current, printer_id: printerId, copies, color, orientation,
        pages: pagesMode === 'all' ? 'all' : pagesCheck.value,
        files: toSend.map((f) => ({ name: f.name, size: f.size })),
      });
      let rows = start.jobs.map((job, i) => ({ job, file: toSend[i], progress: job.raw_status === 'UPLOADING' ? 0 : 1, error: '' }));
      setResults(rows);
      const update = (i, patch) => { rows = rows.map((r, k) => (k === i ? { ...r, ...patch } : r)); setResults(rows); };
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].job.raw_status !== 'UPLOADING') continue;
        try {
          const job = await uploadJobFile(rows[i].job, rows[i].file.file, (p) => update(i, { progress: p }));
          update(i, { job: { ...rows[i].job, ...job }, progress: 1, error: '' });
        } catch (e) {
          update(i, { error: e.message });
        }
      }
      setPhase(rows.some((r) => r.error) ? 'partial' : 'done');
    } catch (e) {
      setError(e.message);
      setPhase('edit');
    }
  }

  function reset() {
    setFiles([]); setResults([]); setPhase('edit'); setError('');
    keyRef.current = newKey();
  }

  if (phase !== 'edit' && results.length) {
    return (
      <section className="card results">
        <h2>{phase === 'sending' ? 'Sending to the print queue…' : phase === 'partial' ? 'Some files did not finish uploading' : 'Added to the print queue'}</h2>
        <ul className="joblist">
          {results.map((r, i) => (
            <li key={i} className="jobrow">
              <div className="jobmain">
                <strong className="fname">{r.job.filename}</strong>
                <span className="muted small">Job {shortId(r.job.id)} · {fmtBytes(r.job.bytes || r.file.size)}</span>
                {r.progress < 1 && !r.error ? <div className="bar"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div> : null}
                <span className={r.error ? 'bad-text' : 'muted'}>{r.error || r.job.message}</span>
              </div>
              <StatusBadge status={r.error ? 'FAILED' : r.job.status} />
            </li>
          ))}
        </ul>
        <div className="actions">
          {phase === 'partial' ? <button className="btn primary" onClick={submit}>Retry upload</button> : null}
          {phase !== 'sending' ? <button className="btn primary" onClick={goQueue}>View queue</button> : null}
          {phase !== 'sending' ? <button className="btn" onClick={reset}>Print more</button> : null}
        </div>
      </section>
    );
  }

  return (
    <div className="print-grid">
      <section className="stack">
        <div
          className={`drop ${drag ? 'over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        >
          <input ref={inputRef} type="file" multiple accept=".pdf,.jpg,.jpeg,application/pdf,image/jpeg" hidden data-testid="file-input"
            onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
          <div className="drop-title">Drop files here or tap to choose</div>
          <div className="muted">PDF or JPG · up to {config.max_files} files · {config.max_file_mb} MB each</div>
        </div>

        {files.length ? (
          <ul className="card joblist">
            {files.map((f) => (
              <li key={f.id} className="jobrow">
                <div className="jobmain">
                  <strong className="fname">{f.name}</strong>
                  <span className={f.err ? 'bad-text' : 'muted small'}>{f.err || fmtBytes(f.size)}</span>
                </div>
                <button className="btn ghost small" aria-label={`Remove ${f.name}`} onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>Remove</button>
              </li>
            ))}
          </ul>
        ) : null}
        {tooMany ? <div className="alert warn">You can print up to {config.max_files} files at a time. Remove a few.</div> : null}
      </section>

      <aside className="card settings">
        <h2>Print settings</h2>

        <div className="field">
          <span className="field-label">Printer</span>
          {printers === null ? <div className="muted">Loading printers…</div> : null}
          {printers?.length === 0 ? <div className="alert warn">No printer is available yet. Ask an admin to add one.</div> : null}
          <div className="printers">
            {printers?.map((p) => (
              <label key={p.id} className={`printer ${printerId === p.id ? 'on' : ''}`}>
                <input type="radio" name="printer" checked={printerId === p.id} disabled={!p.enabled} onChange={() => setPrinterId(p.id)} />
                <span className={`dot ${p.online ? 'ok' : p.agent_online ? 'warn' : 'bad'}`} />
                <span className="pname">{p.name}</span>
                <small className="muted">{p.online ? 'Ready' : p.agent_online ? 'Printer unavailable' : 'Printer PC offline: jobs will wait'}</small>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <span className="field-label">Copies</span>
          <div className="stepper">
            <button type="button" aria-label="Fewer copies" onClick={() => setCopies((c) => Math.max(1, c - 1))}>−</button>
            <input type="number" min="1" max={config.max_copies} value={copies} aria-label="Copies"
              onChange={(e) => setCopies(Math.min(config.max_copies, Math.max(1, Math.floor(Number(e.target.value)) || 1)))} />
            <button type="button" aria-label="More copies" onClick={() => setCopies((c) => Math.min(config.max_copies, c + 1))}>+</button>
          </div>
        </div>

        <div className="field">
          <span className="field-label">Colour</span>
          <Seg label="Colour" value={color} onChange={setColor} options={[['bw', 'Black & White'], ['color', 'Colour']]} />
          {color === 'color' && printer?.seen && !printer.color ? <span className="bad-text small">This printer does not support colour.</span> : null}
        </div>

        <div className="field">
          <span className="field-label">Orientation</span>
          <Seg label="Orientation" value={orientation} onChange={setOrientation} options={[['portrait', 'Portrait'], ['landscape', 'Landscape']]} />
        </div>

        <div className="field">
          <span className="field-label">Pages</span>
          <Seg label="Pages" value={pagesMode} onChange={setPagesMode} options={[['all', 'All pages'], ['custom', 'Choose pages']]} />
          {pagesMode === 'custom' ? (
            <>
              <input placeholder="e.g. 1-3, 5" value={pagesText} aria-label="Pages to print" onChange={(e) => setPagesText(e.target.value)} />
              {pagesError && pagesText ? <span className="bad-text small">{pagesError}</span> : <span className="muted small">Applies to PDFs. Photos always print as one page.</span>}
            </>
          ) : null}
        </div>

        {error ? <div className="alert bad" role="alert">{error}</div> : null}
        <button className="btn primary wide" disabled={!canSubmit} onClick={submit}>
          {phase === 'sending' ? 'Sending…' : `Print ${valid.length || ''} file${valid.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </button>
        <p className="muted small center-text">Paper is A4. Files wait in the queue and print one after another.</p>
      </aside>
    </div>
  );
}
