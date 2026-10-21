// BIP84-Adressableitung aus einem Watch-only Extended Public Key (zpub/xpub).
//
// Der Server kennt NUR den oeffentlichen Konto-Schluessel (Ebene m/84'/0'/0').
// Daraus werden Empfangsadressen m/0/i (relativ zum Konto) als native
// SegWit-Adressen (P2WPKH, bc1q...) abgeleitet. Private Schluessel werden
// beim Einlesen ausdruecklich abgewiesen.

import { HDKey } from '@scure/bip32';
import { bech32, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const base58check = createBase58check(sha256);

const HARDENED = 0x80000000;

// Versions-Bytes (SLIP-0132). Nur zpub und xpub (Mainnet, oeffentlich) sind erlaubt.
const VERSIONEN = new Map([
  [0x04b24746, { art: 'zpub', erlaubt: true, privatGegenstueck: 0x04b2430c }],
  [0x0488b21e, { art: 'xpub', erlaubt: true, privatGegenstueck: 0x0488ade4 }],
  [0x049d7cb2, { art: 'ypub', grund: 'bip49' }],
  [0x02aa7ed3, { art: 'Zpub', grund: 'multisig' }],
  [0x0295b43f, { art: 'Ypub', grund: 'multisig' }],
  [0x045f1cf6, { art: 'vpub', grund: 'testnet' }],
  [0x043587cf, { art: 'tpub', grund: 'testnet' }],
  [0x044a5262, { art: 'upub', grund: 'testnet' }],
  [0x02575483, { art: 'Vpub', grund: 'testnet' }],
  [0x04b2430c, { art: 'zprv', grund: 'privat' }],
  [0x0488ade4, { art: 'xprv', grund: 'privat' }],
  [0x049d7878, { art: 'yprv', grund: 'privat' }],
  [0x02aa7a99, { art: 'Zprv', grund: 'privat' }],
  [0x0295b005, { art: 'Yprv', grund: 'privat' }],
  [0x045f18bc, { art: 'vprv', grund: 'privat' }],
  [0x04358394, { art: 'tprv', grund: 'privat' }],
  [0x044a4e28, { art: 'uprv', grund: 'privat' }],
]);

const GRUENDE = {
  privat:
    'PRIVATER SCHLUESSEL erkannt! Niemals einen privaten Schluessel auf den Server legen. ' +
    'Nur den oeffentlichen Konto-Schluessel (zpub) eintragen und den privaten Schluessel als kompromittiert betrachten, ' +
    'falls er bereits auf einem Server lag.',
  bip49: 'ypub gehoert zu BIP49 (Adressen mit "3..."). Der Shop nutzt BIP84 (bc1q...). Bitte die zpub eines Native-SegWit-Kontos verwenden.',
  multisig: 'Multisig-Schluessel (Zpub/Ypub) werden nicht unterstuetzt. Bitte die zpub eines Single-Sig-Native-SegWit-Kontos verwenden.',
  testnet: 'Testnet-Schluessel werden nicht akzeptiert. Der Shop arbeitet nur im Bitcoin-Mainnet.',
};

export class SchluesselFehler extends Error {}

/**
 * Liest einen Konto-Extended-Public-Key ein und prueft ihn streng.
 * Rueckgabe: { art, extern (HDKey fuer Kette m/0), fingerabdruck }
 */
export function ladeKontoSchluessel(eingabe) {
  if (typeof eingabe !== 'string') throw new SchluesselFehler('zpub fehlt.');
  const text = eingabe.trim();
  if (!/^[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(text)) {
    throw new SchluesselFehler('zpub hat kein gueltiges Format (Base58, ca. 111 Zeichen erwartet).');
  }
  let daten;
  try {
    daten = base58check.decode(text);
  } catch {
    throw new SchluesselFehler('zpub ist ungueltig (Pruefsumme stimmt nicht - Tippfehler?).');
  }
  if (daten.length !== 78) throw new SchluesselFehler('zpub hat eine falsche Laenge.');

  const ansicht = new DataView(daten.buffer, daten.byteOffset, daten.byteLength);
  const version = ansicht.getUint32(0);
  const info = VERSIONEN.get(version);
  if (!info) throw new SchluesselFehler('Unbekannter Schluesseltyp (Versions-Bytes 0x' + version.toString(16) + ').');
  if (!info.erlaubt) throw new SchluesselFehler(`${info.art}: ${GRUENDE[info.grund]}`);
  if (daten[45] !== 0x02 && daten[45] !== 0x03) {
    throw new SchluesselFehler('Der Schluessel enthaelt keinen oeffentlichen Schluessel.');
  }

  const tiefe = daten[4];
  const kindIndex = ansicht.getUint32(9);
  if (tiefe !== 3) {
    throw new SchluesselFehler(
      `Erwartet wird der Konto-Schluessel auf Ebene m/84'/0'/0' (Tiefe 3), gefunden Tiefe ${tiefe}. ` +
        'In Sparrow/Electrum den Konto-xpub/zpub exportieren, nicht den Master- oder einen Adress-Schluessel.',
    );
  }
  if (kindIndex < HARDENED) {
    throw new SchluesselFehler('Der Konto-Schluessel muss gehaertet abgeleitet sein (m/84\'/0\'/n\').');
  }

  let konto;
  try {
    konto = HDKey.fromExtendedKey(text, { public: version, private: info.privatGegenstueck });
  } catch (e) {
    throw new SchluesselFehler('zpub konnte nicht gelesen werden: ' + e.message);
  }
  if (konto.privateKey) throw new SchluesselFehler(GRUENDE.privat);

  const fingerabdruck = bytesToHex(sha256(daten.subarray(13))).slice(0, 16);
  return {
    art: info.art,
    kontoNummer: kindIndex - HARDENED,
    extern: konto.deriveChild(0),
    intern: konto.deriveChild(1),
    fingerabdruck,
  };
}

function p2wpkhAdresse(kind) {
  const hash = kind.pubKeyHash; // RIPEMD160(SHA256(pubkey))
  if (!hash || hash.length !== 20) throw new Error('Ableitung fehlgeschlagen');
  return bech32.encode('bc', [0, ...bech32.toWords(hash)]);
}

function pruefeIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= HARDENED) {
    throw new RangeError('Adressindex ausserhalb des gueltigen Bereichs');
  }
}

