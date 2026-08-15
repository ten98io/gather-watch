// Expo SDK 53 babel preset; expo-router v5 needs no extra plugin (it is
// bundled into babel-preset-expo since SDK 50).
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
