import type { SVGProps, ReactElement } from 'react';
import type { FieldKind } from './types';

type IP = SVGProps<SVGSVGElement>;

export const Icon = {
  Close: (p: IP) => (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...p}>
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Back: (p: IP) => (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" {...p}>
      <path d="M10 3l-5 5 5 5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Chevron: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  ChevronR: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Search: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <circle cx="7" cy="7" r="4.2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10.2 10.2l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Check: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Plus: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Image: (p: IP) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" {...p}>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.3" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="5.6" cy="6.2" r="1.1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M2.4 11.4l3.2-2.7 2.6 2.2 2.4-1.8 3 2.4" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  Text: (p: IP) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" {...p}>
      <path d="M3 4h10M8 4v9M6 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Help: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
      <path d="M6.4 6.4c.2-1 1-1.6 1.9-1.6 1 0 1.7.7 1.7 1.6 0 1.4-1.7 1.4-1.7 2.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r=".7" fill="currentColor" />
    </svg>
  ),
  Doc: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M3.5 2h6L13 5.5V14H3.5V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.3 2v3.5H13" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M5.5 8h5M5.5 10.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
  Warn: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <path d="M8 2.4l6 10.6H2L8 2.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11" r=".7" fill="currentColor" />
    </svg>
  ),
  Pause: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}>
      <rect x="4" y="3" width="2.6" height="10" rx=".6" />
      <rect x="9.4" y="3" width="2.6" height="10" rx=".6" />
    </svg>
  ),
  Play: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}>
      <path d="M4.5 3.2v9.6L13 8 4.5 3.2z" />
    </svg>
  ),
  Stop: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" {...p}>
      <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
    </svg>
  ),
  Download: (p: IP) => (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" {...p}>
      <path d="M8 2.5v8M4.5 7l3.5 3.5L11.5 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 13.2h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  ),
  Retry: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <path d="M13 8a5 5 0 1 1-1.5-3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M13.5 2.5V5h-2.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  Folder: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <path d="M2 4.5C2 3.8 2.5 3.3 3.2 3.3h3l1.2 1.4h5.4c.7 0 1.2.5 1.2 1.2v5.9c0 .7-.5 1.2-1.2 1.2H3.2c-.7 0-1.2-.5-1.2-1.2V4.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  ),
  User: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <circle cx="8" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M3.5 13c.6-2 2.4-3.2 4.5-3.2s3.9 1.2 4.5 3.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Team: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <circle cx="5.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.8 12.5c.4-1.5 1.9-2.5 3.7-2.5s3.3 1 3.7 2.5M8.8 12.5c.4-1.5 1.9-2.5 3.7-2.5 1 0 1.9.3 2.5.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  ),
  Sparkle: (p: IP) => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" {...p}>
      <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l2 2M10 10l2 2M12 4l-2 2M6 10l-2 2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  ),
};

const FIELD_TONE: Record<FieldKind, string> = {
  text: '#5b647a',
  number: '#3d8a6f',
  date: '#a8662b',
  phone: '#5b647a',
  person: '#5151b6',
  select: '#8e4cad',
  attachment: '#2766b8',
};

export function FieldTypeIcon({ type }: { type: FieldKind }): ReactElement {
  const tone = FIELD_TONE[type] ?? '#5b647a';
  const s = {
    stroke: tone,
    strokeWidth: 1.4,
    fill: 'none' as const,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  let svg: ReactElement;
  switch (type) {
    case 'text':
      svg = <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4h8M8 4v8M6 12h4" {...s} /></svg>;
      break;
    case 'number':
      svg = <svg viewBox="0 0 16 16" width="12" height="12"><path d="M3 6h10M3 10h10M6.5 3l-1 10M10.5 3l-1 10" {...s} /></svg>;
      break;
    case 'date':
      svg = (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <rect x="2.5" y="3.5" width="11" height="10" rx="1.4" {...s} />
          <path d="M2.5 6.5h11M5.5 2.5v2M10.5 2.5v2" {...s} />
        </svg>
      );
      break;
    case 'phone':
      svg = (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M3.5 4.5C3.5 3.7 4.2 3 5 3h1.2c.4 0 .7.2.9.6l.7 1.7c.2.5 0 1-.4 1.3l-.7.5c.7 1.4 1.8 2.5 3.2 3.2l.5-.7c.3-.4.8-.6 1.3-.4l1.7.7c.4.2.6.5.6.9V11c0 .8-.7 1.5-1.5 1.5C7.4 12.5 3.5 8.6 3.5 4.5z" {...s} />
        </svg>
      );
      break;
    case 'person':
      svg = (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <circle cx="8" cy="6" r="2.5" {...s} />
          <path d="M3.5 13c.6-2 2.4-3.2 4.5-3.2s3.9 1.2 4.5 3.2" {...s} />
        </svg>
      );
      break;
    case 'select':
      svg = (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <circle cx="8" cy="8" r="5" {...s} />
          <circle cx="8" cy="8" r="2" fill={tone} stroke="none" />
        </svg>
      );
      break;
    case 'attachment':
      svg = (
        <svg viewBox="0 0 16 16" width="12" height="12">
          <path d="M11.5 6.5l-4.7 4.7c-1 1-2.6 1-3.5 0-1-1-1-2.6 0-3.5l5.7-5.7c.7-.7 1.7-.7 2.4 0 .7.7.7 1.7 0 2.4L5.6 10.2c-.3.3-.9.3-1.2 0-.3-.3-.3-.9 0-1.2l4.5-4.5" {...s} />
        </svg>
      );
      break;
    default:
      svg = <svg viewBox="0 0 16 16" width="12" height="12"><path d="M4 4h8M8 4v8M6 12h4" {...s} /></svg>;
  }
  return <span className="ft" style={{ color: tone }}>{svg}</span>;
}
