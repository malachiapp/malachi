// Lautsprecher fuer 1:1- und Gruppenanrufe (CallAudioRoute.js, CallManager.setSpeaker).

describe('CallAudioRoute', () => {
  let RN;
  let route;
  beforeEach(() => {
    jest.resetModules();
    RN = require('react-native');
    delete RN.NativeModules.CallBridgeModule;
    delete RN.NativeModules.MalachiCallAudio;
    route = require('../../CallAudioRoute');
  });

  test('schaltet ueber CallBridgeModule (Telecom/AudioManager)', async () => {
    const setSpeaker = jest.fn(async () => true);
    RN.NativeModules.CallBridgeModule = { setSpeaker, addListener() {}, removeListeners() {} };
    RN.NativeModules.MalachiCallAudio = { setSpeaker: jest.fn() };
    expect(route.isCallSpeakerSupported()).toBe(true);
    await expect(route.setCallSpeaker(1)).resolves.toBe(true);
    expect(setSpeaker).toHaveBeenCalledWith(true);
    expect(RN.NativeModules.MalachiCallAudio.setSpeaker).not.toHaveBeenCalled();
  });

  test('meldet false, wenn nativ nicht umgeschaltet werden konnte', async () => {
    RN.NativeModules.CallBridgeModule = { setSpeaker: jest.fn(async () => false), addListener() {}, removeListeners() {} };
    await expect(route.setCallSpeaker(true)).resolves.toBe(false);
  });

  test('Rueckfall auf MalachiCallAudio bei aelteren Builds', async () => {
    RN.NativeModules.CallBridgeModule = { addListener() {}, removeListeners() {} };
    RN.NativeModules.MalachiCallAudio = { setSpeaker: jest.fn() };
    expect(route.isCallSpeakerSupported()).toBe(true);
    await expect(route.setCallSpeaker(false)).resolves.toBe(true);
    expect(RN.NativeModules.MalachiCallAudio.setSpeaker).toHaveBeenCalledWith(false);
  });

  test('ohne native Module oder bei Fehler: false statt Absturz', async () => {
    expect(route.isCallSpeakerSupported()).toBe(false);
    await expect(route.setCallSpeaker(true)).resolves.toBe(false);
    RN.NativeModules.CallBridgeModule = { setSpeaker: jest.fn(async () => { throw new Error('x'); }), addListener() {}, removeListeners() {} };
    await expect(route.setCallSpeaker(true)).resolves.toBe(false);
  });

  test('meldet den tatsaechlichen Audio-Ausgang (auch Wechsel ueber das System)', () => {
    RN.NativeModules.CallBridgeModule = { setSpeaker: jest.fn(), addListener() {}, removeListeners() {} };
    const seen = [];
    const off = route.onCallAudioRoute((r) => seen.push(r));
    RN.DeviceEventEmitter.emit('nativeCallAudioState', { route: route.AUDIO_ROUTE_SPEAKER });
    RN.DeviceEventEmitter.emit('nativeCallAudioState', { route: 1 });
    off();
    RN.DeviceEventEmitter.emit('nativeCallAudioState', { route: 8 });
    expect(seen).toEqual([8, 1]);
  });
});
