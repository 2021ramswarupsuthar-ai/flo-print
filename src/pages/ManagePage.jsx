import { useCallback, useEffect, useState } from 'react';
import { get, post, patch, put } from '../api.js';
import { timeAgo } from '../util.js';
import { Field } from '../components/Controls.jsx';

const TABS = [['printers', 'Printers'], ['agents', 'Printer PCs'], ['users', 'Users'], ['settings', 'Settings']];

export default function ManagePage({ notify }) {
  const [tab, setTab] = useState('printers');
  return (
    <section className="stack">
      <div className="chips">
        {TABS.map(([k, label]) => (
          <button key={k} className={`chip ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'printers' && <Printers notify={notify} />}
      {tab === 'agents' && <Agents notify={notify} />}
      {tab === 'users' && <Users notify={notify} />}
      {tab === 'settings' && <Settings notify={notify} />}
    </section>
  );
}

function useLoad(path, key) {
  const [data, setData] = useState(null);
  const reload = useCallback(async () => { try { setData((await get(path))[key]); } catch { /* ignore */ } }, [path, key]);
  useEffect(() => { reload(); const t = setInterval(reload, 10000); return () => clearInterval(t); }, [reload]);
  return [data, reload];
}

function Printers({ notify }) {
  const [printers, reload] = useLoad('/printers', 'printers');
  const [agents] = useLoad('/admin/agents', 'agents');
  const [form, setForm] = useState({ name: '', windows_name: '' });
  const installed = [...new Set((agents || []).flatMap((a) => a.installed))];

  async function add(e) {
    e.preventDefault();
    try { await post('/admin/printers', form); setForm({ name: '', windows_name: '' }); notify('Printer added.', 'ok'); reload(); } catch (err) { notify(err.message, 'bad'); }
  }

  return (
    <>
      <datalist id="installed-printers">{installed.map((n) => <option key={n} value={n} />)}</datalist>
      <ul className="cards">
        {printers?.map((p) => <PrinterRow key={p.id} p={p} agents={agents || []} notify={notify} reload={reload} />)}
      </ul>
      <form className="card form-grid" onSubmit={add}>
        <h3>Add a printer</h3>
        <Field label="Display name"><input value={form.name} placeholder="e.g. Epson L6270" onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Windows printer name" hint="Exactly as shown in Windows. Names found by the printer PC appear as suggestions.">
          <input list="installed-printers" value={form.windows_name} placeholder="e.g. EPSON L6270 Series" onChange={(e) => setForm({ ...form, windows_name: e.target.value })} />
        </Field>
        <button className="btn primary" disabled={!form.name.trim() || !form.windows_name.trim()}>Add printer</button>
      </form>
    </>
  );
}

function PrinterRow({ p, agents, notify, reload }) {
  const [name, setName] = useState(p.name);
  const [win, setWin] = useState(p.windows_name);
  const dirty = name !== p.name || win !== p.windows_name;
  const save = async (body) => {
    try { await patch(`/admin/printers/${p.id}`, body); notify('Saved.', 'ok'); reload(); } catch (e) { notify(e.message, 'bad'); }
  };
  return (
    <li className="card">
      <div className="job-head">
        <div className="jobmain">
          <strong>{p.name}</strong>
          <span className="muted small">
            <i className={`dot ${p.online ? 'ok' : p.agent_online ? 'warn' : 'bad'}`} />{' '}
            {!p.enabled ? 'Disabled' : p.online ? 'Ready' : p.agent_online ? `Printer unavailable${p.note ? `: ${p.note}` : ''}` : p.agent_name ? 'Printer PC offline' : 'Not connected to a printer PC yet'}
            {p.seen ? (p.color ? ' · colour' : ' · B&W only') : ''}
          </span>
        </div>
        <label className="check"><input type="checkbox" checked={p.enabled} onChange={(e) => save({ enabled: e.target.checked })} /> Enabled</label>
      </div>
      <div className="form-row">
        <Field label="Display name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Windows printer name"><input list="installed-printers" value={win} onChange={(e) => setWin(e.target.value)} /></Field>
        <Field label="Printer PC">
          <select value={p.agent_id || ''} onChange={(e) => save({ agent_id: e.target.value || null })}>
            <option value="">Auto (first PC that reports it)</option>
            {agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      </div>
      {dirty ? <button className="btn small primary" onClick={() => save({ name, windows_name: win })}>Save changes</button> : null}
    </li>
  );
}

function Agents({ notify }) {
  const [agents, reload] = useLoad('/admin/agents', 'agents');
  const [name, setName] = useState('');
  const [token, setToken] = useState(null);

  async function add(e) {
    e.preventDefault();
    try { const r = await post('/admin/agents', { name }); setToken({ name, value: r.token }); setName(''); reload(); } catch (err) { notify(err.message, 'bad'); }
  }
  async function edit(a, body) {
    try { const r = await patch(`/admin/agents/${a.id}`, body); if (r.token) setToken({ name: a.name, value: r.token }); notify('Saved.', 'ok'); reload(); } catch (err) { notify(err.message, 'bad'); }
  }

  return (
    <>
      {token ? (
        <div className="card token-card" role="status">
          <h3>Connection key for “{token.name}”</h3>
          <p className="muted">Copy it now. For safety it is shown only once. Paste it when the setup on the printer PC asks for it.</p>
          <code className="token">{token.value}</code>
          <div className="actions">
            <button className="btn small primary" onClick={() => navigator.clipboard?.writeText(token.value).then(() => notify('Copied.', 'ok'))}>Copy</button>
            <button className="btn small" onClick={() => setToken(null)}>I have saved it</button>
          </div>
        </div>
      ) : null}
      <ul className="cards">
        {agents?.map((a) => (
          <li key={a.id} className="card job-head">
            <div className="jobmain">
              <strong>{a.name}</strong>
              <span className="muted small"><i className={`dot ${a.online ? 'ok' : 'bad'}`} /> {!a.enabled ? 'Disabled' : a.online ? 'Online' : a.last_seen ? `Offline · last seen ${timeAgo(a.last_seen)}` : 'Never connected'}</span>
              {a.installed.length ? <span className="muted small">Printers found: {a.installed.join(', ')}</span> : null}
            </div>
            <div className="actions">
              <button className="btn small" onClick={() => edit(a, { rotate: true })}>New key</button>
              <button className="btn small" onClick={() => edit(a, { enabled: !a.enabled })}>{a.enabled ? 'Disable' : 'Enable'}</button>
            </div>
          </li>
        ))}
      </ul>
      <form className="card form-grid" onSubmit={add}>
        <h3>Connect a printer PC</h3>
        <p className="muted">Install the FLO Print Agent on the Windows PC that the printer is connected to (see the README), then create its connection key here.</p>
        <Field label="Name"><input value={name} placeholder="e.g. Office PC" onChange={(e) => setName(e.target.value)} /></Field>
        <button className="btn primary" disabled={!name.trim()}>Create connection key</button>
      </form>
    </>
  );
}

function Users({ notify }) {
  const [users, reload] = useLoad('/admin/users', 'users');
  const [form, setForm] = useState({ username: '', name: '', password: '', role: 'staff' });
  const [reset, setReset] = useState({});

  async function add(e) {
    e.preventDefault();
    try { await post('/admin/users', form); setForm({ username: '', name: '', password: '', role: 'staff' }); notify('User added.', 'ok'); reload(); } catch (err) { notify(err.message, 'bad'); }
  }
  async function edit(u, body, okText = 'Saved.') {
    try { await patch(`/admin/users/${u.id}`, body); notify(okText, 'ok'); reload(); } catch (err) { notify(err.message, 'bad'); }
  }

  return (
    <>
      <ul className="cards">
        {users?.map((u) => (
          <li key={u.id} className="card">
            <div className="job-head">
              <div className="jobmain"><strong>{u.name}</strong><span className="muted small">{u.username} · {u.active ? 'active' : 'disabled'}</span></div>
              <div className="actions">
                <select aria-label={`Role for ${u.username}`} value={u.role} onChange={(e) => edit(u, { role: e.target.value })}>
                  <option value="staff">Staff</option><option value="admin">Admin</option>
                </select>
                <button className="btn small" onClick={() => edit(u, { active: !u.active })}>{u.active ? 'Disable' : 'Enable'}</button>
              </div>
            </div>
            <div className="form-row">
              <input type="password" placeholder="New password (8+ characters)" aria-label={`New password for ${u.username}`} value={reset[u.id] || ''} onChange={(e) => setReset({ ...reset, [u.id]: e.target.value })} />
              <button className="btn small" disabled={(reset[u.id] || '').length < 8} onClick={async () => { await edit(u, { password: reset[u.id] }, 'Password changed.'); setReset({ ...reset, [u.id]: '' }); }}>Change password</button>
            </div>
          </li>
        ))}
      </ul>
      <form className="card form-grid" onSubmit={add}>
        <h3>Add a user</h3>
        <Field label="Full name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Username" hint="Letters, numbers, dot, dash or underscore."><input value={form.username} autoCapitalize="none" onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
        <Field label="Password"><input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
        <Field label="Role">
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="staff">Staff (can print)</option><option value="admin">Admin (can manage)</option></select>
        </Field>
        <button className="btn primary" disabled={!form.name.trim() || !form.username.trim() || form.password.length < 8}>Add user</button>
      </form>
    </>
  );
}

const SETTING_FIELDS = [
  ['max_file_mb', 'Max file size (MB)', '1-25'],
  ['max_files', 'Max files per request', '1-20'],
  ['max_copies', 'Max copies', '1-200'],
  ['max_pages', 'Max pages in a document', '1-500'],
  ['retry_max', 'Automatic retries', '0-5'],
  ['retry_delay_s', 'Seconds between retries', '5-600'],
  ['retention_hours', 'Keep finished files for (hours)', '1-168'],
  ['failed_retention_hours', 'Keep failed files for (hours)', '1-720'],
];

function Settings({ notify }) {
  const [s, setS] = useState(null);
  useEffect(() => { get('/admin/settings').then((r) => setS(r.settings)).catch(() => {}); }, []);
  if (!s) return <div className="muted">Loading…</div>;
  async function save(e) {
    e.preventDefault();
    try {
      const body = Object.fromEntries(Object.keys(s).map((k) => [k, Number(s[k])]));
      setS((await put('/admin/settings', body)).settings);
      notify('Settings saved.', 'ok');
    } catch (err) { notify(err.message, 'bad'); }
  }
  return (
    <form className="card form-grid" onSubmit={save}>
      {SETTING_FIELDS.map(([k, label, hint]) => (
        <Field key={k} label={label} hint={`Allowed: ${hint}`}>
          <input type="number" value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })} />
        </Field>
      ))}
      <button className="btn primary">Save settings</button>
    </form>
  );
}
