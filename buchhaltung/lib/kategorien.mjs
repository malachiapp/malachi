// Ausgaben-Kategorien und ihre VORGESCHLAGENE Zuordnung zu Feldern der Anlage EUeR.
// Die Feldbezeichnungen folgen dem Formular; Zeilennummern aendern sich von Jahr zu
// Jahr und stehen deshalb bewusst nicht hier. Alles ist ein Entwurf - vor der
// Uebernahme in ELSTER pruefen (keine Steuerberatung).

export const UEBRIGE = 'Übrige unbeschränkt abziehbare Betriebsausgaben';

export const KATEGORIEN = {
  server: { name: 'Server und Hosting', euer: UEBRIGE },
  domain: { name: 'Domain und DNS', euer: UEBRIGE },
  software: { name: 'Software, Lizenzen, Entwicklerkonten (z. B. Google Play)', euer: UEBRIGE },
  gebuehren: { name: 'Gebühren (Bank, Börse, Netzwerk)', euer: UEBRIGE },
  telekom: { name: 'Telefon und Internet (betrieblicher Anteil)', euer: 'Aufwendungen für Telekommunikation (z. B. Telefon, Internet)' },
  werbung: { name: 'Werbung', euer: 'Werbekosten (z. B. Inserate, Werbespots, Plakate)' },
  gwg: { name: 'Geräte bis 800 € netto (geringwertige Wirtschaftsgüter)', euer: 'Aufwendungen für geringwertige Wirtschaftsgüter nach § 6 Abs. 2 EStG' },
  anlage: { name: 'Geräte über 800 € netto (Abschreibung)', euer: null, klaerung: 'Anschaffungen über 800 € netto werden über mehrere Jahre abgeschrieben (AfA) - Betrag und Nutzungsdauer bitte klären.' },
  fortbildung: { name: 'Fortbildung', euer: 'Fortbildungskosten (ohne Reisekosten)' },
  sonstiges: { name: 'Sonstiges', euer: UEBRIGE },
};

export const KATEGORIE_SCHLUESSEL = Object.keys(KATEGORIEN);

export function kategorie(schluessel) {
  const k = KATEGORIEN[schluessel];
  if (!k) throw new Error(`Unbekannte Kategorie "${schluessel}" - erlaubt: ${KATEGORIE_SCHLUESSEL.join(', ')}`);
  return k;
}

// Felder fuer Einnahmen und shop-seitige Kosten (ebenfalls Vorschlag).
export const EUER_EINNAHMEN = 'Betriebseinnahmen als umsatzsteuerlicher Kleinunternehmer';
export const EUER_SHOP_GEBUEHREN = UEBRIGE;
