/**
 * Malachi – SecurityPinModal.tsx
 *
 * Einstellungen > Sicherheit (Nutzerwunsch 29.10.2026): App-PIN aendern,
 * Notfall-PIN (Duress-PIN) festlegen/aendern/entfernen - jeweils erst nach
 * der aktuellen App-PIN (PinChange.js). Fehlversuche zaehlen wie am
 * Sperrbildschirm: nach dem 3. wird die App gesperrt (Sperrfrist), mit
 * Vollversion nach dem 5. geloescht.
 *
 * Die Eingabe der aktuellen PIN verraet ihre Laenge nicht (kein automatisches
 * Absenden bei 4/6 Ziffern, Feld nimmt bis zu 6) - wie der Sperrbildschirm.
 * Neue PIN und Notfall-PIN werden zweimal eingegeben: ein Vertipper bei der
 * Notfall-PIN hiesse, dass sie im Ernstfall nicht greift.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator } from 'react-native';
import { t } from './i18n';
import * as PinChange from './PinChange';
import { canConfigureDuressPin, isProVerified } from './LicenseManager';

type Mode = 'changePin' | 'setDuress' | 'changeDuress' | 'removeDuress';
type Step = 'current' | 'new' | 'repeat' | 'duress' | 'duressRepeat';
export type PinFlowResult = 'pinChanged' | 'pinChangedDuressRemoved' | 'duressSet' | 'duressRemoved';

type Props = {
  mode: Mode | null;
  palette: any;
  accent: string;
  onClose: () => void;
  onDone: (r: PinFlowResult) => void;
  onLockNow: () => void;     // Sperrfrist erreicht: App sperren (Sperrbildschirm zeigt die Restzeit)
  onWipe: () => void;        // Vollversion, 5. Fehlversuch: loeschen wie am Sperrbildschirm
  onNeedPro: () => void;     // Notfall-PIN festlegen ohne (gueltige) Vollversion
};

export default function SecurityPinModal({ mode, palette: P, accent, onClose, onDone, onLockNow, onWipe, onNeedPro }: Props) {
  const [step, setStep] = useState<Step>('current');
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [curLen, setCurLen] = useState(6);
  const [newLen, setNewLen] = useState(6);
  const [hadDuress, setHadDuress] = useState(false);
  // Nur bis zum Ende des Vorgangs im Arbeitsspeicher, danach geleert.
  const oldPin = useRef('');
  const firstEntry = useRef('');

  const reset = () => {
    setStep('current'); setInput(''); setError(''); setBusy(false);
    oldPin.current = ''; firstEntry.current = '';
  };

  useEffect(() => {
    if (!mode) { reset(); return; }
    reset();
    PinChange.currentPinLength().then((n) => { setCurLen(n); setNewLen(n); }).catch(() => {});
    PinChange.hasDuress().then(setHadDuress).catch(() => {});
  }, [mode]);

  const close = () => { reset(); onClose(); };
  const finish = (r: PinFlowResult) => { reset(); onDone(r); };

  const go = (next: Step, err = '') => { setStep(next); setInput(''); setError(err); };

  const submitCurrent = async () => {
    if (!input) return;
    setBusy(true);
    setError(t('lock.unlocking'));
    let r: any;
    try { r = await PinChange.confirmAppPin(input); } catch { r = { ok: false, reason: 'error' }; }
    setBusy(false);
    if (r.ok) {
      oldPin.current = input;
      if (mode === 'removeDuress') {
        await PinChange.removeDuress();
        finish('duressRemoved');
        return;
      }
      go(mode === 'changePin' ? 'new' : 'duress');
      return;
    }
    setInput('');
    if (r.reason === 'locked') { close(); onLockNow(); return; }
    if (r.reason === 'wrong') {
      if (r.wipe) { close(); onWipe(); return; }
      if (r.lockMs > 0) { close(); onLockNow(); return; }
      setError(r.message || t('pin.wrong'));
      return;
    }
    setError(t('lock.vaultError'));
  };

  const submitNew = () => {
    if (input.length !== newLen) { setError(t('pinChange.digits', { n: newLen })); return; }
    firstEntry.current = input;
    go('repeat');
  };

  const submitRepeat = async () => {
    if (input !== firstEntry.current) { firstEntry.current = ''; go('new', t('lock.mismatch')); return; }
    setBusy(true);
    setError(t('lock.unlocking'));
    let r: any;
    try { r = await PinChange.changeAppPin(oldPin.current, input); } catch { r = { result: 'error' }; }
    setBusy(false);
    firstEntry.current = '';
    if (r.result === 'ok') { finish(r.duressRemoved ? 'pinChangedDuressRemoved' : 'pinChanged'); return; }
    if (r.result === 'same') { go('new', t('pinChange.same')); return; }
    if (r.result === 'duress') { go('new', t('pinChange.isDuress')); return; }
    go('new', t('lock.vaultError'));
  };

  const submitDuress = () => {
    if (input.length !== curLen) { setError(t('settings.duress.lengthMismatch', { n: curLen })); return; }
    firstEntry.current = input;
    go('duressRepeat');
  };

  const submitDuressRepeat = async () => {
    if (input !== firstEntry.current) { firstEntry.current = ''; go('duress', t('lock.mismatch')); return; }
    setBusy(true);
    setError(t('lock.unlocking'));
    // Vollversion frisch pruefen (nicht nur der Anzeige-Zustand).
    let pro = false;
    try { pro = await isProVerified(); } catch {}
    if (!canConfigureDuressPin(pro)) { setBusy(false); close(); onNeedPro(); return; }
    let r = 'error';
    try { r = await PinChange.setDuress(input); } catch {}
    setBusy(false);
    firstEntry.current = '';
    if (r === 'ok') { finish('duressSet'); return; }
    if (r === 'same') { go('duress', t('settings.duress.samePin')); return; }
    if (r === 'length') { go('duress', t('settings.duress.lengthMismatch', { n: curLen })); return; }
    go('duress', t('lock.vaultError'));
  };

  const submit = () => {
    if (busy) return;
    if (step === 'current') submitCurrent();
    else if (step === 'new') submitNew();
    else if (step === 'repeat') submitRepeat();
    else if (step === 'duress') submitDuress();
    else submitDuressRepeat();
  };

  const title = mode === 'changePin' ? t('pinChange.title')
    : mode === 'removeDuress' ? t('settings.duress.removeTitle')
    : mode === 'changeDuress' ? t('settings.duress.changeTitle')
    : t('settings.duress.modalTitle');
  const label = step === 'current' ? t('pinChange.currentLabel')
    : step === 'new' ? t('pinChange.newLabel')
    : step === 'repeat' ? t('pinChange.repeatLabel')
    : step === 'duress' ? t('settings.duress.newLabel')
    : t('settings.duress.repeatLabel');
  const maxLen = step === 'current' ? 6 : step === 'new' || step === 'repeat' ? newLen : curLen;
  const isLast = step === 'repeat' || step === 'duressRepeat';
  const isError = !!error && error !== t('lock.unlocking');

  return (
    <Modal visible={!!mode} transparent animationType="fade" onRequestClose={close}>
      {/* Oben statt mittig: die Zifferntastatur verdeckte sonst "Weiter"/"Abbrechen"
          (Geraetetest 29.10.2026). */}
      <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center', justifyContent:'flex-start', paddingHorizontal:24, paddingTop:56 }}>
        <View testID="security-pin-modal" style={{ width:'100%', backgroundColor:P.surface, borderRadius:20, padding:24, gap:12 }}>
          <Text style={{ fontSize:17, fontWeight:'600', color:P.text }}>{title}</Text>
          {step === 'current' && (
            <Text style={{ fontSize:12, color:P.textSub, lineHeight:18 }}>
              {t('pinChange.currentBody')}
            </Text>
          )}
          {step === 'duress' && (
            <Text style={{ fontSize:12, color:P.textSub, lineHeight:18 }}>
              {t('settings.duress.modalBody')} {t('settings.duress.lengthHint', { n: curLen })}
            </Text>
          )}
          {step === 'new' && (
            <View style={{ flexDirection:'row', gap:8 }}>
              {[4, 6].map((l) => (
                <TouchableOpacity key={l} testID={'pin-len-' + l} onPress={() => { setNewLen(l); setInput(''); setError(''); }}
                  accessibilityRole="radio" accessibilityState={{ selected: newLen === l }}
                  style={{ paddingHorizontal:16, paddingVertical:7, borderRadius:18, borderWidth:1,
                    backgroundColor: newLen === l ? accent : P.surfaceAlt, borderColor: newLen === l ? accent : P.border }}>
                  <Text style={{ fontSize:13, fontWeight:'500', color: newLen === l ? P.onAccent : P.textSub }}>{t('lock.digits', { n: l })}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          {step === 'new' && hadDuress && newLen !== curLen && (
            <Text style={{ fontSize:12, color:P.warning, lineHeight:18 }}>{t('pinChange.dropDuress')}</Text>
          )}
          <Text style={{ fontSize:13, color:P.textSub }}>{label}</Text>
          <TextInput
            key={step + newLen}
            testID="security-pin-input"
            value={input}
            onChangeText={(v) => { setInput(v.replace(/\D/g, '').slice(0, maxLen)); if (isError) setError(''); }}
            onSubmitEditing={submit}
            autoFocus
            secureTextEntry
            keyboardType="number-pad"
            maxLength={maxLen}
            editable={!busy}
            importantForAutofill="no"
            accessibilityLabel={label}
            style={{ borderWidth:1, borderColor: isError ? P.danger : P.border, borderRadius:12, padding:12,
              fontSize:18, color:P.text, letterSpacing:6, textAlign:'center' }}
          />
          {!!error && (
            <Text style={{ color: isError ? P.danger : P.textMuted, fontSize:12, lineHeight:17 }}>{error}</Text>
          )}
          <TouchableOpacity testID="security-pin-submit" onPress={submit} disabled={busy || !input}
            style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:accent, opacity: busy || !input ? 0.5 : 1 }}>
            {busy
              ? <ActivityIndicator color={P.onAccent} />
              : <Text style={{ color:P.onAccent, fontWeight:'500' }}>
                  {isLast ? t('common.save') : mode === 'removeDuress' ? t('common.remove') : t('pinChange.next')}
                </Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={close} style={{ borderRadius:12, padding:14, alignItems:'center', backgroundColor:P.surfaceAlt }}>
            <Text style={{ color:P.textSub }}>{t('common.cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}
