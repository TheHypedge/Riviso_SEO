export const ScheduleModalIcons = {
  X: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  ),
  Calendar: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M16 2v4M8 2v4M3 10h18" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  ),
  Document: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Clock: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M12 7v5l3 2" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  ),
  Globe: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" fill="none" stroke="currentColor" strokeWidth="1.75" />
    </svg>
  ),
  Layers: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path
        d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Status: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M8 12h8" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  ),
  Pen: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path
        d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  Image: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
      <path d="M21 15l-5-5L5 21" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  List: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  ),
  Repeat: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <path
        d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  CalendarMonth: (props: { className?: string }) => (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={props.className}>
      <rect x="3" y="4" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.75" />
      <path d="M16 2v4M8 2v4M3 10h18M7 14h2M12 14h2M7 18h2M12 18h2" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  ),
};
