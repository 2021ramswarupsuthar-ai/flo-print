import { useState } from 'react';
import { post } from '../api.js';
import { FloLogo } from '../components/Logo.jsx';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('/login', { username, password });
      await onLogin();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <FloLogo className="login-logo" />
      <form className="card login-card" onSubmit={submit}>
        <h1>Print Desk</h1>
        <p className="muted">Sign in to print documents on the office printer.</p>
        <label className="field">
          <span className="field-label">Username</span>
          <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Password</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error ? <div className="alert bad" role="alert">{error}</div> : null}
        <button className="btn primary wide" disabled={busy || !username || !password}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </main>
  );
}
