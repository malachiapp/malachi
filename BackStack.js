/**
 * Malachi – BackStack.js
 *
 * Hardware-Zurueck-Taste (Android), Nutzerwunsch 29.10.2026: "manchmal kann
 * man nicht mit der Zurueck-Taste zurueck ... wirkt unfertig".
 *
 * 1. Was gerade offen ist (Auswahlmodus, Suche, Aufnahme-Vorschau, eine
 *    Ansicht innerhalb eines Bildschirms), meldet sich mit useBackHandler()
 *    an. Die Taste schliesst immer das zuletzt Geoeffnete zuerst - erst wenn
 *    niemand mehr etwas offen hat, wechselt AppInner den Bildschirm
 *    (handleBack() vorneweg im Hardware-Handler).
 *    (Modale Fenster bekommen die Taste nicht ueber BackHandler, sondern
 *    ueber ihr eigenes onRequestClose - das muss deshalb jedes Modal setzen.)
 *
 * 2. Android-Dialoge (Alert.alert) liessen sich mit der Zurueck-Taste gar
 *    nicht schliessen (React Native: cancelable ist standardmaessig aus).
 *    installAlertBack() macht jeden Dialog mit einem "Abbrechen"-Knopf
 *    (style 'cancel') per Zurueck-Taste schliessbar - mit derselben Wirkung
 *    wie "Abbrechen". Dialoge ohne Abbrechen-Knopf, deren einziger Knopf etwas
 *    ausloest, bleiben wie bisher (Zurueck darf dort nichts ausloesen und
 *    nichts uebergehen).
 */
import { useEffect, useRef } from 'react';
import { Alert } from 'react-native';

const stack = [];

/** Meldet einen Zurueck-Handler an (zuletzt angemeldet = zuerst gefragt). -> Abmelden */
export function pushBack(handler) {
  const entry = { handler };
  stack.push(entry);
  return () => {
    const i = stack.indexOf(entry);
    if (i >= 0) stack.splice(i, 1);
  };
}

/** Fragt die angemeldeten Handler (neueste zuerst). true = erledigt. */
export function handleBack() {
  for (let i = stack.length - 1; i >= 0; i--) {
    let r;
    try { r = stack[i].handler(); } catch { r = true; }
    if (r !== false) return true;
  }
  return false;
}

/**
 * Solange `enabled`, faengt die Zurueck-Taste `handler` (gibt er false
 * zurueck, kommt der naechste dran). Der Handler darf sich bei jedem Rendern
 * aendern - es zaehlt immer der aktuelle.
 */
export function useBackHandler(enabled, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return undefined;
    return pushBack(() => ref.current?.());
  }, [enabled]);
}

/**
 * Optionen fuer Alert.alert: mit "Abbrechen"-Knopf per Zurueck-Taste
 * schliessbar, Wirkung wie der Knopf. Ausdrueckliche Angaben des Aufrufers
 * (cancelable/onDismiss) gehen vor.
 */
export function alertOptionsWithBack(buttons, options) {
  const opts = options || {};
  if (opts.cancelable !== undefined) return opts;
  const list = Array.isArray(buttons) ? buttons : [];
  const cancel = list.find((b) => b && b.style === 'cancel');
  if (cancel) {
    return {
      ...opts,
      cancelable: true,
      onDismiss: () => { try { opts.onDismiss?.(); } finally { cancel.onPress?.(); } },
    };
  }
  // Reiner Hinweis (kein Knopf oder ein einziger ohne Wirkung): Zurueck = OK.
  if (list.length === 0 || (list.length === 1 && typeof list[0]?.onPress !== 'function')) {
    return { ...opts, cancelable: true };
  }
  return opts;
}

let installed = false;
export function installAlertBack() {
  if (installed || typeof Alert?.alert !== 'function') return;
  installed = true;
  const original = Alert.alert.bind(Alert);
  Alert.alert = (title, message, buttons, options) =>
    original(title, message, buttons, alertOptionsWithBack(buttons, options));
}

export function _resetBackStackForTests() {
  stack.length = 0;
}
