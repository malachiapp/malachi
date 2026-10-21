// Manueller Jest-Mock (siehe react-native-webrtc.js fuer die Begruendung).
module.exports = {
  CameraRoll: {
    saveAsset: () => Promise.resolve({ node: { image: { uri: 'mock://asset' } } }),
    save: () => Promise.resolve('mock://asset'),
  },
  useCameraRoll: () => [{ edges: [], page_info: { has_next_page: false } }, () => {}],
};
