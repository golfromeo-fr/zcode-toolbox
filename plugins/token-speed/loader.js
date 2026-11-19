// token-speed loader (shim) — same pattern as context-lens: Node caches ESM by URL,
// so the real code lives in impl/impl.js and is re-imported with a fresh query on
// every activate(); plugin edits load via disable->enable, no restart needed.
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
