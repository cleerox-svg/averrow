/** `?url` imports of static data files (Vite emits them as hashed assets, fetched on demand). */
declare module '*.json?url' {
  const url: string;
  export default url;
}
