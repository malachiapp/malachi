/**
 * Malachi - App-Icon-Varianten ("App-Icon passend zum Design", THEMES.md)
 *
 * Reine Logik ohne React Native: welche Launcher-Icons es gibt und welches zu
 * welchem Design gehoert. Genutzt von AppIcon.js (Umschalten zur Laufzeit) und
 * tools/gen-theme-icons.js (erzeugt daraus Icons, Manifest-Aliase und
 * AppIconVariants.kt) - beide Seiten lesen dieselbe Liste.
 *
 *   klassik          das bisherige Marken-Icon (Standard-Design, Akzent Cyan) -
 *                    Voreinstellung, bleibt bei ausgeschaltetem Schalter
 *   klassik_<akzent> Standard-Design mit einer der 11 anderen kostenlosen
 *                    Akzentfarben: Marken-Hintergrund, Zeichen im Akzent
 *   <themeId>        je eines der 21 Design-Themen (Vollversion)
 *
 * "Kopfleiste und Menue einfaerben" aendert das Icon bewusst nicht (sonst
 * doppelt so viele Varianten fuer einen kaum sichtbaren Unterschied).
 */
import { FREE_ACCENTS, DEFAULT_ACCENT_KEY, PRO_THEMES, DEFAULT_THEME_ID } from './Themes';

export const DEFAULT_ICON_VARIANT = DEFAULT_THEME_ID;   // 'klassik'

/** Name der activity-alias im Manifest: Namespace + ICON_ALIAS_PREFIX + id. */
export const ICON_ALIAS_PREFIX = 'AppIcon_';

/** Alle Varianten in fester Reihenfolge: { id, themeId, accentKey, name, pro }. */
export const ICON_VARIANTS = Object.freeze([
  { id: DEFAULT_ICON_VARIANT, themeId: DEFAULT_THEME_ID, accentKey: DEFAULT_ACCENT_KEY, name: 'Standard', pro: false },
  ...FREE_ACCENTS
    .filter(a => a.key !== DEFAULT_ACCENT_KEY)
    .map(a => ({ id: DEFAULT_THEME_ID + '_' + a.key, themeId: DEFAULT_THEME_ID, accentKey: a.key, name: 'Standard, Akzent ' + a.label, pro: false })),
  ...PRO_THEMES.map(t => ({ id: t.id, themeId: t.id, accentKey: null, name: t.name, pro: true })),
].map(v => Object.freeze(v)));

export const ICON_VARIANT_IDS = Object.freeze(ICON_VARIANTS.map(v => v.id));

export function isIconVariant(id) {
  return typeof id === 'string' && ICON_VARIANT_IDS.includes(id);
}

/**
 * Angezeigtes Thema (resolveTheme/getTheme) -> passende Variante. Ohne
 * gueltige Lizenz zeigt Themes.js "Standard" an - dann gilt auch hier das
 * Standard-Icon (mit der kostenlosen Akzentfarbe), nie ein Pro-Icon.
 */
export function iconVariantForTheme(theme) {
  if (!theme || !theme.id || theme.id === DEFAULT_THEME_ID) {
    const key = theme && theme.accentKey;
    const id = DEFAULT_THEME_ID + '_' + key;
    return key && key !== DEFAULT_ACCENT_KEY && isIconVariant(id) ? id : DEFAULT_ICON_VARIANT;
  }
  return isIconVariant(theme.id) ? theme.id : DEFAULT_ICON_VARIANT;
}

/** Gewuenschtes Icon: Schalter aus -> immer das Standard-Icon. */
export function desiredIconVariant(selection, theme) {
  return selection && selection.appIcon === true ? iconVariantForTheme(theme) : DEFAULT_ICON_VARIANT;
}
