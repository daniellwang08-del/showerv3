// Minimal in-memory chrome.* for modules that touch storage at import time.

function area() {
  let data = {};
  return {
    async get(keys) {
      if (keys == null) return { ...data };
      const list = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys);
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(patch) {
      data = { ...data, ...patch };
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
    async clear() {
      data = {};
    },
  };
}

globalThis.chrome = {
  storage: { local: area(), session: area() },
  runtime: { getManifest: () => ({ version: "test" }), id: "test" },
  tabs: { query: async () => [] },
};
