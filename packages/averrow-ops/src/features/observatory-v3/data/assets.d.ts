/** `?url` imports of static data files (Vite emits them as hashed assets, fetched on demand). */
declare module '*.json?url' {
  const url: string;
  export default url;
}

/** Vite `?worker&url`: the bundled, self-contained worker script's URL (MapLibre 6 needs it via `setWorkerUrl`). */
declare module '*?worker&url' {
  const url: string;
  export default url;
}
