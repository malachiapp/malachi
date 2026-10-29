/**
 * Malachi – SafetyNumberDialog.tsx  (Krypto-Review 2026-10-25, V1)
 *
 * Anzeige und Bestaetigung des Sicherheitscodes im Chat (ChatScreen in
 * App.tsx). Logik und Speicher: SafetyNumber.js.
 *
 *  - 'v2'      stabiler Code der Ratchet-Sitzung (6 x 5 Ziffern). Bleibt gleich,
 *              solange die Sitzung besteht - auch ueber neue Verbindungen, Tor-
 *              Reserve und Direkt-Upgrade. "Stimmt ueberein" speichert den
 *              Zustand "bestaetigt". Ein Hinweis erscheint NUR, wenn sich die
 *              Sitzung wirklich geaendert hat.
 *  - 'legacy'  Gegenseite 1.0/1.1: dort steht der alte 16-stellige Code der
 *              aktuellen Verbindung. Er wird hier gezeigt, mit dem Hinweis,
 *              dass er nur fuer diese Verbindung gilt.
 *  - 'pending' beide neu, die Sitzung entsteht gerade (erste Nachricht).
 *
 * Bestaetigt der Nutzer ausdruecklich "stimmt ueberein", meldet onConfirmed()
 * das an den Chat (dort verschwindet z.B. der Hinweis "Vorgestellt von ...").
 * Das Oeffnen des Dialogs allein bestaetigt nichts mehr (Befund K-03).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Modal, Alert } from 'react-native';
import { t } from './i18n';
import { getTheme, subscribeTheme } from './Themes';
import { getSafetyInfo, markVerified, markLegacyVerified, unverify, acknowledgeChange } from './SafetyNumber';

const C: any = {};
function syncColors(th) {
  Object.assign(C, {
    overlay: th.overlay, surface: th.surface, surfaceAlt: th.surfaceAlt, border: th.border, text: th.text,
    muted: th.textMuted, accent: th.accent, onAccent: th.onAccent, accentFg: th.accentFg,
    accentSoft: th.accentSoft, codeText: th.codeText, success: th.success, danger: th.danger,
  });
}
syncColors(getTheme());
subscribeTheme(syncColors);

const POLL_MS = 2000;

function sameInfo(a, b) {
  if (!a || !b) return a === b;
  return a.mode === b.mode && a.number === b.number && a.verified === b.verified && a.changed === b.changed
    && a.legacyCode === b.legacyCode && a.legacyVerified === b.legacyVerified;
}

/**
 * Sicherheitscode-Zustand eines Kontakts, alle 2 s aktualisiert.
 * getLegacyCode: () => 16-stelliger Code der aktuellen Verbindung oder null.
 * -> [info | null, refresh]
 */
