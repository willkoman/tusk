import type { JSX } from "solid-js";

// Monochrome line icons (Lucide-derived paths). Structural objects are neutral;
// key / foreign-key / unique / check markers get semantic accent colors so the
// tree is scannable at a glance.
const C = {
  pk: "#e6b450", // amber
  fk: "#6ea8fe", // blue
  unique: "#2dd4bf", // teal
  check: "#63d27f", // green
  neutral: "#94a3b8", // slate
};

function svg(color: string, body: JSX.Element, fill = false): JSX.Element {
  return (
    <svg
      class="tw-svg"
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill={fill ? color : "none"}
      stroke={fill ? "none" : color}
      stroke-width="1.9"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {body}
    </svg>
  );
}

export type IconName =
  | "database"
  | "folder"
  | "table"
  | "eye"
  | "columns"
  | "key"
  | "link"
  | "hash"
  | "check"
  | "shield"
  | "index"
  | "func"
  | "dot"
  | "plus"
  | "download"
  | "refresh"
  | "search";

export function Icon(props: { name: IconName }): JSX.Element {
  switch (props.name) {
    case "database":
      return svg(C.neutral, <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" /><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3" /></>);
    case "folder":
      return svg(C.neutral, <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 8.1 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);
    case "table":
      return svg(C.neutral, <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M3 9h18M3 15h18M12 3v18" /></>);
    case "eye":
      return svg(C.neutral, <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>);
    case "columns":
      return svg(C.neutral, <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M9 3v18M15 3v18" /></>);
    case "key":
      return svg(C.pk, <><circle cx="7.5" cy="15.5" r="5.5" /><path d="m21 2-9.6 9.6" /><path d="m15.5 7.5 3 3L22 7l-3-3" /></>);
    case "link":
      return svg(C.fk, <><path d="M9 17H7A5 5 0 0 1 7 7h2" /><path d="M15 7h2a5 5 0 0 1 0 10h-2" /><path d="M8 12h8" /></>);
    case "hash":
      return svg(C.unique, <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />);
    case "check":
      return svg(C.check, <path d="M20 6 9 17l-5-5" />);
    case "shield":
      return svg(C.neutral, <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />);
    case "index":
      return svg(C.neutral, <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />);
    case "func":
      return svg(C.neutral, <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />);
    case "plus":
      return svg("currentColor", <path d="M12 5v14M5 12h14" />);
    case "download":
      return svg("currentColor", <path d="M12 3v12M7 10l5 5 5-5M5 21h14" />);
    case "refresh":
      return svg("currentColor", <><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8" /><path d="M21 3v5h-5" /></>);
    case "search":
      return svg("currentColor", <><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></>);
    case "dot":
    default:
      return svg(C.neutral, <circle cx="12" cy="12" r="2.4" />, true);
  }
}
