/**
 * Malachi – DesignSection.tsx
 *
 * Einstellungen -> "DESIGN": Themen-Vorschau (kleine Karten mit Kopfleiste,
 * Chatblasen und Akzent), nach Gruppen (Dunkel, Hell, Business, Artwork -
 * THEME_CATEGORIES) je eine waagerecht wischbare Reihe, PRO-Hinweis an den
 * Design-Themen der Vollversion, Akzentfarben und "Kopfleiste und Menü
 * einfärben" fuer das kostenlose Standard-Design (steht in "Dunkel" vorn),
 * "Sperrbildschirm im Design" und "App-Icon passend zum Design" (AppIcon.js).
 * Farben und Regeln: Themes.js.
 *
 * Bewusst eine eigene Datei (App.tsx ist gross): App.tsx reicht nur den
 * Lizenzzustand, ProBadge und die Handler herein.
 *
 * Namen der Themen und Akzentfarben kommen aus der Uebersetzung
 * (locales/*.js: theme.<id>.name, accent.<key>) - die deutschen Namen in
 * Themes.js sind die Quelle und bleiben fuer Tests/Daten unveraendert.
 */
import React from 'react';
import { View, Text, TouchableOpacity, ScrollView, Switch } from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {
  PRO_THEMES, KLASSIK_META, FREE_ACCENTS, DEFAULT_THEME_ID, resolveTheme, getTheme, getThemeSelection, bestOn,
  themesByCategory,
} from './Themes';
import ChatArtwork from './ChatArtwork';
import { isAppIconSupported } from './AppIcon';
// "t" ist hier das aktuelle Thema - die Uebersetzungsfunktion heisst deshalb tr.
import { t as tr } from './i18n';

// Vorschau-Farben der Design-Themen: fest, einmal beim Laden berechnet.
const PRO_PREVIEWS = Object.fromEntries(PRO_THEMES.map(th => [th.id, resolveTheme({ themeId: th.id }, true)]));
// Gruppen im Picker (Dunkel, Hell, Business, Artwork) - ebenfalls fest.
const GROUPS = themesByCategory();

function ThemeCard({ id, name, preview: p, t, selected, locked, onPress, ProBadge }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.8} testID={'design-theme-' + id}
      accessibilityRole="button"
      accessibilityLabel={locked ? tr('design.cardLabelLocked', { name }) : tr('design.cardLabel', { name })}
      accessibilityState={{ selected }}
      style={{ width:96, marginRight:10 }}>
      <View style={{ height:116, borderRadius:14, overflow:'hidden', backgroundColor:p.chatBg,
        borderWidth: selected ? 2 : 1, borderColor: selected ? t.accent : t.borderStrong }}>
        {/* Artwork-Muster (nur Themen mit artwork), unter allem anderen */}
        {p.artwork ? <ChatArtwork kind={p.artwork} fills={p.artworkFills} testID={'design-artwork-' + id} /> : null}
        {/* Kopfleiste */}
        <View style={{ height:24, backgroundColor:p.headerBg, flexDirection:'row', alignItems:'center',
          paddingHorizontal:8, gap:6, borderBottomWidth:0.5, borderBottomColor:p.headerBorder }}>
          <View style={{ width:8, height:8, borderRadius:4, backgroundColor:p.headerIcon }} />
          <View style={{ height:4, width:38, borderRadius:2, backgroundColor:p.headerText }} />
        </View>
        {/* Chatblasen */}
        <View style={{ flex:1, padding:8, gap:6 }}>
          <View style={{ alignSelf:'flex-start', width:52, height:16, borderRadius:8, backgroundColor:p.bubbleTheirs,
            borderWidth:0.5, borderColor:p.bubbleTheirsBorder, justifyContent:'center', paddingHorizontal:6 }}>
            <View style={{ height:3, width:30, borderRadius:1.5, backgroundColor:p.bubbleTheirsText }} />
          </View>
          <View style={{ alignSelf:'flex-end', width:58, height:16, borderRadius:8, backgroundColor:p.bubbleMine,
            justifyContent:'center', paddingHorizontal:6 }}>
            <View style={{ height:3, width:34, borderRadius:1.5, backgroundColor:p.bubbleMineText }} />
          </View>
          <View style={{ alignSelf:'flex-start', width:40, height:16, borderRadius:8, backgroundColor:p.bubbleTheirs,
            borderWidth:0.5, borderColor:p.bubbleTheirsBorder }} />
        </View>
        {/* Akzent (wie der "+"-Knopf) */}
        <View style={{ position:'absolute', right:8, bottom:8, width:20, height:20, borderRadius:10,
          backgroundColor:p.accent, alignItems:'center', justifyContent:'center' }}>
          <Text style={{ fontSize:13, lineHeight:15, color:p.onAccent, fontWeight:'600' }}>+</Text>
        </View>
        {selected && (
          <View style={{ position:'absolute', top:30, right:6, width:20, height:20, borderRadius:10,
            backgroundColor:t.accent, alignItems:'center', justifyContent:'center' }}>
            <Icon name="check" size={13} color={t.onAccent} />
          </View>
        )}
      </View>
      <Text numberOfLines={1} style={{ fontSize:12, fontWeight: selected ? '600' : '500', color:t.text, marginTop:6 }}>{name}</Text>
      {locked
        ? <View style={{ flexDirection:'row', marginLeft:-8, marginTop:3 }}><ProBadge accent={t.accentFg} /></View>
        : <Text style={{ fontSize:10, color:t.textMuted, marginTop:3 }}>{selected ? tr('common.active') : id === DEFAULT_THEME_ID ? tr('design.free') : ' '}</Text>}
    </TouchableOpacity>
  );
}

