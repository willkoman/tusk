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
  | "search"
  | "edit"
  | "trash"
  | "close"
  | "sparkle"
  | "wrap"
  | "lock"
  | "clock"
  | "copy"
  | "play"
  | "scissors"
  | "duplicate"
  | "comment"
  | "code"
  | "eyeOff"
  | "sortAsc"
  | "sortDesc"
  | "slash"
  | "eraser"
  | "resize"
  | "fileCode"
  | "star"
  | "gear"
  | "bolt"
  | "help"
  | "panelLeft"
  | "panelBottom"
  | "alert"
  // Direction matters in a menu: the same download arrow used to mark export,
  // import and backup, so the icon column actively misled.
  | "import"
  | "export"
  | "archive"
  | "save"
  | "paste"
  | "minus"
  | "more"
  // Reorder / fit-to-view. Forms used ↑ ↓ ⧉ ✕ ＋ ▸ « as icons: a typographic
  // glyph carries the text baseline and weight, not the icon set's.
  | "arrowUp"
  | "arrowDown"
  | "fit"
  | "chevronDown"
  | "chevronRight"
  | "chevronLeft";

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
    case "edit":
      return svg("currentColor", <><path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" /><path d="m15 5 4 4" /></>);
    case "trash":
      return svg("currentColor", <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M10 11v6M14 11v6" /></>);
    case "close":
      return svg("currentColor", <path d="M18 6 6 18M6 6l12 12" />);
    case "gear":
      return svg("currentColor", <><circle cx="12" cy="12" r="3" /><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /></>);
    case "sparkle":
      return svg("currentColor", <><path d="m12 3 1.9 5.1a2 2 0 0 0 1.2 1.2L20 11l-4.9 1.7a2 2 0 0 0-1.2 1.2L12 19l-1.9-5.1a2 2 0 0 0-1.2-1.2L4 11l4.9-1.7a2 2 0 0 0 1.2-1.2Z" /><path d="M19 4v3M21 5.5h-3" /></>);
    case "wrap":
      return svg("currentColor", <><path d="M3 6h18" /><path d="M3 12h15a3 3 0 0 1 0 6h-4" /><path d="m16 16-2 2 2 2" /><path d="M3 18h6" /></>);
    case "lock":
      return svg("currentColor", <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>);
    case "clock":
      return svg("currentColor", <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
    case "copy":
      return svg("currentColor", <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
    case "play":
      return svg("currentColor", <path d="M6 4v16l13-8z" />);
    case "scissors":
      return svg("currentColor", <><circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" /></>);
    case "duplicate":
      return svg("currentColor", <><path d="M12.8 2.2a2 2 0 0 0-1.6 0L2.6 6.1a1 1 0 0 0 0 1.8l8.6 3.9a2 2 0 0 0 1.6 0l8.6-3.9a1 1 0 0 0 0-1.8Z" /><path d="m2.3 12 8.9 4a2 2 0 0 0 1.6 0l8.9-4" /></>);
    case "comment":
      return svg("currentColor", <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
    case "code":
      return svg("currentColor", <path d="m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16" />);
    case "bolt":
      return svg(C.unique, <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />);
    case "help":
      return svg("currentColor", <><circle cx="12" cy="12" r="9" /><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2.6-3 4" /><path d="M12 17.5h.01" /></>);
    case "panelLeft":
      return svg("currentColor", <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>);
    case "alert":
      return svg("currentColor", <><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>);
    case "import":
      return svg("currentColor", <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>);
    case "export":
      return svg("currentColor", <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" /></>);
    case "archive":
      return svg("currentColor", <><rect x="3" y="4" width="18" height="4" rx="1" /><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8" /><path d="M10 12h4" /></>);
    case "save":
      return svg("currentColor", <><path d="M5 3h11l3 3v15H5z" /><path d="M8 3v6h7V3" /><path d="M8 21v-6h8v6" /></>);
    case "paste":
      return svg("currentColor", <><rect x="7" y="4" width="10" height="16" rx="2" /><path d="M10 4V3h4v1" /><path d="M10 11h4M10 15h4" /></>);
    case "minus":
      return svg("currentColor", <path d="M5 12h14" />);
    case "more":
      return svg("currentColor", <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>);
    case "arrowUp":
      return svg("currentColor", <path d="M12 20V4M6 10l6-6 6 6" />);
    case "arrowDown":
      return svg("currentColor", <path d="M12 4v16M6 14l6 6 6-6" />);
    case "fit":
      return svg("currentColor", <><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" /><rect x="8" y="8" width="8" height="8" rx="1" /></>);
    case "chevronDown":
      return svg("currentColor", <path d="m6 9 6 6 6-6" />);
    case "chevronRight":
      return svg("currentColor", <path d="m9 6 6 6-6 6" />);
    case "chevronLeft":
      return svg("currentColor", <path d="m15 6-6 6 6 6" />);
    case "panelBottom":
      return svg("currentColor", <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 14h18" /></>);
    case "eyeOff":
      return svg("currentColor", <><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /><path d="M10.7 5.1A10.4 10.4 0 0 1 12 5c7 0 10 7 10 7a13.2 13.2 0 0 1-1.7 2.7" /><path d="M6.6 6.6A13.5 13.5 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6" /><path d="m2 2 20 20" /></>);
    case "sortAsc":
      return svg("currentColor", <path d="m6 15 6-6 6 6" />);
    case "sortDesc":
      return svg("currentColor", <path d="m6 9 6 6 6-6" />);
    case "slash":
      return svg("currentColor", <path d="M9 4 5 20M19 4l-4 16" />);
    case "eraser":
      return svg("currentColor", <><path d="m7 21-4-4a2 2 0 0 1 0-3l9.5-9.5a2 2 0 0 1 3 0l4 4a2 2 0 0 1 0 3L11 21z" /><path d="M21 21H7M5 11l6 6" /></>);
    case "resize":
      return svg("currentColor", <path d="m18 8 4 4-4 4M6 8l-4 4 4 4M2 12h20" />);
    case "fileCode":
      return svg("currentColor", <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="m10 13-2 2 2 2M14 13l2 2-2 2" /></>);
    case "star":
      return svg("currentColor", <path d="M12 2.5l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.3l6.5-.9z" />);
    case "dot":
    default:
      return svg(C.neutral, <circle cx="12" cy="12" r="2.4" />, true);
  }
}
