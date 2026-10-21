// Performance-Audit (Speicherleck, nicht Sicherheit): RTCStore.js/
// ImageCrypto.js/AudioCrypto.js puffern eingehende Bild-/Audio-Chunks in
// einer Map, bis der Abschluss-Marker (img_end/audio_end) ankommt. Bricht
// die Gegenseite mitten im Senden ab (Verbindungsabbruch, Chat wird
// geschlossen, App im Hintergrund eingefroren), blieb der teilbefuellte
// Eintrag bisher fuer die gesamte Lebensdauer des Prozesses liegen - alle
// drei Maps sind Modul-/Singleton-State, der viele Chat-Oeffnungen und
// Reconnect-Zyklen ueberdauert. Jeder weitere abgebrochene Versuch (z.B.
// wiederholte Sendeversuche auf einer instabilen Verbindung) legte unter
// einer neuen imageId/audioId einen ZUSAETZLICHEN Eintrag an, ohne dass
// alte je entfernt wurden. AudioCrypto.js's audioBuffers hatte denselben
// Modul-State-Speicherleck-Fund wie ImageCrypto.js's imageBuffers, wurde
// von der ersten Fix-Runde uebersehen und hier nachgezogen.
//
// Fix (siehe RTCStore.js/ImageCrypto.js/AudioCrypto.js): vor jedem neu
// angelegten Puffer-Eintrag werden Eintraege DESSELBEN Puffers geraeumt,
// die aelter als STALE_TRANSFER_MS (10 Minuten) sind. Dieser Test beweist
// ueber den echten Produktionscode (kein Mock der Sweep-Logik selbst), dass
// wiederholte abgebrochene Transfers dadurch NICHT mehr unbegrenzt
// akkumulieren.

