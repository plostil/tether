/** Inline SVG glyphs (stroke = currentColor). Line-art, no fills, no emoji. */

function svg(path: string, size = 16): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}

export const icons = {
  shield: svg('<path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/><path d="M9 12l2 2 4-4"/>'),
  monitor: svg('<rect x="3" y="4" width="18" height="12" rx="1"/><path d="M8 20h8M12 16v4"/>'),
  share: svg('<path d="M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7"/><path d="M12 15V4M8 8l4-4 4 4"/>'),
  phone: svg('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>'),
  message: svg('<path d="M4 5h16v11H8l-4 3V5z"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 011-1h9"/>', 14),
  link: svg('<path d="M9 15l6-6"/><path d="M11 6l1-1a3.5 3.5 0 015 5l-1 1"/><path d="M13 18l-1 1a3.5 3.5 0 01-5-5l1-1"/>'),
  x: svg('<path d="M6 6l12 12M18 6L6 18"/>', 14),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  home: svg('<path d="M4 11l8-7 8 7"/><path d="M6 10v9h12v-9"/>'),
};

export type IconName = keyof typeof icons;
