// The two libmime functions the relay uses (the package ships no types).
// It's CommonJS and its functions call each other through `this`, so use the
// default export as an object, never destructured imports.
declare module "libmime" {
  const libmime: {
    encodeWord(data: string, mimeWordEncoding?: "Q" | "B", maxLength?: number): string;
    decodeWords(value: string): string;
  };
  export default libmime;
}
