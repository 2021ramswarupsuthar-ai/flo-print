import { useCallback, useEffect, useRef, useState } from 'react';
import { FloLogo } from './Logo.jsx';

export const SPLASH_KEY = 'flo-splash-seen';

// Opening animation: the frame draws, F-L-O rise in one by one, the tagline fades up, then the screen lifts away.
export default function Splash({ onDone }) {
  const [leaving, setLeaving] = useState(false);
  const finished = useRef(false);

  const finish = useCallback(() => {
    if (finished.current) return;
    finished.current = true;
    try { sessionStorage.setItem(SPLASH_KEY, '1'); } catch { /* private mode */ }
    setLeaving(true);
    setTimeout(onDone, 700);
  }, [onDone]);

  useEffect(() => {
    const t = setTimeout(finish, 3800);
    return () => clearTimeout(t);
  }, [finish]);

  return (
    <div className={`splash ${leaving ? 'leaving' : ''}`} onClick={finish} role="presentation" data-testid="splash">
      <FloLogo animate />
      <button type="button" className="splash-skip" onClick={finish}>Skip</button>
    </div>
  );
}
