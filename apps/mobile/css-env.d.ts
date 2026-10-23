// TypeScript 6 (TS2882) requires a declaration for side-effect .css imports;
// NativeWind consumes the file at bundle time, so the module has no exports.
declare module "*.css";
