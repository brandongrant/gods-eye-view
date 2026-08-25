/**
 * Mount the app's `/api/*` Vite plugins onto a plain Node middleware stack.
 *
 * `vite build` emits a static `dist/`, but roughly half the layers are served by
 * middleware that lives in `vite.config.js` as inline Vite plugins. Ten of them
 * register only `configureServer`, so they exist under `vite` and vanish under
 * `vite preview` or any static host — taking satellites, flights, traffic,
 * routing, CCTV, bikeshare, fires, aircraft metadata and terrain heights with
 * them.
 *
 * Forking those handlers into a standalone server would fork nineteen upstream
 * code paths and guarantee drift. Instead we reuse them verbatim: every plugin
 * touches exactly two things on the `server` it is handed —
 * `server.middlewares.use(path, fn)` and one optional-chained
 * `server.httpServer.on('close', …)` — so a connect/Express app satisfies the
 * entire contract when passed as `middlewares`.
 *
 * @module server/mountApiPlugins
 */

/**
 * Plugin names that own build-time asset plumbing and must not be mounted.
 *
 * `vite-plugin-cesium`'s `configureServer` serves `/cesium` straight out of
 * `node_modules/cesium/Build/CesiumUnminified`. Mounted here it would shadow the
 * minified copy `closeBundle` already wrote into `dist/cesium` — serving the
 * unminified engine, from the wrong root, past our cache headers.
 */
export const SKIPPED_PLUGIN_NAMES = Object.freeze(['vite-plugin-cesium', 'vite:cesium', 'cesium']);

/**
 * Read a Vite hook that may be a bare function or an `{ order, handler }` pair.
 *
 * @param {unknown} hook
 * @returns {Function|null}
 */
export function hookHandler(hook) {
  if (typeof hook === 'function') return hook;
  if (hook && typeof hook === 'object' && typeof (/** @type {any} */ (hook).handler) === 'function') {
    return /** @type {any} */ (hook).handler;
  }
  return null;
}

/**
 * Flatten a Vite `plugins` array and keep the entries that serve requests.
 *
 * `configureServer` wins over `configurePreviewServer`: seven plugins declare
 * both, and because no handler calls `next()`, mounting both would leave a dead
 * duplicate stack behind the first.
 *
 * @param {unknown[]} plugins
 * @returns {{ name: string, handler: Function, hook: 'configureServer'|'configurePreviewServer' }[]}
 */
export function collectApiPlugins(plugins) {
  const flat = (Array.isArray(plugins) ? plugins : []).flat(Infinity);
  const collected = [];
  for (const plugin of flat) {
    if (!plugin || typeof plugin !== 'object') continue;
    const name = String(/** @type {any} */ (plugin).name || '');
    if (SKIPPED_PLUGIN_NAMES.includes(name)) continue;
    const serve = hookHandler(/** @type {any} */ (plugin).configureServer);
    const preview = hookHandler(/** @type {any} */ (plugin).configurePreviewServer);
    const handler = serve || preview;
    if (!handler) continue;
    collected.push({ name, handler, hook: serve ? 'configureServer' : 'configurePreviewServer' });
  }
  return collected;
}

/**
 * Run each collected plugin against a stub server so its routes land on
 * `middlewares`.
 *
 * A plugin that throws is reported and skipped rather than taking the process
 * down: losing one upstream proxy should degrade one layer, not the globe.
 *
 * @param {{ plugins: unknown[], middlewares: any, httpServer?: any, onError?: (name: string, error: Error) => void }} options
 * @returns {Promise<{ mounted: string[], failed: string[], postHooks: Function[] }>}
 */
export async function mountApiPlugins({ plugins, middlewares, httpServer = null, onError = null }) {
  if (!middlewares || typeof middlewares.use !== 'function') {
    throw new Error('mountApiPlugins requires a middleware stack exposing use()');
  }
  const server = { middlewares, httpServer, config: { command: 'serve', mode: 'production' } };
  const mounted = [];
  const failed = [];
  const postHooks = [];
  for (const entry of collectApiPlugins(plugins)) {
    try {
      const post = await entry.handler.call(null, server);
      if (typeof post === 'function') postHooks.push(post);
      mounted.push(entry.name);
    } catch (error) {
      failed.push(entry.name);
      if (onError) onError(entry.name, /** @type {Error} */ (error));
    }
  }
  return { mounted, failed, postHooks };
}