export function useSafetyInfo(chatId, getLegacyCode) {
  const [info, setInfo] = useState(null);
  const legacyRef = useRef(getLegacyCode);
  legacyRef.current = getLegacyCode;
  const refresh = useCallback(async () => {
    if (!chatId) return null;
    let legacyCode = null;
    try { legacyCode = legacyRef.current ? legacyRef.current() || null : null; } catch {}
    const next = await getSafetyInfo(chatId, { legacyCode }).catch(() => null);
    setInfo((prev) => (sameInfo(prev, next) ? prev : next));
    return next;
  }, [chatId]);
  useEffect(() => {
    if (!chatId) { setInfo(null); return undefined; }
    let alive = true;
    const tick = () => { if (alive) refresh().catch(() => {}); };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [chatId, refresh]);
  return [info, refresh];
}

/** Gibt es etwas anzuzeigen (Schild im Chat-Kopf)? */
export function hasSafetyDisplay(info) {
  return !!info && (info.mode === 'v2' || info.mode === 'pending' || !!info.legacyCode);
}

function CodeBox({ text, testID }) {
  const groups = String(text || '').split(' ');
  const rows = groups.length === 6 ? [groups.slice(0, 3).join('  '), groups.slice(3).join('  ')] : [String(text || '')];
  return (
    <View testID={testID} style={{ backgroundColor: C.accentSoft, borderRadius: 12, paddingVertical: 18, paddingHorizontal: 12, alignItems: 'center' }}>
      {rows.map((r, i) => (
        <Text key={i} style={{ fontSize: groups.length === 6 ? 22 : 26, fontWeight: '700', color: C.codeText, letterSpacing: 2, fontFamily: 'monospace' }}>
          {r}
        </Text>
      ))}
    </View>
  );
}

function Button({ label, onPress, primary = false, testID }) {
  return (
    <TouchableOpacity testID={testID} accessibilityRole="button" onPress={onPress}
      style={{ backgroundColor: primary ? C.accent : C.surfaceAlt, borderRadius: 12, padding: 14, alignItems: 'center',
        borderWidth: primary ? 0 : 0.5, borderColor: C.border }}>
      <Text style={{ color: primary ? C.onAccent : C.accentFg, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}

/**
 * Dialog. info: aus useSafetyInfo. onConfirmed: Nutzer hat ausdruecklich
 * "stimmt ueberein" bestaetigt. onRefresh: Zustand neu laden.
 */
export function SafetyNumberDialog({ visible, chatId, info, onClose, onConfirmed, onRefresh }) {
  const close = () => {
    if (info?.changed) acknowledgeChange(chatId).then(() => onRefresh?.()).catch(() => {});
    onClose?.();
  };
  const mismatch = () => Alert.alert(t('safety.v2.mismatchTitle'), t('safety.v2.mismatchBody'));
  const confirmV2 = async () => {
    const ok = await markVerified(chatId, info?.number).catch(() => false);
    await onRefresh?.();
    if (ok) onConfirmed?.();
  };
  const confirmLegacy = async () => {
    const ok = await markLegacyVerified(chatId, info?.legacyCode).catch(() => false);
    await onRefresh?.();
    if (ok) onConfirmed?.();
  };
  const withdraw = async () => {
    await unverify(chatId).catch(() => {});
    await onRefresh?.();
  };

  const mode = info?.mode || 'legacy';
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={close}>
      <View style={{ flex: 1, backgroundColor: C.overlay, justifyContent: 'center', alignItems: 'center', padding: 24 }}>
        <View testID="safety-dialog" style={{ backgroundColor: C.surface, borderRadius: 20, padding: 24, width: '100%', gap: 14 }}>
          <Text style={{ fontSize: 18, fontWeight: '700', color: C.text, textAlign: 'center' }}>{t('safety.title')}</Text>
          {mode === 'v2' && info?.changed ? (
            <View testID="safety-changed" style={{ backgroundColor: '#FBF0DE', borderRadius: 12, padding: 12 }}>
              <Text style={{ fontSize: 12, color: '#8A5A1E', textAlign: 'center', lineHeight: 17 }}>{t('safety.v2.changed')}</Text>
            </View>
          ) : null}

          {mode === 'v2' ? (
            <>
              <Text style={{ fontSize: 13, color: C.muted, textAlign: 'center', lineHeight: 20 }}>{t('safety.v2.compare')}</Text>
              <CodeBox text={info.number} testID="safety-number" />
              <Text testID="safety-status" style={{ fontSize: 13, fontWeight: '600', textAlign: 'center', color: info.verified ? C.success : C.muted }}>
                {info.verified ? t('safety.v2.verified') : t('safety.v2.notVerified')}
              </Text>
              {!info.verified ? (
                <View style={{ gap: 8 }}>
                  <Button testID="safety-match" primary label={t('safety.v2.match')} onPress={confirmV2} />
                  <Button testID="safety-mismatch" label={t('safety.v2.noMatch')} onPress={mismatch} />
                </View>
              ) : (
                <TouchableOpacity testID="safety-unverify" accessibilityRole="button" onPress={withdraw} style={{ alignItems: 'center' }}>
                  <Text style={{ fontSize: 12, color: C.accentFg }}>{t('safety.v2.unverify')}</Text>
                </TouchableOpacity>
              )}
              <Text style={{ fontSize: 11, color: C.muted, textAlign: 'center', lineHeight: 16 }}>{t('safety.v2.oldPeerHint')}</Text>
            </>
          ) : (
            <>
              <Text testID="safety-legacy-hint" style={{ fontSize: 13, color: C.muted, textAlign: 'center', lineHeight: 20 }}>
                {mode === 'pending' ? t('safety.pending') : t('safety.legacy.compare')}
              </Text>
              {info?.legacyCode ? (
                <>
                  <CodeBox text={info.legacyCode} testID="safety-legacy-code" />
                  {info.legacyVerified ? (
                    <Text testID="safety-status" style={{ fontSize: 13, fontWeight: '600', textAlign: 'center', color: C.success }}>{t('safety.legacy.verified')}</Text>
                  ) : (
                    <View style={{ gap: 8 }}>
                      <Button testID="safety-match" primary label={t('safety.v2.match')} onPress={confirmLegacy} />
                      <Button testID="safety-mismatch" label={t('safety.v2.noMatch')} onPress={mismatch} />
                    </View>
                  )}
                </>
              ) : (
                <Text style={{ fontSize: 12, color: C.muted, textAlign: 'center' }}>{t('safety.legacy.noConnection')}</Text>
              )}
            </>
          )}
          <Button testID="safety-close" label={t('safety.close')} onPress={close} />
        </View>
      </View>
    </Modal>
  );
}

export default SafetyNumberDialog;
