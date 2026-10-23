// NativeWind v4 needs two things from Babel: the `nativewind` JSX import source
// (so `className` becomes a real prop on RN components) and its own preset.
// The react-native-worklets plugin backs react-native-reanimated 4 and must
// stay last in the plugin list — it rewrites worklet function bodies and
// expects to see the output of every other transform.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: [["babel-preset-expo", { jsxImportSource: "nativewind" }], "nativewind/babel"],
    plugins: ["react-native-worklets/plugin"],
  };
};
