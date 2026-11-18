// FLO logo drawn as SVG so it is sharp at every size and can animate (frame draws itself, letters rise in).
export function FloLogo({ animate = false, className = '' }) {
  const serif = "'Bodoni Moda','Didot','Bodoni 72','Playfair Display',Georgia,serif";
  return (
    <svg viewBox="0 0 1600 1132" className={`flo-logo ${animate ? 'animate' : ''} ${className}`} role="img" aria-label="FLO, Fashion | Lifestyle | Outfit">
      <path className="logo-frame" d="M295 958H122V132H1478V265" fill="none" stroke="currentColor" strokeWidth="9" pathLength="1" />
      <g fill="currentColor" fontFamily={serif} textAnchor="middle">
        <text className="logo-letter l1" x="524" y="795" fontSize="560">F</text>
        <text className="logo-letter l2" x="905" y="795" fontSize="560">L</text>
        <text className="logo-letter l3" x="1297" y="795" fontSize="560">O</text>
        <text className="logo-tag" x="885" y="968" fontSize="104" textLength="1086" lengthAdjust="spacingAndGlyphs">Fashion | Lifestyle | Outfit</text>
      </g>
    </svg>
  );
}

export function BrandMark() {
  return (
    <div className="brand">
      <span className="brand-mark">FLO</span>
      <span className="brand-sub">Print Desk</span>
    </div>
  );
}
