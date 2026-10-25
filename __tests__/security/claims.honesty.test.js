// Krypto-Review 2026-10-25, V2: ehrliche Versprechen.
//  K-04  Anrufe (1:1 und Gruppe) laufen ueber DTLS-SRTP mit klassischem ECDHE -
//        sie duerfen nirgends als "post-quanten-verschluesselt" erscheinen.
//  K-02  Beim Teilen des Einladungslinks steht der Hinweis auf den Code-Vergleich.
//  K-05  Die PIN-Rateaufwand-Zahlen sind korrigiert und neutral formuliert.
const fs = require('fs');
const path = require('path');
const I = require('../../i18n');

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

describe('K-04: Anrufe nicht im Post-Quanten-Versprechen', () => {
  const de = I.getTable('de');
  const en = I.getTable('en');

  test('App-Texte (de/en): Post-Quanten nur fuer Nachrichten, Anrufe nur Ende-zu-Ende', () => {
    expect(de['pro.freeIntro']).toMatch(/Nachrichten Ende-zu-Ende- und Post-Quanten-verschlüsselt, Anrufe Ende-zu-Ende-verschlüsselt/);
    expect(de['tor.intro']).toMatch(/Nachrichten sind immer Ende-zu-Ende und Post-Quantum verschlüsselt, Anrufe Ende-zu-Ende\./);
    expect(de['connect.shareMessage']).toMatch(/Nachrichten Post-Quantum-verschlüsselt/);
    expect(en['pro.freeIntro']).toMatch(/messages end-to-end and post-quantum encrypted, calls end-to-end encrypted/);
    expect(en['tor.intro']).toMatch(/Messages are always end-to-end and post-quantum encrypted, calls end-to-end\./);
    expect(en['connect.shareMessage']).toMatch(/Messages post-quantum encrypted/);
  });

  test('kein deutscher oder englischer Text verspricht Post-Quanten-Schutz fuer Anrufe', () => {
    for (const tbl of [de, en]) {
      for (const [k, v] of Object.entries(tbl)) {
        const texts = typeof v === 'string' ? [v] : Object.values(v);
        for (const s of texts) {
          // "Anrufe ... post-quant" in EINEM Satzteil ohne Einschraenkung
          expect([k, /(Anrufe|Anruf|calls?)[^.;:]*(post-quant|Post-Quant)/i.test(s) && !/(noch nicht|not yet|noch ohne)/i.test(s)])
            .toEqual([k, false]);
        }
      }
    }
  });

  test.each(['website/site/index.html', 'website/site/faq.html'])('%s: Anrufe ausdruecklich noch nicht post-quanten-geschuetzt', (p) => {
    expect(read(p)).toMatch(/Sprach- und Videoanrufe sind Ende-zu-Ende verschlüsselt[^.]*noch nicht gegen künftige Quantencomputer geschützt/);
  });

  test.each(['website/site/en/index.html', 'website/site/en/faq.html'])('%s: calls explicitly not yet post-quantum', (p) => {
    expect(read(p)).toMatch(/Voice and video calls are end-to-end encrypted[^.]*not yet protected against future quantum computers/);
  });

  test('Datenschutz (de/en): Anrufe nicht PQ, Gruppenanruf-Host reicht Fingerabdruecke weiter', () => {
    expect(read('website/site/datenschutz.html')).toMatch(/Anrufe sind Ende-zu-Ende verschlüsselt, aber noch nicht gegen künftige Quantencomputer geschützt/);
    expect(read('website/site/datenschutz.html')).toMatch(/Gruppenanrufen[^.]*Fingerabdrücke/);
    expect(read('website/site/en/datenschutz.html')).toMatch(/Calls are end-to-end encrypted, but not yet protected against future quantum computers/);
  });

  test('PLAY_STORE.md: Anrufe ohne Post-Quanten-Versprechen (de/en)', () => {
    const s = read('PLAY_STORE.md');
    expect(s).toMatch(/Anrufe: Ende-zu-Ende-verschlüsselt \(DTLS-SRTP\), noch ohne Post-Quanten-Schutz/);
    expect(s).toMatch(/Calls: end-to-end encrypted \(DTLS-SRTP\), not yet post-quantum protected/);
    expect(s).not.toMatch(/^• Ende-zu-Ende-Verschlüsselung mit zusätzlichem Post-Quanten-Schlüsselaustausch\.$/m);
  });
});

describe('K-02: Hinweis auf den Code-Vergleich beim Teilen', () => {
  test.each(I.LANGUAGE_CODES)('%s: Teilen-Text behaelt den Link, Hinweis vorhanden', (code) => {
    const tbl = I.getTable(code);
    expect(tbl['connect.shareMessage']).toContain('{link}');
    expect(typeof tbl['connect.shareHint']).toBe('string');
    expect(tbl['connect.shareHint'].length).toBeGreaterThan(40);
    // Der geteilte Text selbst nennt den Vergleich ebenfalls (laenger als vorher).
    expect(tbl['connect.shareMessage'].split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(4);
  });

  test('Verbinden-Bildschirm zeigt den Hinweis direkt unter "Link teilen"', () => {
    const app = read('App.tsx');
    const share = app.indexOf("t('connect.shareLink')");
    const hint = app.indexOf("t('connect.shareHint')");
    expect(share).toBeGreaterThan(0);
    expect(hint).toBeGreaterThan(share);
    expect(hint - share).toBeLessThan(600);
  });
});

describe('K-05: PIN-Rateaufwand korrigiert, neutral', () => {
  test('PIN_VAULT_DESIGN.md: keine "Tage fuer 6 Stellen"-Behauptung mehr, keine Druck-Empfehlung', () => {
    const s = read('PIN_VAULT_DESIGN.md');
    expect(s).not.toMatch(/Empfehlung: 6 Stellen/);
    expect(s).toMatch(/4 Stellen eher Minuten, 6 Stellen Stunden \(TEE\) bis etwa\s+einen Tag \(StrongBox\)/);
  });

  test('SECURITY_AUDIT_2026-10-25.md: korrigiert, ohne "6 Stellen empfehlen"', () => {
    const s = read('SECURITY_AUDIT_2026-10-25.md');
    expect(s).not.toMatch(/6 Stellen empfehlen/);
    expect(s).toMatch(/4 Stellen eher Minuten/);
  });
});
