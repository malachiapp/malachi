/**
 * Malachi – UpdateUI.tsx
 *
 * Oberflaeche der In-App-Updates (nur Web-Version, Logik: AppUpdater.js):
 *  - UpdateSettingsSection: Einstellungen -> "UPDATES" (Stand, "Automatisch
 *    nach Updates suchen", "Jetzt prüfen")
 *  - UpdateBanner: kleiner, ausblendbarer Hinweis auf der Startseite
 *  - UpdateDialog: Versionshinweise, Größe, "Über Tor herunterladen (xx MB)"
 *    mit Fortschritt und Abbrechen, danach "Installieren"
 *
 * Farben ausschliesslich aus den Design-Tokens (palette = P aus App.tsx).
 * In der Play-Version (AppUpdater.isUpdaterAvailable() === false) rendert
 * keine dieser Komponenten etwas.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Switch, Modal, Alert, AppState, ActivityIndicator } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { t, formatTime, formatDate as formatLocalDate } from './i18n';
import {
  isUpdaterAvailable, isUpdaterConfigured, getUpdateState, subscribeUpdate, loadUpdateState, checkForUpdate,
  downloadUpdate, cancelDownload, installUpdate, canInstallPackages, openInstallPermissionSettings,
  setAutoCheck, dismissBanner, updateErrorMessage, formatSize, formatDate, releaseNoteBlocks,
  isMeteredConnection, getInstalledInfo,
} from './AppUpdater';

export function useUpdateState() {
  const [s, setS] = React.useState(getUpdateState());
  React.useEffect(() => {
    const unsub = subscribeUpdate(setS);
    setS(getUpdateState());
    // Play-Version: nicht einmal den gespeicherten Zustand lesen.
    if (isUpdaterAvailable()) loadUpdateState().catch(() => {});
    return unsub;
  }, []);
  return s;
}

/** "heute, 14:05" bzw. "19.10.2026" (ohne Intl). */
export function formatCheckTime(ts, now = Date.now()) {
  if (!ts) return '';
  const d = new Date(ts);
  const n = new Date(now);
  if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) {
    return t('update.checkedToday', { time: formatTime(d) });
  }
  return formatLocalDate(d, { day:'2-digit', month:'2-digit', year:'numeric' });
}

// ── Dialog ────────────────────────────────────────────────────────────────