/**
 * Props:
 *   pro            - Vollversion aktiv (Lizenz gueltig)
 *   onChoose(patch)- { themeId } | { accentKey } | { tintChrome } -> Promise<{ok, reason}>
 *   onOpenPro()    - Vollversion-Seite oeffnen (Pro-Thema ohne Lizenz angetippt)
 *   ProBadge       - Komponente aus App.tsx
 *   theme/selection- fuer Tests; sonst aktueller Stand aus Themes.js
 *   appIconAvailable - Schalter "App-Icon passend zum Design" zeigen
 *                    (Voreinstellung: natives Modul vorhanden, also Android)
 *   children       - weitere Zeilen der Karte (Chat-Hintergrund, Schriftgroesse)
 */
export default function DesignSection({ pro, onChoose, onOpenPro, ProBadge, theme, selection, appIconAvailable, children, hideTitle = false }) {
  const t = theme || getTheme();
  const sel = selection || getThemeSelection();
  const activeId = t.id;               // tatsaechlich angezeigt (ohne Lizenz: Standard)
  const storedPro = sel.themeId !== DEFAULT_THEME_ID && sel.themeId !== activeId;
  const storedName = PRO_THEMES.some(x => x.id === sel.themeId) ? tr('theme.' + sel.themeId + '.name') : null;
  const klassikPreview = resolveTheme({ themeId: DEFAULT_THEME_ID, accentKey: sel.accentKey, tintChrome: sel.tintChrome });
  const accent = FREE_ACCENTS.find(a => a.key === (sel.accentKey || 'cyan')) || FREE_ACCENTS[0];
  const showAppIcon = appIconAvailable === undefined ? isAppIconSupported() : !!appIconAvailable;
  const appIconOn = sel.appIcon === true;

  const pickTheme = (id, locked) => {
    if (locked) { onOpenPro?.(); return; }
    Promise.resolve(onChoose?.({ themeId: id })).then(r => { if (r && r.reason === 'pro') onOpenPro?.(); }).catch(() => {});
  };

  const divider = <View style={{ height:0.5, backgroundColor:t.surfaceAlt, marginHorizontal:16 }} />;

  return (
    <View>
      {!hideTitle && <Text style={{ fontSize:11, color:t.textMuted, letterSpacing:1.5, marginBottom:8 }}>{tr('design.section')}</Text>}
      <View style={{ backgroundColor:t.surface, borderRadius:16, borderWidth:0.5,
        borderColor:t.border, overflow:'hidden', marginBottom:20 }}>
        <View style={{ paddingTop:16, paddingBottom:12 }}>
          <View style={{ flexDirection:'row', alignItems:'center', paddingHorizontal:16, marginBottom:10 }}>
            <Text style={{ flex:1, fontSize:14, fontWeight:'500', color:t.text }}>{tr('design.theme')}</Text>
            {!pro && <Text style={{ fontSize:11, color:t.textMuted }}>{tr('design.proHint', { count: PRO_THEMES.length })}</Text>}
          </View>
          {GROUPS.map((g, gi) => {
            const withKlassik = g.key === KLASSIK_META.category;
            return (
              <View key={g.key} testID={'design-group-' + g.key} style={{ marginTop: gi ? 14 : 0 }}>
                <View style={{ flexDirection:'row', alignItems:'center', paddingHorizontal:16, marginBottom:8 }}>
                  <Text accessibilityRole="header" style={{ fontSize:12, fontWeight:'600', color:t.textSub }}>{tr('theme.category.' + g.key)}</Text>
                  <Text style={{ fontSize:11, color:t.textMuted, marginLeft:6 }}>
                    {g.themes.length + (withKlassik ? 1 : 0)}
                  </Text>
                </View>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal:16 }}>
                  {withKlassik && (
                    <ThemeCard id={DEFAULT_THEME_ID} name={tr('theme.' + DEFAULT_THEME_ID + '.name')} preview={klassikPreview} t={t}
                      selected={activeId === DEFAULT_THEME_ID} locked={false} ProBadge={ProBadge}
                      onPress={() => pickTheme(DEFAULT_THEME_ID, false)} />
                  )}
                  {g.themes.map(th => (
                    <ThemeCard key={th.id} id={th.id} name={tr('theme.' + th.id + '.name')} preview={PRO_PREVIEWS[th.id]} t={t}
                      selected={activeId === th.id} locked={!pro} ProBadge={ProBadge}
                      onPress={() => pickTheme(th.id, !pro)} />
                  ))}
                </ScrollView>
              </View>
            );
          })}
          {storedPro && !!storedName && (
            <Text style={{ fontSize:11, color:t.textMuted, marginTop:10, paddingHorizontal:16, lineHeight:15 }}>
              {tr('design.storedPro', { name: storedName })}
            </Text>
          )}
        </View>

        {activeId === DEFAULT_THEME_ID ? (
          <>
            {divider}
            <View style={{ padding:16 }}>
              <View style={{ flexDirection:'row', alignItems:'center', marginBottom:12 }}>
                <Text style={{ flex:1, fontSize:14, fontWeight:'500', color:t.text }}>{tr('design.accent')}</Text>
                <Text style={{ fontSize:14, color:t.accentFg }}>{tr('accent.' + accent.key)}</Text>
              </View>
              <View style={{ flexDirection:'row', flexWrap:'wrap', gap:12 }}>
                {FREE_ACCENTS.map(a => {
                  const on = a.key === accent.key;
                  return (
                    <TouchableOpacity key={a.key} testID={'design-accent-' + a.key}
                      accessibilityRole="button" accessibilityLabel={tr('design.accentLabel', { name: tr('accent.' + a.key) })}
                      accessibilityState={{ selected: on }}
                      onPress={() => onChoose?.({ accentKey: a.key })}
                      style={{ width:38, height:38, borderRadius:19, alignItems:'center', justifyContent:'center',
                        borderWidth:2, borderColor: on ? t.text : 'transparent' }}>
                      <View style={{ width:30, height:30, borderRadius:15, backgroundColor:a.color,
                        alignItems:'center', justifyContent:'center' }}>
                        {on && <Icon name="check" size={15} color={bestOn(a.color)} />}
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
            {divider}
            <TouchableOpacity activeOpacity={0.8} testID="design-tint"
              onPress={() => onChoose?.({ tintChrome: !sel.tintChrome })}
              style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
              <View style={{ flex:1, marginRight:12 }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:t.text }}>{tr('design.tint')}</Text>
                <Text style={{ fontSize:11, color:t.textMuted, marginTop:2, lineHeight:15 }}>
                  {tr('design.tintSub')}
                </Text>
              </View>
              <Switch value={!!sel.tintChrome} onValueChange={(v) => onChoose?.({ tintChrome: v })}
                trackColor={{ false:t.border, true:t.accent + '88' }} thumbColor={sel.tintChrome ? t.accent : t.textMuted} />
            </TouchableOpacity>
          </>
        ) : (
          <>
            {divider}
            <Text style={{ fontSize:12, color:t.textSub, padding:16, lineHeight:17 }}>
              {tr('design.fixedColors', { name: tr('theme.' + t.id + '.name'), standard: tr('theme.' + DEFAULT_THEME_ID + '.name') })}
            </Text>
          </>
        )}
        {divider}
        <TouchableOpacity activeOpacity={0.8} testID="design-lock"
          onPress={() => onChoose?.({ lockDesign: sel.lockDesign === false })}
          style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
          <View style={{ flex:1, marginRight:12 }}>
            <Text style={{ fontSize:14, fontWeight:'500', color:t.text }}>{tr('designUi.sperrbildschirmImDesign')}</Text>
            <Text style={{ fontSize:11, color:t.textMuted, marginTop:2, lineHeight:15 }}>
              {tr('designUi.ausDerSperrbildschirmSiehtImmer')}
            </Text>
          </View>
          <Switch value={sel.lockDesign !== false} onValueChange={(v) => onChoose?.({ lockDesign: v })}
            trackColor={{ false:t.border, true:t.accent + '88' }} thumbColor={sel.lockDesign !== false ? t.accent : t.textMuted} />
        </TouchableOpacity>
        {showAppIcon && (
          <>
            {divider}
            {/* Launcher-Icon in den Farben des Designs (AppIcon.js); Pro-Designs
                nur mit Vollversion - ohne zeigt die App ohnehin "Standard". */}
            <TouchableOpacity activeOpacity={0.8} testID="design-app-icon"
              onPress={() => onChoose?.({ appIcon: !appIconOn })}
              style={{ flexDirection:'row', alignItems:'center', padding:16 }}>
              <View style={{ flex:1, marginRight:12 }}>
                <Text style={{ fontSize:14, fontWeight:'500', color:t.text }}>{tr('designUi.appIconPassendZumDesign')}</Text>
                <Text style={{ fontSize:11, color:t.textMuted, marginTop:2, lineHeight:15 }}>
                  {tr('designUi.wechseltSobaldDuDieApp')}
                </Text>
                {appIconOn && t.pro && sel.lockDesign === false && (
                  <Text testID="design-app-icon-hint" style={{ fontSize:11, color:t.textMuted, marginTop:4, lineHeight:15 }}>
                    {tr('designUi.dasSymbolIstAuchOhne')}
                  </Text>
                )}
              </View>
              <Switch value={appIconOn} onValueChange={(v) => onChoose?.({ appIcon: v })}
                trackColor={{ false:t.border, true:t.accent + '88' }} thumbColor={appIconOn ? t.accent : t.textMuted} />
            </TouchableOpacity>
          </>
        )}
        {children}
      </View>
    </View>
  );
}
