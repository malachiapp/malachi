// Vollversion-Seite der Google-Play-Variante (Flavor "play", Distribution.js,
// PLAY_STORE.md). Gegenstueck zur Shop-Seite der Website-Variante
// (ShopProScreen in App.tsx), die hier NIE erscheint.
//
// Google-Play-Zahlungsrichtlinie: In dieser Variante gibt es nur den Kauf
// ueber Google Play Billing - keine anderen Zahlungswege, keine Verweise auf
// den Shop oder die Website, keinen Geraetecode, keine Lizenztexte und keinen
// Lizenz-Umzug. Der Preis kommt von Google Play (Waehrung des Nutzers).
//
// Geprueft und freigeschaltet wird in LicenseManager.js (Signatur der
// Kaufdaten auf dem Geraet, ohne Server); diese Seite zeigt nur an und stoesst
// Kauf bzw. Wiederherstellen an.

import React from 'react';
import { Modal, View, Text, TouchableOpacity, ScrollView } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import { t } from './i18n';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getTheme, subscribeTheme } from './Themes';
import {
  getLicenseState, subscribeLicense, startPlayPurchase, restorePlayPurchases, loadPlayProduct,
  licenseErrorMessage, clearPlayMessages,
} from './LicenseManager';

type Feature = { icon: string; title: string; desc: string };
type Props = { visible: boolean; onClose: () => void; accent?: string; features?: Feature[] };

// Gruende, die als Hinweis am Status erscheinen (ausstehende Zahlung hat eine eigene Karte).
const STATUS_REASONS = ['play-widerrufen', 'play-signatur', 'play-paket', 'play-status', 'play-format'];

