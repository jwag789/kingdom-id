/** A small set of 24px stroke icons, drawn to one grid so they sit together. Decorative unless labelled. */
const PATHS = {
  key: "M14.5 9.5a4 4 0 1 0-3.9 4L4 20v-3h3v-3h3l.6-.6A4 4 0 0 0 14.5 9.5Zm1.5-2h.01",
  passkey:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9v-1a5 5 0 0 1 5-5h2m8.5-1.5a2.5 2.5 0 1 0-3.5 2.3V20l1 1 1.5-1.5-1-1 1-1-1-1a2.5 2.5 0 0 0 2-2.5Z",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm9.5 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  mail: "M3.5 6.5h17v11h-17zM3.5 7l8.5 6.5L20.5 7",
  crown: "M3.5 8.5 7.5 12l4.5-6.5 4.5 6.5 4-3.5-1.5 10h-14zM5 20.5h14",
  shield: "M12 3 4.5 6v5.5c0 4.6 3.1 8.2 7.5 9.5 4.4-1.3 7.5-4.9 7.5-9.5V6zM9 12l2 2 4-4",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7.5 8.5a7.5 7.5 0 0 1 15 0",
  id: "M3.5 5.5h17v13h-17zM8.5 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3 4a3 3 0 0 1 6 0M14 9.5h4m-4 3h4",
  refresh: "M20 11.5A8 8 0 0 0 5.6 7M4 4v4h4m-4 4.5A8 8 0 0 0 18.4 17M20 20v-4h-4",
  link: "M9.5 14.5l5-5M10.5 6.5l1-1a4 4 0 0 1 5.7 5.7l-1 1m-8.4.6-1 1a4 4 0 0 0 5.7 5.7l1-1",
  check: "M5 12.5 10 17.5 19.5 7",
  alert: "M12 3.5 2.5 20h19zM12 10v4.5m0 2.5h.01",
  trash: "M4.5 7h15M9.5 7V4.5h5V7m-8 0 1 13h9l1-13",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  castle: "M4 20.5V9l2-1.5L8 9V6.5l2-1.5 2 1.5 2-1.5 2 1.5V9l2-1.5L20 9v11.5zM10 20.5v-4a2 2 0 0 1 4 0v4",
  mask: "M3.5 7.5c3-1.5 14-1.5 17 0 0 6-3 10-8.5 10S3.5 13.5 3.5 7.5Zm5 3h2m3 0h2",
  tower: "M8 20.5 9 9h6l1 11.5zM7.5 9h9M9 9V5h6v4m-3-4V3m-1.5 9.5h3",
  plug: "M9 3.5v4m6-4v4M7 7.5h10v3a5 5 0 0 1-10 0zm5 8v5",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
  lock: "M6.5 10.5h11v10h-11zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  sparkle: "M12 3.5 13.8 10.2 20.5 12l-6.7 1.8L12 20.5l-1.8-6.7L3.5 12l6.7-1.8z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label }: { name: IconName; label?: string }) {
  return (
    <svg
      class="icon"
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": "true", focusable: "false" })}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
