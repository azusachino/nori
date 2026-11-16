import type * as React from 'react'

export function NoriIcon({ className = 'h-8 w-8 shrink-0', ...props }: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      aria-hidden="true"
      className={className}
      {...props}
    >
      <rect fill="#536d4f" width="64" height="64" rx="16" />
      {/* n */}
      <path
        stroke="#f8f8f2"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M15 27V17.5a4.5 4.5 0 0 1 9 0V27"
      />
      {/* o */}
      <circle
        stroke="#f8f8f2"
        strokeWidth="3.6"
        fill="none"
        cx="43"
        cy="20"
        r="7"
      />
      {/* r */}
      <path
        stroke="#f8f8f2"
        strokeWidth="3.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        d="M15 51V41.5a4.5 4.5 0 0 1 8-2.5"
      />
      {/* i stem and dot */}
      <line
        stroke="#f8f8f2"
        strokeWidth="3.6"
        strokeLinecap="round"
        x1="43"
        y1="44"
        x2="43"
        y2="51"
      />
      <circle fill="#b46a3b" cx="43" cy="38" r="2.4" />
    </svg>
  )
}
