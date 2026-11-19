// context-lens loader (shim).
//
// The extension host imports this file once per process and Node caches ESM modules
// by URL forever, so a disable->enable toggle re-runs activate() on the CACHED module
// and code edits never load. Fix (plugin-side, no app rebuild needed): all real code
// lives in impl/impl.js; every activate() dynamically imports it with a fresh query
// string, which Node treats as a distinct module. Toggling the plugin now loads the
// latest impl without any restart. Old impl instances stay in memory (Node cannot
// unload) - negligible at toggle frequency.
let current = null;

export async function activate(ctx) {
  const seq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  current = await import(new URL(`./impl/impl.js?v=${seq}`, import.meta.url));
  await current.activate(ctx);
}

export async function deactivate() {
  try {
    await current?.deactivate?.();
  } finally {
    current = null;
  }
}
