// BIP84-Ableitung gegen die offiziellen Testvektoren aus der BIP84-Spezifikation
// (Mnemonic "abandon abandon ... about"). Nur oeffentliche Testdaten.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mnemonicToSeedSync } from '@scure/bip39';
import { HDKey } from '@scure/bip32';
import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2';
import {
  ladeKontoSchluessel,
  empfangsAdresse,
  wechselgeldAdresse,
  empfangsPubkeyHex,
  adressAbleiter,
  istBc1qAdresse,
  SchluesselFehler,
} from '../src/bip84.js';
import { BIP84_TESTVEKTOR_ZPUB } from '../src/config.js';

const b58c = createBase58check(sha256);

// Werte aus https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki (Test vectors)
const V = {
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  rootpub: 'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF',
  kontoZprv: 'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE',
  kontoZpub: 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs',
  empfang0Pubkey: '0330d54fd0dd420a6e5f8d3624f5f3482cae350f79d5f0753bf5beef9c2d91af3c',
  empfang0: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu',
  empfang1: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g',
  wechsel0: 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el',
};

/** Ersetzt die Versions-Bytes eines Extended Keys (fuer xpub/ypub/vpub-Varianten). */
function mitVersion(schluessel, version) {
  const d = Uint8Array.from(b58c.decode(schluessel));
  new DataView(d.buffer).setUint32(0, version);
  return b58c.encode(d);
}

describe('BIP84-Testvektoren', () => {
  it('leitet aus der Mnemonic die offizielle Konto-zpub ab', () => {
    const seed = mnemonicToSeedSync(V.mnemonic);
    const wurzel = HDKey.fromMasterSeed(seed, { private: 0x04b2430c, public: 0x04b24746 });
    assert.equal(wurzel.publicExtendedKey, V.rootpub);
    const konto = wurzel.derive("m/84'/0'/0'");
    assert.equal(konto.privateExtendedKey, V.kontoZprv);
    assert.equal(konto.publicExtendedKey, V.kontoZpub);
    assert.equal(V.kontoZpub, BIP84_TESTVEKTOR_ZPUB);
  });

  it('erste Empfangsadresse m/0/0 = bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', () => {
    const k = ladeKontoSchluessel(V.kontoZpub);
    assert.equal(k.art, 'zpub');
    assert.equal(k.kontoNummer, 0);
    assert.equal(empfangsPubkeyHex(k, 0), V.empfang0Pubkey);
    assert.equal(empfangsAdresse(k, 0), V.empfang0);
  });

  it('zweite Empfangsadresse und erste Wechselgeldadresse stimmen', () => {
    const k = ladeKontoSchluessel(V.kontoZpub);
    assert.equal(empfangsAdresse(k, 1), V.empfang1);
    assert.equal(wechselgeldAdresse(k, 0), V.wechsel0);
  });

  it('Ableitung aus zpub entspricht der Ableitung aus dem privaten Schluessel', () => {
    const seed = mnemonicToSeedSync(V.mnemonic);
    const wurzel = HDKey.fromMasterSeed(seed);
    const k = ladeKontoSchluessel(V.kontoZpub);
    for (let i = 0; i < 5; i++) {
      const privat = wurzel.derive(`m/84'/0'/0'/0/${i}`);
      assert.equal(empfangsPubkeyHex(k, i), Buffer.from(privat.publicKey).toString('hex'));
    }
  });

  it('dieselbe Schluessel als xpub liefert dieselben Adressen', () => {
    const xpub = mitVersion(V.kontoZpub, 0x0488b21e);
    assert.ok(xpub.startsWith('xpub'));
    const k = ladeKontoSchluessel(xpub);
    assert.equal(k.art, 'xpub');
    assert.equal(empfangsAdresse(k, 0), V.empfang0);
    assert.equal(k.fingerabdruck, ladeKontoSchluessel(V.kontoZpub).fingerabdruck);
  });

  it('Adress-Ableiter mit Zwischenspeicher liefert gleiche Werte', () => {
    const f = adressAbleiter(ladeKontoSchluessel(V.kontoZpub));
    assert.equal(f(0), V.empfang0);
    assert.equal(f(0), V.empfang0);
    assert.equal(f(1), V.empfang1);
  });
});

describe('Abweisung ungeeigneter Schluessel', () => {
  const fehlerMit = (eingabe, muster) => {
    assert.throws(() => ladeKontoSchluessel(eingabe), (e) => e instanceof SchluesselFehler && muster.test(e.message));
  };

  it('weist private Schluessel (zprv/xprv) deutlich ab', () => {
    fehlerMit(V.kontoZprv, /PRIVATER SCHLUESSEL/);
    fehlerMit(mitVersion(V.kontoZprv, 0x0488ade4), /PRIVATER SCHLUESSEL/);
  });

  it('weist Master-Schluessel (Tiefe 0) ab', () => {
    fehlerMit(V.rootpub, /Tiefe 3/);
  });

  it('weist ypub, Testnet (vpub/tpub) und Multisig (Zpub) ab', () => {
    fehlerMit(mitVersion(V.kontoZpub, 0x049d7cb2), /BIP49/);
    fehlerMit(mitVersion(V.kontoZpub, 0x045f1cf6), /Testnet/);
    fehlerMit(mitVersion(V.kontoZpub, 0x043587cf), /Testnet/);
    fehlerMit(mitVersion(V.kontoZpub, 0x02aa7ed3), /Multisig/);
  });

  it('erkennt Tippfehler (Pruefsumme) und Unsinn', () => {
    const kaputt = V.kontoZpub.slice(0, 50) + (V.kontoZpub[50] === 'a' ? 'b' : 'a') + V.kontoZpub.slice(51);
    fehlerMit(kaputt, /Pruefsumme/);
    fehlerMit('', /Format/);
    fehlerMit('zpub123', /Format/);
    fehlerMit(undefined, /fehlt/);
  });

  it('Indexbereich wird geprueft', () => {
    const k = ladeKontoSchluessel(V.kontoZpub);
    assert.throws(() => empfangsAdresse(k, -1), RangeError);
    assert.throws(() => empfangsAdresse(k, 0x80000000), RangeError);
    assert.throws(() => empfangsAdresse(k, 1.5), RangeError);
  });

  it('istBc1qAdresse erkennt gueltige und ungueltige Adressen', () => {
    assert.ok(istBc1qAdresse(V.empfang0));
    assert.ok(!istBc1qAdresse('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyv'));
    assert.ok(!istBc1qAdresse('tb1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
    assert.ok(!istBc1qAdresse('../../etc/passwd'));
  });
});
