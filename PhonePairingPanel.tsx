/**
 * Malachi – PhonePairingPanel.tsx
 *
 * "Per Telefonnummer verbinden" im Verbinden-Bildschirm (ConnectScreen in
 * App.tsx). Die Logik steckt komplett in PhonePairing.js; hier nur Eingabe,
 * Status, Code-Vergleich und Hinweise.
 *
 * Datenschutz: die eingegebenen Nummern stehen nur im Zustand dieser
 * Komponente - und auch dort nur bis zum Start (danach haelt sie die Sitzung
 * bis zur Ableitung im Funktionsumfang). Beim Wechsel in den Hintergrund und
 * beim Verlassen des Bildschirms werden Eingaben geleert und eine laufende
 * Kopplung abgebrochen. Kein Autofill, keine Speicherung, kein Log.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, AppState } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { t } from './i18n';
import { getTheme, subscribeTheme } from './Themes';
import { normalizePairingId, startPhonePairing, PHONE_PAIR_WINDOW_MS, ID_MIN_LEN, ID_MAX_LEN } from './PhonePairing';

// Farben aus dem gewaehlten Design (wie P in App.tsx bzw. C in SiegelScreen).
const C: any = {};
function syncColors(t) {
  Object.assign(C, {
    surface: t.surface, surfaceAlt: t.surfaceAlt, border: t.border, text: t.text, sub: t.textSub,
    muted: t.textMuted, accent: t.accent, onAccent: t.onAccent, accentFg: t.accentFg,
    accentSoft: t.accentSoft, codeText: t.codeText, danger: t.danger, success: t.success, warning: t.warning,
  });
}
syncColors(getTheme());
subscribeTheme(syncColors);

const RUNNING = new Set(['preparing', 'waiting', 'handshake', 'compare', 'confirm-wait', 'pairing']);

// Fehlertexte in der aktuellen Sprache (locales/*.js, phonePairing.err.*) -
// als Getter, damit ein Sprachwechsel ohne Neustart greift.
const PHONE_ERROR_KEYS = {
  'invalid-number': 'phonePairing.err.invalid-number',
  'invalid-id': 'phonePairing.err.invalid-id',
  'same-number': 'phonePairing.err.same-number',
  'same-id': 'phonePairing.err.same-id',
  unsupported: 'phonePairing.err.unsupported',
  tor: 'phonePairing.err.tor',
  timeout: 'phonePairing.err.timeout',
  'compare-timeout': 'phonePairing.err.compare-timeout',
  cancelled: 'phonePairing.err.cancelled',
  background: 'phonePairing.err.background',
  wipe: 'phonePairing.err.wipe',
  mismatch: 'phonePairing.err.mismatch',
  'peer-abort': 'phonePairing.err.peer-abort',
  connection: 'phonePairing.err.connection',
  protocol: 'phonePairing.err.protocol',
  'auth-flood': 'phonePairing.err.auth-flood',
  interrupted: 'phonePairing.err.interrupted',
  internal: 'phonePairing.err.internal',
};
export const PHONE_ERROR_TEXT = {};
for (const [code, key] of Object.entries(PHONE_ERROR_KEYS)) {
  Object.defineProperty(PHONE_ERROR_TEXT, code, { get: () => t(key), enumerable: true });
}

function statusText(st, tail) {
  const who = tail ? t('phonePairing.deinenKontakt', { tail }) : t('phonePairing.deinenKontakt2');
  switch (st.phase) {
    case 'preparing': return t('phonePairing.treffpunktWirdVorbereitet');
    case 'waiting': return st.role === 'host'
      ? t('phonePairing.treffpunktStehtWarteAuf', { who })
      : t('phonePairing.warteAufSucheDenTreffpunkt', { who });
    case 'handshake': return t('phonePairing.kontaktGefundenSchluesselWerdenAusgetauscht');
    case 'confirm-wait': return t('phonePairing.warteAufDieBestaetigungDeines');
    case 'pairing': return t('phonePairing.codeBestaetigtKontaktWirdEingerichtet');
    default: return '';
  }
}

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};

export default function PhonePairingPanel({ onPaired }: { onPaired: (contact: any, rtc: any) => void }) {
  // Telefonnummern oder freie Kennungen (Nutzerwunsch 2026-10-25) - beide
  // Seiten muessen dieselbe Art waehlen.
  const [mode, setMode] = useState<'phone' | 'id'>('phone');
  const [own, setOwn] = useState('');
  const [other, setOther] = useState('');
  const [inputError, setInputError] = useState('');
  const [st, setSt] = useState<any>({ phase: 'idle' });
  const [tail, setTail] = useState('');
  const [, setNowTick] = useState(0);
  const ctrl = useRef<any>(null);
  const mounted = useRef(true);
  const onPairedRef = useRef(onPaired);
  onPairedRef.current = onPaired;

  const clearInputs = () => { setOwn(''); setOther(''); setTail(''); };

  useEffect(() => {
    mounted.current = true;
    // Hintergrund: Eingaben leeren, laufende Kopplung abbrechen (die Sitzung
    // bricht selbst auch ab - doppelt haelt besser).
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'background') return;
      ctrl.current?.cancel('background');
      clearInputs();
    });
    return () => {
      mounted.current = false;
      try { sub?.remove?.(); } catch {}
      const c = ctrl.current;
      ctrl.current = null;
      c?.cancel('unmount');
    };
  }, []);

  const running = RUNNING.has(st.phase);
  useEffect(() => {
    if (!running || st.phase === 'compare') return;
    const t = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running, st.phase]);

  const start = () => {
    if (ctrl.current) return;
    const a = normalizePairingId(own, mode);
    const b = normalizePairingId(other, mode);
    if (!a) { setInputError(mode === 'id' ? t('phonePairing.err.ownInvalidId', { min: ID_MIN_LEN }) : t('phonePairing.err.ownInvalid')); return; }
    if (!b) { setInputError(mode === 'id' ? t('phonePairing.err.otherInvalidId', { min: ID_MIN_LEN }) : t('phonePairing.err.otherInvalid')); return; }
    if (a === b) { setInputError(PHONE_ERROR_TEXT[mode === 'id' ? 'same-id' : 'same-number']); return; }
    setInputError('');
    // Nummern sofort aus dem Eingabezustand entfernen - die Sitzung braucht sie
    // nur bis zur Schluesselableitung. Angezeigt werden nur zwei Endziffern.
    setOwn('');
    setOther('');
    setTail([...b].slice(-2).join(''));
    setSt({ phase: 'preparing' });
    ctrl.current = startPhonePairing({
      mode,
      ownNumber: a,
      otherNumber: b,
      onState: (s) => {
        if (s.phase === 'done' || s.phase === 'error') { ctrl.current = null; if (mounted.current) setTail(''); }
        if (mounted.current) setSt(s);
      },
      onPaired: (contact, rtc) => onPairedRef.current?.(contact, rtc),
    });
    // Sofort (noch im Aufruf) beendet, z.B. "nicht unterstuetzt": kein
    // haengender Verweis, sonst ginge "Erneut verbinden" nicht mehr.
    if (ctrl.current?.finished) ctrl.current = null;
  };

  const cancel = () => { ctrl.current?.cancel(); clearInputs(); };

  const inputStyle = {
    backgroundColor: C.surface, borderRadius: 12, borderWidth: 0.5, borderColor: C.border,
    padding: 14, fontSize: 16, color: C.text, letterSpacing: 0.5,
  };
  const label = { fontSize: 12, color: C.muted, marginBottom: 6 };
  const elapsed = st.startedAt ? Date.now() - st.startedAt : 0;

  return (
    <View style={{ gap: 16 }}>
      <Text style={{ fontSize: 15, fontWeight: '600', color: C.text }}>
        {mode === 'id' ? t('phonePairing.perKennungVerbinden') : t('phonePairing.perTelefonnummerVerbinden')}
      </Text>
      {(st.phase === 'idle' || st.phase === 'error') && (
        <View testID="phone-mode" accessibilityRole="tablist" style={{ flexDirection: 'row', backgroundColor: C.surfaceAlt, borderRadius: 12, padding: 3 }}>
          {([['phone', t('phonePairing.modePhone')], ['id', t('phonePairing.modeId')]] as const).map(([m, text]) => {
            const on = mode === m;
            return (
              <TouchableOpacity key={m} testID={'phone-mode-' + m} accessibilityRole="tab" accessibilityState={{ selected: on }}
                onPress={() => { if (!on) { setMode(m); clearInputs(); setInputError(''); } }}
                style={{ flex: 1, borderRadius: 10, paddingVertical: 9, alignItems: 'center', backgroundColor: on ? C.surface : 'transparent',
                  borderWidth: on ? 0.5 : 0, borderColor: C.border }}>
                <Text style={{ fontSize: 13, fontWeight: on ? '600' : '500', color: on ? C.text : C.sub }}>{text}</Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
      <Text style={{ fontSize: 13, color: C.sub, lineHeight: 20 }}>
        {mode === 'id' ? t('phonePairing.idHint', { min: ID_MIN_LEN }) : t('phonePairing.amBestenWaehrendIhrMiteinander')}
      </Text>

      {(st.phase === 'idle' || st.phase === 'error') && (
        <View style={{ gap: 12 }}>
          <View>
            <Text style={label}>{mode === 'id' ? t('phonePairing.deineKennung') : t('phonePairing.deineNummer')}</Text>
            <TextInput testID="phone-own" style={inputStyle} value={own} onChangeText={setOwn}
              placeholder={mode === 'id' ? t('phonePairing.idPlaceholderOwn') : 'z. B. 0176 12345678'} placeholderTextColor={C.muted}
              keyboardType={mode === 'id' ? 'default' : 'phone-pad'} autoComplete="off" importantForAutofill="no" textContentType="none"
              autoCorrect={false} autoCapitalize="none" maxLength={mode === 'id' ? ID_MAX_LEN * 2 : 30} />
          </View>
          <View>
            <Text style={label}>{mode === 'id' ? t('phonePairing.kennungDeinesKontakts') : t('phonePairing.nummerDeinesKontakts')}</Text>
            <TextInput testID="phone-other" style={inputStyle} value={other} onChangeText={setOther}
              placeholder={mode === 'id' ? t('phonePairing.idPlaceholderOther') : 'z. B. +49 151 98765432'} placeholderTextColor={C.muted}
              keyboardType={mode === 'id' ? 'default' : 'phone-pad'} autoComplete="off" importantForAutofill="no" textContentType="none"
              autoCorrect={false} autoCapitalize="none" maxLength={mode === 'id' ? ID_MAX_LEN * 2 : 30} />
          </View>
          {!!inputError && <Text testID="phone-input-error" style={{ color: C.danger, fontSize: 13, lineHeight: 19 }}>{inputError}</Text>}
          {st.phase === 'error' && (
            <View testID="phone-error" style={{ backgroundColor: C.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: C.danger, padding: 14, flexDirection: 'row', gap: 10 }}>
              <Icon name="alert-triangle" size={16} color={C.danger} />
              <Text style={{ color: C.text, fontSize: 13, lineHeight: 19, flex: 1 }}>{PHONE_ERROR_TEXT[st.error] || PHONE_ERROR_TEXT.internal}</Text>
            </View>
          )}
          <TouchableOpacity testID="phone-start" accessibilityRole="button" onPress={start}
            disabled={!own.trim() || !other.trim()}
            style={{ borderRadius: 14, padding: 16, alignItems: 'center',
              backgroundColor: own.trim() && other.trim() ? C.accent : C.surfaceAlt }}>
            <Text style={{ color: own.trim() && other.trim() ? C.onAccent : C.sub, fontSize: 15, fontWeight: '500' }}>
              {st.phase === 'error' ? t('phonePairing.erneutVerbinden') : t('common.connect')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {running && st.phase !== 'compare' && (
        <View testID="phone-status" style={{ backgroundColor: C.surface, borderRadius: 12, borderWidth: 0.5, borderColor: C.border, padding: 16, gap: 10 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="loader" size={16} color={C.muted} />
            <Text style={{ color: C.text, fontSize: 14, flex: 1, lineHeight: 20 }}>{statusText(st, tail)}</Text>
          </View>
          {(st.phase === 'waiting' || st.phase === 'handshake') && (
            <Text style={{ color: C.muted, fontSize: 12 }}>{t('phonePairing.von', { value: mmss(elapsed), value2: mmss(PHONE_PAIR_WINDOW_MS) })}</Text>
          )}
          {st.phase !== 'pairing' && (
            <TouchableOpacity testID="phone-cancel" accessibilityRole="button" onPress={cancel} style={{ alignSelf: 'flex-start', paddingVertical: 4 }}>
              <Text style={{ color: C.danger, fontSize: 13, fontWeight: '500' }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {st.phase === 'compare' && (
        <View style={{ gap: 12 }}>
          <View style={{ backgroundColor: C.surfaceAlt, borderRadius: 12, borderWidth: 1, borderColor: C.accent, paddingVertical: 18, paddingHorizontal: 12, alignItems: 'center' }}>
            <Text style={{ color: C.muted, fontSize: 12, marginBottom: 6 }}>{t('phonePairing.verbundenCodeVergleichen')}</Text>
            <Text testID="phone-code" style={{ color: C.accentFg, fontSize: 32, fontWeight: '700', letterSpacing: 4 }}>{st.code}</Text>
          </View>
          <Text style={{ color: C.sub, fontSize: 13, lineHeight: 19 }}>
            {t('phonePairing.lestEuchDenCodeAm')}
          </Text>
          {st.peerConfirmed && <Text style={{ color: C.success, fontSize: 12 }}>{t('phonePairing.deinKontaktHatBereitsBestaetigt')}</Text>}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            <TouchableOpacity testID="phone-reject" accessibilityRole="button" onPress={() => ctrl.current?.confirm(false)}
              style={{ flex: 1, borderRadius: 14, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: C.danger }}>
              <Text style={{ color: C.danger, fontSize: 14, fontWeight: '500' }}>{t('phonePairing.stimmtNicht')}</Text>
            </TouchableOpacity>
            <TouchableOpacity testID="phone-confirm" accessibilityRole="button" onPress={() => ctrl.current?.confirm(true)}
              style={{ flex: 1, borderRadius: 14, padding: 14, alignItems: 'center', backgroundColor: C.accent }}>
              <Text style={{ color: C.onAccent, fontSize: 14, fontWeight: '600' }}>{t('phonePairing.stimmtUeberein')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {st.phase === 'done' && (
        <View style={{ backgroundColor: C.accentSoft, borderRadius: 12, padding: 14, alignItems: 'center' }}>
          <Text style={{ color: C.codeText, fontSize: 14, fontWeight: '500' }}>{t('connect.connected')}</Text>
        </View>
      )}

      <View style={{ backgroundColor: C.accentSoft, borderRadius: 12, padding: 14, gap: 8 }}>
        {[
          ['lock', mode === 'id' ? t('phonePairing.kennungenWerdenNichtGespeichert') : t('phonePairing.dieNummernWerdenNichtGespeichert')],
          ['clock', t('phonePairing.beideMuessenGleichzeitigStartenInnerhalb')],
          ['shield', t('phonePairing.danachZeigenBeideHandysEinen')],
        ].map(([icon, text]) => (
          <View key={icon} style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
            <Icon name={icon} size={14} color={C.codeText} style={{ marginTop: 2 }} />
            <Text style={{ color: C.codeText, fontSize: 12, lineHeight: 18, flex: 1 }}>{text}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
