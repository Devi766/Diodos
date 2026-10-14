import React from 'react';

export function LatencyBoltIcon({ className = '', ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className={className} {...props}>
      <path
        d="M13.45 3.65 6.2 12.05c-.64.75-.15 1.9.83 1.95l3.89.19-.9 5.38c-.17 1.02 1.12 1.6 1.77.8l6.6-8.17c.61-.76.1-1.88-.87-1.91l-3.74-.12 1.39-5.54c.24-.98-1.06-1.74-1.72-.98Z"
        stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="m19 3 .38 1.12L20.5 4.5l-1.12.38L19 6l-.38-1.12L17.5 4.5l1.12-.38L19 3Z"
        fill="currentColor" opacity=".65" />
    </svg>
  );
}
