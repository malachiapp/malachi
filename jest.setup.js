// Offizieller Jest-Mock des Pakets selbst (kein natives Modul verfuegbar
// ausserhalb eines echten Geraets/Emulators - ohne das schlaegt jeder Import
// von App.tsx/RelayClient.js unter Jest fehl: "NativeModule.RNCNetInfo is null").
jest.mock('@react-native-community/netinfo', () => require('@react-native-community/netinfo/jest/netinfo-mock'));

// Gleicher Grund wie oben bei netinfo - @react-native-clipboard/clipboard
// (Copy-Button beim Einladungscode, ConnectScreen) ruft TurboModuleRegistry.
// getEnforcing() schon beim Import auf, das schlaegt ausserhalb eines echten
// Geraets/Emulators fehl. Offizieller Jest-Mock des Pakets selbst.
jest.mock('@react-native-clipboard/clipboard', () => require('@react-native-clipboard/clipboard/jest/clipboard-mock'));

// react-native-camera-kit (In-App-QR-Scanner, ConnectScreen) liefert kein
// vorgebautes dist/-JS fuer Jest, sondern rohes TSX mit einer Codegen-
// Native-Component-Spec (fuer Metro gedacht) - Jests Babel-Pipeline schlaegt
// beim Versuch fehl, daraus ein natives View-Config-Schema zu bauen. Kein
// offizieller Jest-Mock vorhanden, daher ein minimaler eigener: die echten
// Tests rendern nie tatsaechlich eine Kamera, sie brauchen nur einen
// importierbaren `Camera`-Namen.
jest.mock('react-native-camera-kit', () => {
  const React = require('react');
  const { View } = require('react-native');
  return { Camera: (props) => React.createElement(View, props) };
});

// Uebersetzungen (i18n.js): Die Tests laufen mit Geraetesprache Deutsch -
// unabhaengig von der Locale der Testmaschine. Deutsch ist die Quellsprache
// (locales/de.js), die in Tests geprueften Texte bleiben dadurch unveraendert.
// Einzelne Tests schalten per setLanguage() auf andere Sprachen um.
jest.mock('react-native/Libraries/ReactNative/NativeI18nManager', () => ({
  __esModule: true,
  default: {
    getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: true, localeIdentifier: 'de_DE' }),
    allowRTL: jest.fn(),
    forceRTL: jest.fn(),
    swapLeftAndRightInRTL: jest.fn(),
  },
}));
