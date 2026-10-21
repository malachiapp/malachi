// Exakte Dezimalrechnung fuer Geldbetraege (BigInt statt Gleitkomma).

/** "0.006163" -> 6163000000n (bei stellen=12). Negative Werte erlaubt. */
export function dezimalZuAtomar(text, stellen) {
  const s = String(text).trim().replace(',', '.');
  const m = /^(-?)(\d{1,18})(?:\.(\d{1,30}))?$/.exec(s);
  if (!m) throw new Error(`Ungueltiger Betrag: ${text}`);
  const nachkomma = (m[3] || '').replace(/0+$/, '');
  if (nachkomma.length > stellen) throw new Error(`Zu viele Nachkommastellen (max. ${stellen}): ${text}`);
  const wert = BigInt(m[2]) * 10n ** BigInt(stellen) + BigInt((nachkomma || '0').padEnd(stellen, '0'));
  return m[1] ? -wert : wert;
}

/** 6163000000n -> "0.006163000000" (bei stellen=12). */
export function atomarZuDezimal(wert, stellen) {
  const n = BigInt(wert);
  const neg = n < 0n;
  const a = neg ? -n : n;
  const basis = 10n ** BigInt(stellen);
  const ganz = a / basis;
  const rest = a % basis;
  const text = stellen > 0 ? `${ganz}.${rest.toString().padStart(stellen, '0')}` : `${ganz}`;
  return neg ? '-' + text : text;
}

/** Entfernt Nullen am Ende, laesst aber mindestens `min` Nachkommastellen stehen. */
export function kuerzen(text, min = 2) {
  const [ganz, nach = ''] = text.split('.');
  let n = nach.replace(/0+$/, '');
  if (n.length < min) n = n.padEnd(min, '0');
  return n ? `${ganz}.${n}` : ganz;
}

