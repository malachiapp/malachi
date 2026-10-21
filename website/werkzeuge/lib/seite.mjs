// Statische Seite bauen: Teile einsetzen ({{TEIL:name}}), Platzhalter
// ersetzen ({{NAME}}; Werte werden HTML-maskiert, ausser NAME endet auf
// _HTML), aktive Navigation markieren ({{AKTUELL:seite}}), Ergebnis pruefen.
// Kein JavaScript im Ergebnis, keine Inline-Styles, keine fremden Ressourcen
// - passend zur strengen CSP des Servers.

import fs from 'node:fs';
import path from 'node:path';

export const PLATZHALTER_MARKE = '[BITTE AUSFUELLEN';

export class SeitenFehler extends Error {}

export function htmlMaskieren(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function platzhalterHtml(was) {
  return `<span class="platzhalter">${PLATZHALTER_MARKE}: ${htmlMaskieren(was)}]</span>`;
}

/** 38,4 MB (dezimal, wie Android Dateigroessen anzeigt). */
export function groesseText(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3)).toLocaleString('de-DE')} kB`;
  return `${(bytes / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** 38.4 MB (englische Schreibweise). */
export function groesseTextEn(bytes) {
  if (bytes < 1e6) return `${Math.max(1, Math.round(bytes / 1e3)).toLocaleString('en-GB')} kB`;
  return `${(bytes / 1e6).toLocaleString('en-GB', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function datumTextEn(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

const MONATE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
export function datumText(date) {
  return `${date.getUTCDate()}. ${MONATE[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Versionshinweise (Klartext) -> HTML: Zeilen mit "- " werden Listenpunkte, Leerzeilen trennen Absaetze. */
export function hinweiseHtml(text) {
  const bloecke = String(text).replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const teile = [];
  for (const block of bloecke) {
    const zeilen = block.split('\n').map((z) => z.trim()).filter(Boolean);
    if (zeilen.length === 0) continue;
    if (zeilen.every((z) => z.startsWith('- '))) {
      teile.push('<ul>\n' + zeilen.map((z) => `    <li>${htmlMaskieren(z.slice(2).trim())}</li>`).join('\n') + '\n  </ul>');
    } else {
      teile.push(`<p>${zeilen.map(htmlMaskieren).join('<br>\n  ')}</p>`);
    }
  }
  return teile.join('\n  ');
}

/**
 * Ersetzt alle Marken einer Datei.
 * @param {string} quelltext
 * @param {{ seite: string, basis: string, teile: Record<string,string>, werte: Record<string, string|{html:string}> }} k
 */
export function vorlageAnwenden(quelltext, k) {
  // Teile zuerst (sie enthalten selbst wieder Marken), nicht verschachtelt.
  let text = quelltext.replace(/\{\{TEIL:([a-z]+)\}\}/g, (_, name) => {
    if (!(name in k.teile)) throw new SeitenFehler(`Unbekannter Teil: ${name} (${k.seite})`);
    return k.teile[name].replace(/\n$/, '');
  });
  text = text.replace(/\{\{AKTUELL:([a-z0-9-]+)\}\}/g, (_, name) => (name === k.seite ? ' aria-current="page"' : ''));
  text = text.replace(/\{\{SEITE\}\}/g, k.seite);
  text = text.replace(/\{\{BASIS\}\}/g, k.basis);
  text = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
    if (!(name in k.werte)) throw new SeitenFehler(`Unbekannte Marke {{${name}}} in ${k.seite}`);
    const w = k.werte[name];
    if (w && typeof w === 'object' && 'html' in w) return w.html;
    if (name.endsWith('_HTML')) throw new SeitenFehler(`{{${name}}} braucht einen HTML-Wert.`);
    return htmlMaskieren(w);
  });
  if (/\{\{|\}\}/.test(text)) throw new SeitenFehler(`Nicht ersetzte Marke in ${k.seite}`);
  return text;
}

/** Prueft eine fertige HTML-Seite auf Dinge, die die CSP brechen oder Daten abfliessen lassen wuerden. */
export function seitePruefen(name, html) {
  const fehler = [];
  if (/<script\b/i.test(html)) fehler.push('enthaelt <script>');
  if (/\sstyle\s*=/i.test(html)) fehler.push('enthaelt style="..." (CSP erlaubt nur style.css)');
  if (/<style\b/i.test(html)) fehler.push('enthaelt <style> (CSP erlaubt nur style.css)');
  if (/\son[a-z]+\s*=/i.test(html)) fehler.push('enthaelt Ereignis-Attribute (onclick=...)');
  if (/<(iframe|object|embed|form|base)\b/i.test(html)) fehler.push('enthaelt iframe/object/embed/form/base');
  // Fremde Ressourcen: src/srcset/poster/data nie extern; <link href> nie extern.
  if (/\s(src|srcset|poster|data)\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) fehler.push('laedt eine fremde Ressource (src=//...)');
  if (/<link\b[^>]*\shref\s*=\s*["']?\s*(https?:)?\/\//i.test(html)) fehler.push('<link> auf fremde Adresse');
  if (!/^<!doctype html>/i.test(html)) fehler.push('beginnt nicht mit <!doctype html>');
  const sprache = name.startsWith('en/') ? 'en' : 'de';
  if (!new RegExp(`<html lang="${sprache}">`).test(html)) fehler.push(`fehlendes lang="${sprache}"`);
  if (!/<meta charset="utf-8">/.test(html.slice(0, 1024))) fehler.push('<meta charset> fehlt in den ersten 1024 Byte');
  if (fehler.length) throw new SeitenFehler(`${name}: ${fehler.join('; ')}`);
}

/** Alle Dateien eines Verzeichnisses (relativ, mit /), sortiert. */
export function dateienListen(wurzel) {
  const aus = [];
  const gehe = (rel) => {
    for (const e of fs.readdirSync(path.join(wurzel, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new SeitenFehler(`Symbolischer Link nicht erlaubt: ${r}`);
      if (e.isDirectory()) gehe(r);
      else if (e.isFile()) aus.push(r);
      else throw new SeitenFehler(`Sonderdatei nicht erlaubt: ${r}`);
    }
  };
  gehe('');
  return aus.sort();
}

/**
 * Baut die Seite aus quelle nach ziel. Ordner/Dateien, die mit _ oder . beginnen, werden nicht kopiert.
 * @returns {{ seiten: string[], platzhalter: string[] }}
 */
export function seiteBauen(quelle, ziel, werte) {
  const teile = {};
  const teileOrdner = path.join(quelle, '_teile');
  for (const f of fs.readdirSync(teileOrdner)) {
    if (f.endsWith('.html')) teile[f.slice(0, -5)] = fs.readFileSync(path.join(teileOrdner, f), 'utf8');
  }
  const seiten = [];
  const platzhalter = [];
  for (const rel of dateienListen(quelle)) {
    if (rel.split('/').some((t) => t.startsWith('_') || t.startsWith('.'))) continue;
    const zielDatei = path.join(ziel, ...rel.split('/'));
    fs.mkdirSync(path.dirname(zielDatei), { recursive: true });
    if (rel.endsWith('.html')) {
      const seite = path.basename(rel, '.html');
      const html = vorlageAnwenden(fs.readFileSync(path.join(quelle, rel), 'utf8'), {
        seite,
        basis: seite === '404' ? '/' : '../'.repeat(rel.split('/').length - 1),
        teile,
        werte,
      });
      seitePruefen(rel, html);
      if (html.includes(PLATZHALTER_MARKE)) platzhalter.push(rel);
      fs.writeFileSync(zielDatei, html);
      seiten.push(rel);
    } else {
      fs.copyFileSync(path.join(quelle, rel), zielDatei);
    }
  }
  return { seiten, platzhalter };
}