export function UpdateDialog({ visible, onClose, palette: P, accent }) {
  const s = useUpdateState();
  const [needsPermission, setNeedsPermission] = React.useState(false);
  const u = s.update;
  const dl = s.dl;
  const AC = accent || P.accent;

  // Zurueck aus der Systemeinstellung "Unbekannte Apps installieren": erneut pruefen.
  React.useEffect(() => {
    if (!visible || !needsPermission) return undefined;
    const sub = AppState.addEventListener('change', (st) => {
      if (st === 'active') canInstallPackages().then((ok) => { if (ok) setNeedsPermission(false); }).catch(() => {});
    });
    return () => sub?.remove?.();
  }, [visible, needsPermission]);

  if (!isUpdaterAvailable() || !u) return null;
  const size = formatSize(u.apk.size);
  const pct = dl.total > 0 ? Math.min(100, Math.floor((dl.received / dl.total) * 100)) : 0;

  const startDownload = async () => {
    if (await isMeteredConnection()) {
      Alert.alert(t('update.mobileDaten'), t('update.duBistGeradeUeberEin', { size }), [
        { text: t('settings.language.later'), style: 'cancel' },
        { text: t('update.herunterladen'), onPress: () => { downloadUpdate(); } },
      ]);
      return;
    }
    downloadUpdate();
  };
  const install = async () => {
    const r = await installUpdate();
    if (r.needsPermission) setNeedsPermission(true);
  };

  const btn = (label, onPress, { primary = true, disabled = false, testID = undefined } = {}) => (
    <TouchableOpacity onPress={onPress} disabled={disabled} activeOpacity={0.85} testID={testID}
      accessibilityRole="button" accessibilityState={{ disabled }}
      style={{ borderRadius:12, padding:14, alignItems:'center',
        backgroundColor: disabled ? P.border : primary ? AC : P.surfaceAlt }}>
      <Text style={{ color: disabled ? P.textMuted : primary ? P.onAccent : P.textSub, fontWeight:'600', fontSize:14 }}>{label}</Text>
    </TouchableOpacity>
  );

  const blocks = releaseNoteBlocks(u.releaseNotes);
  return (
    <Modal visible={!!visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex:1, backgroundColor:P.overlay, alignItems:'center', justifyContent:'center', padding:20 }}>
        <View style={{ width:'100%', maxHeight:'92%', backgroundColor:P.surface, borderRadius:20, padding:20, gap:10 }}>
          <View style={{ flexDirection:'row', alignItems:'center', gap:10 }}>
            <Icon name="download" size={20} color={P.accentFg} />
            <Text style={{ flex:1, fontSize:17, fontWeight:'600', color:P.text }}>{`Malachi ${u.versionName}`}</Text>
          </View>
          <Text style={{ fontSize:12, color:P.textMuted }}>
            {t('update.veroeffentlichtAm', { value: formatDate(u.published), size })}
          </Text>
          {u.important && (
            <View style={{ borderWidth:1, borderColor:P.warning, borderRadius:12, padding:12 }}>
              <Text style={{ fontSize:13, fontWeight:'600', color:P.warning }}>{t('update.diesesUpdateIstWichtig')}</Text>
              <Text style={{ fontSize:12, color:P.textSub, marginTop:4, lineHeight:17 }}>
                {t('update.deineVersionWirdNichtMehr')}
              </Text>
            </View>
          )}
          <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginTop:4 }}>{t('update.wasIstNeu')}</Text>
          <ScrollView style={{ maxHeight:240 }} contentContainerStyle={{ paddingBottom:4 }}>
            {blocks.map((b, i) => b.kind === 'gap'
              ? <View key={i} style={{ height:8 }} />
              : b.kind === 'bullet'
                ? (
                  <View key={i} style={{ flexDirection:'row', marginTop:2 }}>
                    <Text style={{ fontSize:13, color:P.textSub, width:14 }}>•</Text>
                    <Text style={{ flex:1, fontSize:13, color:P.text, lineHeight:19 }}>{b.text}</Text>
                  </View>
                )
                : <Text key={i} style={{ fontSize:13, color:P.text, lineHeight:19, marginTop:2 }}>{b.text}</Text>)}
          </ScrollView>
          <Text style={{ fontSize:11, color:P.textMuted, lineHeight:16 }}>
            {t('update.ladenUndPruefenLaufenUeber')}
          </Text>

          {dl.status === 'running' && (
            <View style={{ gap:8 }} testID="update-progress">
              <View style={{ height:6, borderRadius:3, backgroundColor:P.surfaceAlt, overflow:'hidden' }}>
                <View style={{ width:`${pct}%`, height:6, backgroundColor:AC }} />
              </View>
              <Text style={{ fontSize:12, color:P.textSub }}>
                {t('update.vonUeberTorKannDas', { pct, value: formatSize(dl.received), size })}
              </Text>
              {btn(t('common.cancel'), () => { cancelDownload(); }, { primary:false, testID:'update-cancel' })}
            </View>
          )}

          {(dl.status === 'idle' || dl.status === 'error') && (
            <View style={{ gap:8 }}>
              {dl.status === 'error' && !!dl.error && (
                <Text style={{ fontSize:12, color:P.danger, lineHeight:17 }}>{updateErrorMessage(dl.error)}</Text>
              )}
              {btn(t('update.ueberTorHerunterladen', { size }), startDownload, { testID:'update-download' })}
            </View>
          )}

          {dl.status === 'ready' && (
            <View style={{ gap:8 }}>
              {needsPermission ? (
                <View style={{ gap:8 }}>
                  <View style={{ backgroundColor:P.surfaceAlt, borderRadius:12, padding:12 }}>
                    <Text style={{ fontSize:13, fontWeight:'600', color:P.text }}>{t('update.einmaligErlauben')}</Text>
                    <Text style={{ fontSize:12, color:P.textSub, marginTop:4, lineHeight:17 }}>
                      {t('update.damitMalachiDasUpdateAn')}
                    </Text>
                  </View>
                  {btn(t('update.einstellungOeffnen'), () => { openInstallPermissionSettings(); }, { testID:'update-permission' })}
                  {btn('Installieren', install, { primary:false })}
                </View>
              ) : (
                <>
                  <Text style={{ fontSize:12, color:P.success }}>{t('update.geladenUndGeprueftSignaturUnd')}</Text>
                  {dl.installStarted && (
                    <Text style={{ fontSize:12, color:P.textSub, lineHeight:17 }}>{t('update.derAndroidInstallerWurdeGeoeffnet')}</Text>
                  )}
                  {!!dl.error && <Text style={{ fontSize:12, color:P.danger }}>{updateErrorMessage(dl.error)}</Text>}
                  {btn('Installieren', install, { testID:'update-install' })}
                </>
              )}
            </View>
          )}

          <TouchableOpacity onPress={onClose} style={{ padding:10, alignItems:'center' }} accessibilityRole="button">
            <Text style={{ color:P.textSub, fontSize:14 }}>{dl.status === 'running' ? t('update.imHintergrundWeiterladen') : t('settings.language.later')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

// ── Startseite ────────────────────────────────────────────────────────────

export function UpdateBanner({ palette: P, accent }) {
  const s = useUpdateState();
  const [open, setOpen] = React.useState(false);
  if (!isUpdaterAvailable() || !s.update) return null;
  const u = s.update;
  return (
    <>
      {!s.bannerDismissed && (
        <View testID="update-banner" style={{ flexDirection:'row', alignItems:'center', marginHorizontal:12, marginTop:10,
          paddingLeft:14, paddingRight:4, paddingVertical:8, borderRadius:14, backgroundColor:P.surface,
          borderWidth: u.important ? 1 : 0.5, borderColor: u.important ? P.warning : P.border }}>
          <Icon name={u.important ? 'alert-triangle' : 'download'} size={18} color={u.important ? P.warning : P.accentFg} />
          <TouchableOpacity onPress={() => setOpen(true)} activeOpacity={0.7} accessibilityRole="button" testID="update-banner-open"
            accessibilityLabel={t('update.malachiIstDaWasIst', { versionName: u.versionName })} style={{ flex:1, marginLeft:10, paddingVertical:4 }}>
            <Text style={{ fontSize:13, color:P.text }} numberOfLines={1}>
              <Text style={{ fontWeight:'600' }}>{t('update.malachiIstDa', { versionName: u.versionName })}</Text>
              <Text style={{ color:P.accentFg }}> {t('update.wasIstNeu2')}</Text>
            </Text>
            {u.important && <Text style={{ fontSize:12, color:P.warning, marginTop:1 }}>{t('update.diesesUpdateIstWichtig')}</Text>}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { dismissBanner(); }} hitSlop={{ top:8, bottom:8, left:8, right:8 }}
            accessibilityRole="button" accessibilityLabel={t('update.hinweisAusblenden')} style={{ padding:8 }} testID="update-banner-close">
            <Icon name="x" size={16} color={P.textMuted} />
          </TouchableOpacity>
        </View>
      )}
      <UpdateDialog visible={open} onClose={() => setOpen(false)} palette={P} accent={accent} />
    </>
  );
}

