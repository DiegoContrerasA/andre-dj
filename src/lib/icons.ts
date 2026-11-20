// Íconos SVG (trazo de 24×24). Se usan desde Icon.astro y desde los scripts (play/pausa).
export const ICONS = {
  settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  pause: '<path d="M8.5 5v14M15.5 5v14"/>',
  back: '<path d="M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5"/>',
  forward: '<path d="M20 12a8 8 0 1 1-2.5-5.8M20 4v4.5h-4.5"/>',
  upload: '<path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 14v4.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V14"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M5 12h14M12 5v14"/>',
} as const;

export type IconName = keyof typeof ICONS;

export const svg = (name: IconName, strokeWidth = 1.8) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