describe('Performance-Audit: verwaiste Chunk-Puffer wachsen nicht mehr unbegrenzt', () => {
  const STALE_TRANSFER_MS = 10 * 60 * 1000;

  beforeEach(() => {
    jest.resetModules();
  });

  test('RTCStore.js (Live-Empfang ohne offenen ChatScreen): 50 abgebrochene Audio-Transfers hinterlassen nur die noch nicht abgelaufenen Eintraege, nicht 50', () => {
    const RTCStore = require('../../RTCStore').default;
    const chatId = 'contactA';
    const fakeRtc = { chatId, onConnected: null, onSharedSecretSet: null };
    RTCStore.setConnection(chatId, fakeRtc); // kein setMessageListener() -> Puffer-Zweig

    // 50 fruehere, abgebrochene Versuche: nur Chunk 0 von 5 kommt an, dann
    // bricht die Verbindung ab (kein audio_end) - jeder mit einer eigenen
    // audioId, wie es bei 50 echten, unabhaengigen Sendeversuchen der Fall
    // waere. Erst ALLE 50 anlegen (jede fuer sich noch "frisch", loest also
    // noch keinen Sweep gegen die anderen aus), DANACH gemeinsam
    // rueckdatieren - sonst wuerde das ohnehin schon laufende Sweep-vor-jeder-
    // Neuanlage bereits waehrend dieser Schleife greifen und den eigentlichen
    // Vorher/Nachher-Vergleich verdecken (vermeidet Timer-Mocking, prueft
    // direkt die Sweep-Bedingung).
    for (let i = 0; i < 50; i++) {
      fakeRtc.onMessage({ type: 'audio_chunk', audioId: 'stale' + i, index: 0, total: 5, data: 'AAAA' });
    }
    expect(RTCStore.audioBuffer.size).toBe(50); // vor dem Rueckdatieren/Sweep noch alle da
    for (let i = 0; i < 50; i++) {
      const key = chatId + '_stale' + i;
      RTCStore.audioBuffer.get(key).createdAt = Date.now() - STALE_TRANSFER_MS - 1000;
    }

    // Ein 51., NEUER Transfer beginnt - das ist der Moment, an dem
    // sweepStaleBuffers() in RTCStore.js laeuft (huckepack, kein eigener Timer).
    fakeRtc.onMessage({ type: 'audio_chunk', audioId: 'fresh', index: 0, total: 5, data: 'AAAA' });

    // Ohne den Fix waere audioBuffer.size jetzt 51 (unbegrenztes Wachstum).
    // Mit dem Fix: nur der frische Eintrag bleibt uebrig.
    expect(RTCStore.audioBuffer.size).toBe(1);
    expect(RTCStore.audioBuffer.has(chatId + '_fresh')).toBe(true);
  });

  test('RTCStore.js: ein Eintrag INNERHALB des Gnadenfensters wird beim Sweep nicht faelschlich mitgeloescht (kein Datenverlust fuer einen tatsaechlich noch laufenden Transfer)', () => {
    const RTCStore = require('../../RTCStore').default;
    const chatId = 'contactB';
    const fakeRtc = { chatId, onConnected: null, onSharedSecretSet: null };
    RTCStore.setConnection(chatId, fakeRtc);

    fakeRtc.onMessage({ type: 'img_chunk', imageId: 'inflight', index: 0, total: 3, data: 'AAAA', mimeType: 'image/jpeg' });
    // Knapp innerhalb des Gnadenfensters (1s vor Ablauf) - ein noch aktiver,
    // langsamer, aber nicht abgebrochener Transfer.
    RTCStore.imgBuffer.get(chatId + '_inflight').createdAt = Date.now() - STALE_TRANSFER_MS + 1000;

    fakeRtc.onMessage({ type: 'img_chunk', imageId: 'other', index: 0, total: 3, data: 'AAAA', mimeType: 'image/jpeg' });

    expect(RTCStore.imgBuffer.has(chatId + '_inflight')).toBe(true);
    // Restliche Chunks kommen normal an und schliessen den Transfer ab.
    fakeRtc.onMessage({ type: 'img_chunk', imageId: 'inflight', index: 1, total: 3, data: 'AAAA', mimeType: 'image/jpeg' });
    fakeRtc.onMessage({ type: 'img_chunk', imageId: 'inflight', index: 2, total: 3, data: 'AAAA', mimeType: 'image/jpeg' });
    fakeRtc.onMessage({ type: 'img_end', imageId: 'inflight' });
    expect(RTCStore.imgBuffer.has(chatId + '_inflight')).toBe(false); // normal abgeschlossen, nicht durch den Sweep verloren
  });

  test('ImageCrypto.js (Live-Empfang bei offenem ChatScreen): abgebrochene Bild-Transfers werden nach Ablauf des Gnadenfensters aus dem privaten Modul-Puffer entfernt', () => {
    // imageBuffers ist bewusst modul-privat (kein exportierter State) - das
    // Sweep-Verhalten wird deshalb ueber Date.now() gesteuert und indirekt
    // ueber das oeffentliche Verhalten bewiesen: wird ein alter, unvollstaendiger
    // Eintrag tatsaechlich entfernt, fehlt bei einem spaeteren Abschlussversuch
    // (nur die Chunks 1-3, OHNE Chunk 0 erneut zu senden) zwangslaeufig Chunk 0
    // - der Transfer kann dann nicht mehr vollstaendig werden. Bliebe der alte
    // Eintrag (mit bereits gefuelltem Chunk 0) hingegen liegen, wuerde
    // derselbe Abschlussversuch erfolgreich das komplette Bild liefern.
    let currentTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const { processImageChunk } = require('../../ImageCrypto');

      // 30 unabhaengige, abgebrochene Transfers - jeweils nur Chunk 0 kommt an.
      for (let i = 0; i < 30; i++) {
        processImageChunk({ type: 'img_chunk', imageId: 'stale' + i, index: 0, total: 4, data: 'AAAA', mimeType: 'image/jpeg' });
      }

      // Uhr ueber das Gnadenfenster hinaus vorstellen.
      currentTime += STALE_TRANSFER_MS + 1000;

      // Ein einziger NEUER Transfer beginnt - das loest sweepStaleImageBuffers() aus.
      processImageChunk({ type: 'img_chunk', imageId: 'fresh', index: 0, total: 4, data: 'AAAA', mimeType: 'image/jpeg' });

      // Jetzt versuchen, einen der 30 alten Transfers OHNE erneuten Chunk 0
      // abzuschliessen - muss fehlschlagen (unvollstaendig), wenn der Sweep
      // den alten Eintrag wirklich entfernt hat.
      processImageChunk({ type: 'img_chunk', imageId: 'stale0', index: 1, total: 4, data: 'AAAA', mimeType: 'image/jpeg' });
      processImageChunk({ type: 'img_chunk', imageId: 'stale0', index: 2, total: 4, data: 'AAAA', mimeType: 'image/jpeg' });
      processImageChunk({ type: 'img_chunk', imageId: 'stale0', index: 3, total: 4, data: 'AAAA', mimeType: 'image/jpeg' });
      const result = processImageChunk({ type: 'img_end', imageId: 'stale0', mimeType: 'image/jpeg' });

      // Ohne den Fix waere der alte Puffer (mit Chunk 0 aus der ersten Runde)
      // noch da und dieser Abschluss wuerde erfolgreich ein Bild liefern -
      // genau das darf nicht mehr passieren, weil der Eintrag laengst als
      // verwaist haette geraeumt werden muessen.
      expect(result).toBeNull();

      // Der frische Transfer, der den Sweep ausgeloest hat, funktioniert
      // weiterhin ganz normal (kein falsch-positiver Kollateralschaden).
      const freshDone = [1, 2, 3].every((idx) =>
        processImageChunk({ type: 'img_chunk', imageId: 'fresh', index: idx, total: 4, data: 'AAAA', mimeType: 'image/jpeg' }) === null
      );
      expect(freshDone).toBe(true);
      expect(processImageChunk({ type: 'img_end', imageId: 'fresh', mimeType: 'image/jpeg' })).toEqual(
        expect.objectContaining({ imageId: 'fresh' })
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('AudioCrypto.js (Live-Empfang bei offenem ChatScreen): abgebrochene Audio-Transfers werden nach Ablauf des Gnadenfensters aus dem privaten Modul-Puffer entfernt', () => {
    // Identischer Nachweis wie beim ImageCrypto.js-Test oben (audioBuffers ist
    // ebenso modul-privat) - siehe dortigen Kommentar fuer die Begruendung der
    // indirekten Beweisfuehrung ueber einen absichtlich unvollstaendigen
    // Abschlussversuch.
    let currentTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    try {
      const { processAudioChunk } = require('../../AudioCrypto');

      for (let i = 0; i < 30; i++) {
        processAudioChunk({ type: 'audio_chunk', audioId: 'stale' + i, index: 0, total: 4, data: 'AAAA' });
      }

      currentTime += STALE_TRANSFER_MS + 1000;

      processAudioChunk({ type: 'audio_chunk', audioId: 'fresh', index: 0, total: 4, data: 'AAAA' });

      processAudioChunk({ type: 'audio_chunk', audioId: 'stale0', index: 1, total: 4, data: 'AAAA' });
      processAudioChunk({ type: 'audio_chunk', audioId: 'stale0', index: 2, total: 4, data: 'AAAA' });
      processAudioChunk({ type: 'audio_chunk', audioId: 'stale0', index: 3, total: 4, data: 'AAAA' });
      const result = processAudioChunk({ type: 'audio_end', audioId: 'stale0' });

      // Ohne den Fix waere der alte Puffer (mit Chunk 0 aus der ersten Runde)
      // noch da und dieser Abschluss wuerde erfolgreich ein Audio liefern.
      expect(result).toBeNull();

      const freshDone = [1, 2, 3].every((idx) =>
        processAudioChunk({ type: 'audio_chunk', audioId: 'fresh', index: idx, total: 4, data: 'AAAA' }) === null
      );
      expect(freshDone).toBe(true);
      expect(processAudioChunk({ type: 'audio_end', audioId: 'fresh' })).toEqual(
        expect.objectContaining({ audioId: 'fresh' })
      );
    } finally {
      nowSpy.mockRestore();
    }
  });
});
