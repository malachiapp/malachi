// Manueller Jest-Mock fuer react-native-webrtc (Testinfrastruktur-Fortsetzung,
// siehe SECURITY_REVIEW_4_ADVERSARIAL_TESTS.md) - das echte Paket braucht ein
// natives WebRTC-Modul, das ausserhalb eines echten Geraets/Emulators nicht
// existiert ("new NativeEventEmitter() requires a non-null argument"). Deckt
// nur die Oberflaeche ab, die beim reinen Mounten von <App /> (kein echter
// Verbindungsaufbau) gebraucht wird - kein funktionales WebRTC-Verhalten.
class RTCPeerConnection {
  constructor() {
    this.onicecandidate = null;
    this.oniceconnectionstatechange = null;
    this.ondatachannel = null;
    this.iceConnectionState = 'new';
  }
  createDataChannel() {
    return { send: () => {}, close: () => {}, addEventListener: () => {} };
  }
  createOffer() { return Promise.resolve({ type: 'offer', sdp: '' }); }
  createAnswer() { return Promise.resolve({ type: 'answer', sdp: '' }); }
  setLocalDescription() { return Promise.resolve(); }
  setRemoteDescription() { return Promise.resolve(); }
  addIceCandidate() { return Promise.resolve(); }
  close() {}
}

class RTCSessionDescription {
  constructor(init) {
    Object.assign(this, init);
  }
}

const mediaDevices = {
  getUserMedia: () => Promise.resolve({ getTracks: () => [] }),
};

module.exports = {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate: class RTCIceCandidate {},
  MediaStream: class MediaStream {},
  MediaStreamTrack: class MediaStreamTrack {},
  mediaDevices,
  registerGlobals: () => {},
};
