import { Icon, IconProps } from "./Icon";

// Glyph set ported from `Aquarius Writer/vault/icons.jsx`.
// All glyphs accept IconProps; stroke defaults match the wrapper.

export const Caret = ({ open, ...p }: IconProps & { open?: boolean }) => (
  <Icon size={10} {...p}>
    <path d={open ? "M3 5l3 3 3-3" : "M5 3l3 3-3 3"} />
  </Icon>
);

export const FolderIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M1.5 4.5a1 1 0 011-1h3l1.2 1.2H13a1 1 0 011 1V12a1 1 0 01-1 1H2.5a1 1 0 01-1-1V4.5z" />
  </Icon>
);

export const FileIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 1.5h6L12.5 4.5V14a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V1.5z" />
    <path d="M9.5 1.5v3h3" />
  </Icon>
);

export const ScreenplayIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.2" />
    <path d="M5 6h6M5 8.5h6M5 11h4" />
  </Icon>
);

export const StarIcon = ({ filled, ...p }: IconProps & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? p.color ?? "currentColor" : "none"}>
    <path d="M8 1.8l1.85 3.95L14 6.35l-3.1 2.85.85 4.2L8 11.3l-3.75 2.1.85-4.2L2 6.35l4.15-.6L8 1.8z" />
  </Icon>
);

export const SearchIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3" />
  </Icon>
);

export const SidebarIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
    <path d="M6 2.5v11" />
  </Icon>
);

export const PanelRightIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
    <path d="M10 2.5v11" />
  </Icon>
);

export const PlusIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 3v10M3 8h10" />
  </Icon>
);

export const CloseIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </Icon>
);

export const SettingsIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v1.5M8 13v1.5M2.5 8H1M15 8h-1.5M3.7 3.7l1.1 1.1M11.2 11.2l1.1 1.1M3.7 12.3l1.1-1.1M11.2 4.8l1.1-1.1" />
  </Icon>
);

export const SparkleIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5l-1.4-4.1L2.5 7l4.1-1.4L8 1.5z" />
    <path d="M12.5 11l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4z" />
  </Icon>
);

export const SendIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 8l12-5.5L8.5 14 7 9.5 2 8z" />
  </Icon>
);

export const PinIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M9.5 1.5l5 5-2 1-3 3v3l-1.5-1.5L4.5 14l-2 .5.5-2 3-3.5-1.5-1.5h3l3-3 1-2z" />
  </Icon>
);

export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M11 4.5L5.5 10a2 2 0 102.8 2.8L13 8" />
    <path d="M9.5 6L5 10.5a1 1 0 101.4 1.4L11 7.5" />
  </Icon>
);

export const LinkIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6.5 9.5L9.5 6.5" />
    <path d="M5 7l-2 2a2.5 2.5 0 003.5 3.5l2-2" />
    <path d="M11 9l2-2a2.5 2.5 0 00-3.5-3.5l-2 2" />
  </Icon>
);

export const GlobeIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
  </Icon>
);

export const CommandIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M5 3.5a1.5 1.5 0 100 3h6a1.5 1.5 0 100-3 1.5 1.5 0 100 3v6a1.5 1.5 0 10-3 0v-6a1.5 1.5 0 10-3 0v6a1.5 1.5 0 10-3 0h6a1.5 1.5 0 100-3" />
  </Icon>
);

export const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3 8.5l3 3 7-7" />
  </Icon>
);

export const CircleIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6" />
  </Icon>
);

export const DotIcon = ({ color, size = 8 }: { color: string; size?: number }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: size,
      background: color,
      display: "inline-block",
      flexShrink: 0,
    }}
  />
);

export const WarnIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2l6.5 11h-13L8 2z" />
    <path d="M8 6v4M8 11.5v.01" />
  </Icon>
);

export const UndoIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 6.5h7a4 4 0 010 8H6" />
    <path d="M5 3.5L2 6.5l3 3" />
  </Icon>
);

export const PlayIcon = (p: IconProps) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M4 3l9 5-9 5V3z" />
  </Icon>
);

export const SplitIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="3" width="13" height="10" rx="1.2" />
    <path d="M8 3v10" />
  </Icon>
);

export const BookIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2.5 3.5h4a2 2 0 012 2v8a1.5 1.5 0 00-1.5-1.5h-4.5v-8.5z" />
    <path d="M13.5 3.5h-4a2 2 0 00-2 2v8a1.5 1.5 0 011.5-1.5h4.5v-8.5z" />
  </Icon>
);

export const GraphIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4" cy="4.5" r="2" />
    <circle cx="12" cy="5" r="1.6" />
    <circle cx="8.5" cy="12" r="2" />
    <path d="M5.5 6l2 4.5M5.5 5l5 .5M10.5 6.5l-2 4" />
  </Icon>
);

export const GearIcon = SettingsIcon;
export const DocIcon = FileIcon;

export const ChevronIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 4l4 4-4 4" />
  </Icon>
);

export const ImageIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.2" />
    <circle cx="5.5" cy="6" r="1.2" />
    <path d="M2 12l3.5-3.5L8 11l2.5-2.5L14 12" />
  </Icon>
);

export const PdfIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M3.5 1.5h6L12.5 4.5V14a.5.5 0 01-.5.5H4a.5.5 0 01-.5-.5V1.5z" />
    <path d="M9.5 1.5v3h3" />
    <path
      d="M5.4 11.2v-2.2h.9a.7.7 0 010 1.4H5.4M8 11.2v-2.2h.7a1 1 0 011 1.1 1 1 0 01-1 1.1H8M10.6 11.2v-2.2h1.4M10.6 10.1h1"
      strokeWidth="1.05"
    />
  </Icon>
);

export const ZoomInIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3M5 7h4M7 5v4" />
  </Icon>
);

export const ZoomOutIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5l3 3M5 7h4" />
  </Icon>
);

export const FitIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 5V2.5h2.5M11.5 2.5H14V5M14 11v2.5h-2.5M4.5 13.5H2V11" />
  </Icon>
);

export const RotateIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M13 6.5a5 5 0 10-1.5 5" />
    <path d="M13 3v3.5h-3.5" />
  </Icon>
);

export const DownloadIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M8 2v8.5M4.5 7l3.5 3.5L11.5 7" />
    <path d="M3 13h10" />
  </Icon>
);

export const PrintIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M4 5.5V2.5h8v3" />
    <rect x="2" y="5.5" width="12" height="6" rx="1" />
    <rect x="4.5" y="9.5" width="7" height="4" />
  </Icon>
);