export default function PlayProScreen({ visible, onClose, accent, features = [] }: Props) {
  const [P, setP] = React.useState<any>(getTheme());
  React.useEffect(() => subscribeTheme(setP), []);
  const insets = useSafeAreaInsets();
  const [lic, setLic] = React.useState<any>(getLicenseState());
  React.useEffect(() => subscribeLicense(setLic), []);
  const [busy, setBusy] = React.useState<null | 'kauf' | 'wiederherstellen'>(null);
  const [error, setError] = React.useState('');
  const AC2 = accent || P.accent;

  // Preis von Google Play holen, sobald die Seite offen ist (nur ohne Vollversion).
  React.useEffect(() => {
    if (!visible || lic.pro || !lic.purchaseAvailable || lic.playProduct) return;
    loadPlayProduct().catch(() => {});
  }, [visible, lic.pro, lic.purchaseAvailable, lic.playProduct]);

  // Beim Schliessen alte Meldungen verwerfen.
  React.useEffect(() => {
    if (visible) return;
    setError('');
    clearPlayMessages();
  }, [visible]);

  const run = async (kind: 'kauf' | 'wiederherstellen', fn: () => Promise<any>) => {
    if (busy) return;
    setBusy(kind);
    setError('');
    try { await fn(); }
    catch (e: any) { setError(e?.message || 'Unbekannter Fehler - bitte erneut versuchen.'); }
    finally { setBusy(null); }
  };
  const buy = () => run('kauf', async () => { await startPlayPurchase(); });
  const restore = () => run('wiederherstellen', async () => { await restorePlayPurchases(); });

  const price: string | null = lic.playProduct && typeof lic.playProduct.price === 'string' ? lic.playProduct.price : null;
  const loadingPrice = !price && !lic.playProductError && lic.purchaseAvailable && !lic.pro;
  const shownError = error || lic.playError || '';
  const notice = !shownError && lic.playNotice ? lic.playNotice : '';
  const statusHint = lic.loaded && !lic.pro && STATUS_REASONS.includes(lic.reason) ? licenseErrorMessage(lic.reason) : '';
  const boughtOn = lic.pro && lic.playInfo && Number.isFinite(lic.playInfo.purchaseTime)
    ? new Date(lic.playInfo.purchaseTime).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
    : null;

  const card = { backgroundColor: P.surface, borderRadius: 16, borderWidth: 0.5, borderColor: P.border, padding: 16, marginBottom: 16 };
  const sectionTitle = { fontSize: 11, color: P.textMuted, letterSpacing: 1.5, marginBottom: 8 };
  const button = (enabled: boolean) => ({ borderRadius: 12, padding: 14, alignItems: 'center' as const, backgroundColor: enabled ? AC2 : P.border, marginTop: 12 });
  const ghost = { borderRadius: 12, padding: 12, alignItems: 'center' as const, borderWidth: 1, borderColor: P.border, marginTop: 10 };
  const msgs = (shownError || notice) ? (
    <View style={{ marginTop: 10 }}>
      {!!shownError && <Text style={{ fontSize: 12, color: P.danger, lineHeight: 17 }}>{shownError}</Text>}
      {!!notice && <Text style={{ fontSize: 12, color: P.success, lineHeight: 17 }}>{notice}</Text>}
    </View>
  ) : null;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: P.bg, paddingTop: insets.top, paddingBottom: insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12,
          backgroundColor: P.headerBg, borderBottomWidth: 0.5, borderBottomColor: P.headerBorder }}>
          <TouchableOpacity onPress={onClose} style={{ marginRight: 8, padding: 4 }}>
            <Text style={{ fontSize: 22, color: P.headerIcon }}>←</Text>
          </TouchableOpacity>
          <Text style={{ fontSize: 20, fontWeight: '600', color: P.headerText }}>{t('common.fullVersion')}</Text>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, paddingBottom: 48 }}>
          {/* STATUS */}
          <View style={[card, lic.pro && { borderColor: P.success, borderWidth: 1 }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Icon name={lic.pro ? 'check-circle' : 'shield'} size={22} color={lic.pro ? P.success : AC2} />
              <Text style={{ fontSize: 17, fontWeight: '600', color: P.text, marginLeft: 10 }}>
                {lic.pro ? t('pro.active') : t('pro.free')}
              </Text>
            </View>
            {lic.pro && (
              <Text style={{ fontSize: 12, color: P.textSub, marginTop: 6 }}>
                {boughtOn ? t('playPro.ueberGooglePlayGekauftAm', { boughtOn }) : t('playPro.ueberGooglePlayGekauft')}
              </Text>
            )}
            {!!statusHint && (
              <Text style={{ fontSize: 12, color: P.warning, marginTop: 8, lineHeight: 17 }}>{statusHint}</Text>
            )}
            <Text style={{ fontSize: 13, color: P.textSub, marginTop: 10, lineHeight: 19 }}>
              {t('pro.freeIntro')}
            </Text>
          </View>

          {/* WAS PRO ENTHAELT */}
          <Text style={sectionTitle}>{t('pro.extraSection')}</Text>
          <View style={card}>
            {features.map((f, i) => (
              <View key={f.title} style={{ flexDirection: 'row', marginTop: i ? 14 : 0 }}>
                <Icon name={f.icon} size={18} color={AC2} style={{ marginTop: 1 }} />
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={{ fontSize: 14, fontWeight: '500', color: P.text }}>{f.title}</Text>
                  <Text style={{ fontSize: 12, color: P.textMuted, marginTop: 2, lineHeight: 17 }}>{f.desc}</Text>
                </View>
              </View>
            ))}
            <Text style={{ fontSize: 12, color: P.textSub, marginTop: features.length ? 14 : 0, lineHeight: 18 }}>
              {t('playPro.priceLine', { price: price ? t('playPro.einmalig', { price }) : t('playPro.einmalkauf') })}
            </Text>
          </View>

          {/* KAUF */}
          {!lic.pro && (
            <>
              <Text style={sectionTitle}>{t('pro.buySection')}</Text>
              <View style={card}>
                {!lic.purchaseAvailable ? (
                  <>
                    <Text style={{ fontSize: 15, fontWeight: '600', color: P.warning }}>{t('pro.notAvailable')}</Text>
                    <Text style={{ fontSize: 12, color: P.textMuted, marginTop: 6, lineHeight: 17 }}>
                      {t('playPro.alleGratisFunktionenLaufenOhne')}
                    </Text>
                  </>
                ) : lic.playPending ? (
                  <>
                    <Text style={{ fontSize: 14, fontWeight: '500', color: P.text, lineHeight: 20 }}>{licenseErrorMessage('play-ausstehend')}</Text>
                    <TouchableOpacity disabled={!!busy} onPress={restore} style={ghost}>
                      <Text style={{ color: P.textSub, fontSize: 13 }}>
                        {busy === 'wiederherstellen' ? t('playPro.frageGooglePlay') : t('pro.checkNow')}
                      </Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    {lic.playRestorable && (
                      <Text style={{ fontSize: 12, color: P.textSub, marginBottom: 4, lineHeight: 17 }}>
                        {t('playPro.mitDiesemGoogleKontoWurde')}
                      </Text>
                    )}
                    <TouchableOpacity disabled={!!busy || loadingPrice} onPress={buy} style={button(!busy && !loadingPrice)}
                      accessibilityRole="button">
                      <Text style={{ color: P.onAccent, fontWeight: '600', fontSize: 15 }}>
                        {busy === 'kauf' ? t('playPro.oeffneGooglePlay') : (price ? t('playPro.vollversionKaufen', { price }) : t('playPro.vollversionKaufen2'))}
                      </Text>
                    </TouchableOpacity>
                    {loadingPrice && (
                      <Text style={{ fontSize: 11, color: P.textMuted, marginTop: 8, textAlign: 'center' }}>{t('playPro.preisWirdVonGooglePlay')}</Text>
                    )}
                    {!!lic.playProductError && !price && (
                      <Text style={{ fontSize: 12, color: P.warning, marginTop: 8, lineHeight: 17 }}>{lic.playProductError}</Text>
                    )}
                  </>
                )}
                {msgs}
              </View>
            </>
          )}
          {lic.pro && msgs && <View style={card}>{msgs}</View>}

          {/* WIEDERHERSTELLEN */}
          {!lic.pro && lic.purchaseAvailable && (
            <TouchableOpacity disabled={!!busy} onPress={restore} style={[ghost, { marginTop: 0, marginBottom: 16 }]}
              accessibilityRole="button">
              <Text style={{ color: P.text, fontSize: 14 }}>
                {busy === 'wiederherstellen' ? t('playPro.frageGooglePlay') : t('playPro.kaeufeWiederherstellen')}
              </Text>
            </TouchableOpacity>
          )}

          <Text style={{ fontSize: 11, color: P.textMuted, lineHeight: 16 }}>
            {t('playPro.derKaufGehoertZuDeinem')}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}