// ── Einstellungen ─────────────────────────────────────────────────────────

export function UpdateSettingsSection({ palette: P, accent, hideTitle = false }) {
  const s = useUpdateState();
  const [open, setOpen] = React.useState(false);
  if (!isUpdaterAvailable()) return null;
  const AC = accent || P.accent;
  const configured = isUpdaterConfigured();
  const installed = getInstalledInfo();
  const u = s.update;

  let value;
  let valueColor = P.textMuted;
  if (!configured) value = t('update.updatesWerdenEingerichtet');
  else if (s.checking) value = t('update.wirdGeprueft');
  else if (u) { value = t('update.malachiIstDa', { versionName: u.versionName }); valueColor = u.important ? P.warning : P.accentFg; }
  else if (s.upToDate) { value = 'Aktuell'; valueColor = P.success; }
  else value = '';

  const sub = [
    installed && installed.versionName ? `Installiert: ${installed.versionName}` : null,
    configured && s.lastCheckAt ? t('update.zuletztGeprueft', { value: formatCheckTime(s.lastCheckAt) }) : null,
  ].filter(Boolean).join(' · ');
  const divider = <View style={{ height:0.5, backgroundColor:P.surfaceAlt, marginHorizontal:16 }} />;

  return (
    <>
      {!hideTitle && <Text style={{ fontSize:11, color:P.textMuted, letterSpacing:1.5, marginBottom:8 }}>{t('update.updates')}</Text>}
      <View testID="update-settings" style={{ backgroundColor:P.surface, borderRadius:16, borderWidth:0.5,
        borderColor:P.border, overflow:'hidden', marginBottom:20 }}>
        <TouchableOpacity activeOpacity={u ? 0.7 : 1} disabled={!u} onPress={() => setOpen(true)}
          style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
          <View style={{ flex:1, marginRight:12 }}>
            <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('update.appUpdates')}</Text>
            {!!sub && <Text style={{ fontSize:11, color:P.textMuted, marginTop:2 }}>{sub}</Text>}
            {!configured && (
              <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
                {t('update.neueVersionenGibtEsBis')}
              </Text>
            )}
            {configured && !!s.checkError && !s.checking && (
              <Text style={{ fontSize:11, color:P.warning, marginTop:4, lineHeight:15 }}>{updateErrorMessage(s.checkError)}</Text>
            )}
          </View>
          {s.checking
            ? <ActivityIndicator size="small" color={AC} />
            : <Text style={{ fontSize:13, color:valueColor, maxWidth:170, textAlign:'right' }}>{value}{u ? '  ›' : ''}</Text>}
        </TouchableOpacity>
        {configured && (
          <>
            {divider}
            <View style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
              <View style={{ flex:1, marginRight:12 }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:P.text }}>{t('update.automatischNachUpdatesSuchen')}</Text>
                <Text style={{ fontSize:11, color:P.textMuted, marginTop:2, lineHeight:15 }}>
                  {t('update.ueberTorHoechstensEinmalAm')}
                </Text>
              </View>
              <Switch value={!!s.autoCheck} onValueChange={(v) => { setAutoCheck(v); }} testID="update-auto"
                trackColor={{ false:P.border, true:AC + '88' }} thumbColor={s.autoCheck ? AC : P.textMuted} />
            </View>
            {divider}
            <TouchableOpacity activeOpacity={0.7} disabled={s.checking} onPress={() => { checkForUpdate({ auto: false }); }}
              testID="update-check-now" style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
              <Icon name="refresh-cw" size={16} color={s.checking ? P.textMuted : P.accentFg} />
              <Text style={{ flex:1, marginLeft:10, fontSize:14, fontWeight:'500', color: s.checking ? P.textMuted : P.accentFg }}>{t('update.jetztPruefen')}</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
      <UpdateDialog visible={open} onClose={() => setOpen(false)} palette={P} accent={accent} />
    </>
  );
}
