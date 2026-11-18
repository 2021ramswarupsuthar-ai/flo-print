import { useCallback, useEffect, useRef, useState } from 'react';
import { get, post } from './api.js';
import { BrandMark } from './components/Logo.jsx';
import Splash, { SPLASH_KEY } from './components/Splash.jsx';
import { Toasts } from './components/Controls.jsx';
import Login from './pages/Login.jsx';
import PrintPage from './pages/PrintPage.jsx';
import QueuePage from './pages/QueuePage.jsx';
import ManagePage from './pages/ManagePage.jsx';

const seenSplash = () => {
  try { return sessionStorage.getItem(SPLASH_KEY) === '1'; } catch { return false; }
};
const tabFromHash = () => (['print', 'queue', 'manage'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'print');

export default function App() {
  const [splash, setSplash] = useState(() => !seenSplash());
  const [session, setSession] = useState(undefined); // undefined = loading, null = signed out
  const [tab, setTab] = useState(tabFromHash);
  const [toasts, setToasts] = useState([]);
  const toastId = useRef(0);

  const notify = useCallback((text, tone = 'info') => {
    const id = ++toastId.current;
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const load = useCallback(async () => {
    try { setSession(await get('/me')); } catch { setSession(null); }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const off = () => setSession(null);
    const hash = () => setTab(tabFromHash());
    window.addEventListener('flo:unauth', off);
    window.addEventListener('hashchange', hash);
    return () => { window.removeEventListener('flo:unauth', off); window.removeEventListener('hashchange', hash); };
  }, []);

  const go = (t) => { location.hash = t; setTab(t); };
  const logout = async () => { try { await post('/logout'); } catch { /* ignore */ } setSession(null); };

  let body;
  if (session === undefined) body = <div className="center muted">Loading…</div>;
  else if (session === null) body = <Login onLogin={load} />;
  else {
    const admin = session.user.role === 'admin';
    const active = tab === 'manage' && !admin ? 'print' : tab;
    body = (
      <>
        <header className="topbar">
          <BrandMark />
          <nav className="tabs" aria-label="Main">
            <button className={active === 'print' ? 'on' : ''} onClick={() => go('print')}>Print</button>
            <button className={active === 'queue' ? 'on' : ''} onClick={() => go('queue')}>Queue</button>
            {admin ? <button className={active === 'manage' ? 'on' : ''} onClick={() => go('manage')}>Manage</button> : null}
          </nav>
          <div className="who">
            <span>{session.user.name}</span>
            <button className="btn ghost small" onClick={logout}>Sign out</button>
          </div>
        </header>
        <main className="page">
          {active === 'print' && <PrintPage session={session} notify={notify} goQueue={() => go('queue')} />}
          {active === 'queue' && <QueuePage session={session} notify={notify} />}
          {active === 'manage' && admin && <ManagePage notify={notify} />}
        </main>
      </>
    );
  }

  return (
    <>
      {body}
      <Toasts items={toasts} />
      {splash ? <Splash onDone={() => setSplash(false)} /> : null}
    </>
  );
}
