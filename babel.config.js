module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Release-Bundle: console.log/info/debug/trace entfernen (warn/error bleiben).
  env: {
    production: {
      plugins: ['./tools/babel-plugin-release-console'],
    },
  },
};