/** Empfangsadresse m/0/index (relativ zum Konto). */
export function empfangsAdresse(schluessel, index) {
  pruefeIndex(index);
  return p2wpkhAdresse(schluessel.extern.deriveChild(index));
}

/** Wechselgeld-Adresse m/1/index - wird vom Shop nicht benutzt, nur fuer Tests/Kontrolle. */
export function wechselgeldAdresse(schluessel, index) {
  pruefeIndex(index);
  return p2wpkhAdresse(schluessel.intern.deriveChild(index));
}

/** Oeffentlicher Schluessel (hex) einer Empfangsadresse - fuer Tests. */
export function empfangsPubkeyHex(schluessel, index) {
  pruefeIndex(index);
  return bytesToHex(schluessel.extern.deriveChild(index).publicKey);
}

/** Erzeugt einen Adress-Ableiter mit kleinem Zwischenspeicher. */
export function adressAbleiter(schluessel) {
  const cache = new Map();
  return (index) => {
    let a = cache.get(index);
    if (!a) {
      a = empfangsAdresse(schluessel, index);
      if (cache.size > 5000) cache.clear();
      cache.set(index, a);
    }
    return a;
  };
}

/** Grobe Formatpruefung einer bc1q-Adresse (P2WPKH, Mainnet). */
export function istBc1qAdresse(adresse) {
  if (typeof adresse !== 'string' || !/^bc1q[02-9ac-hj-np-z]{38}$/.test(adresse)) return false;
  try {
    const { prefix, words } = bech32.decode(adresse);
    return prefix === 'bc' && words[0] === 0 && bech32.fromWords(words.slice(1)).length === 20;
  } catch {
    return false;
  }
}
