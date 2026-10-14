// Icons from the design prototype (docs/design)

export function Chevron({ open = false, size = 12 }: { open?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden className="chev-ic" style={{ transform: `rotate(${open ? 90 : 0}deg)` }}>
      <path d="M4 2l4 4-4 4" stroke="currentColor" fill="none" strokeWidth="1.6" />
    </svg>
  );
}

export function ChevronDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
      <path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" />
    </svg>
  );
}

export function EyeIcon({ shown, size = 16 }: { shown: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden>
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      {shown ? <circle cx="8" cy="8" r="2" /> : <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

export function PanelIcon({ side }: { side: "left" | "right" }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
      <path d={side === "left" ? "M6 2.75v10.5" : "M10 2.75v10.5"} />
    </svg>
  );
}

export function BookmarkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <path d="M3.5 1.5h7v11L7 10l-3.5 2.5z" />
    </svg>
  );
}

export const Dot = ({ color, pulse }: { color: string; pulse?: boolean }) => (
  <span className={`dot${pulse ? " pulse" : ""}`} style={{ background: color }} />
);

// Logo: "CAD" on a dark rounded square, red border and a corner-to-corner slash like a road sign
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect x="1.5" y="1.5" width="29" height="29" rx="6" fill="#1d2129" stroke="#a8261d" strokeWidth="3" />
      <text x="16" y="19.6" textAnchor="middle" fontFamily="system-ui, Arial, sans-serif" fontWeight="800" fontSize="10.5" letterSpacing="-0.3" fill="#fff">CAD</text>
      <line x1="4.2" y1="27.8" x2="27.8" y2="4.2" stroke="#a8261d" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
