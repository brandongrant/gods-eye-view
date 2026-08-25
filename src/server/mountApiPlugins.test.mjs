// The production server reuses vite.config.js's proxy plugins rather than
// forking them. That only holds while the plugins keep touching nothing on the
// `server` argument beyond `middlewares` and an optional `httpServer`, and
// while `configureServer` reliably wins over `configurePreviewServer` — seven
// plugins declare both, and since no handler calls next(), mounting both would
// leave a dead duplicate stack behind the first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectApiPlugins, hookHandler, mountApiPlugins, SKIPPED_PLUGIN_NAMES } from './mountApiPlugins.js';

/** Minimal connect-alike that records what got mounted. */
function stubMiddlewares() {
  const routes = [];
  return { routes, use: (path, fn) => routes.push([path, fn]) };
}

test('hookHandler accepts a bare function and the { order, handler } object form', () => {
  const fn = () => {};
  assert.equal(hookHandler(fn), fn);
  assert.equal(hookHandler({ order: 'pre', handler: fn }), fn);
  assert.equal(hookHandler(undefined), null);
  assert.equal(hookHandler({}), null);
  assert.equal(hookHandler('configureServer'), null);
});

test('configureServer wins over configurePreviewServer on a plugin declaring both', () => {
  const serve = () => {};
  const preview = () => {};
  const [entry] = collectApiPlugins([
    { name: 'both-proxy', configureServer: serve, configurePreviewServer: preview },
  ]);
  assert.equal(entry.handler, serve);
  assert.equal(entry.hook, 'configureServer');
});

test('a preview-only plugin is still collected — otherwise it would silently vanish', () => {
  const preview = () => {};
  const [entry] = collectApiPlugins([{ name: 'preview-only', configurePreviewServer: preview }]);
  assert.equal(entry.handler, preview);
  assert.equal(entry.hook, 'configurePreviewServer');
});

test('the Cesium asset plugin is skipped and nested/blank entries are tolerated', () => {
  const names = collectApiPlugins([
    null,
    false,
    'not-a-plugin',
    // The real plugin reports this name; skipping only 'vite:cesium' let it
    // through and it shadowed dist/cesium with the unminified node_modules copy.
    { name: 'vite-plugin-cesium', configureServer: () => {} },
    { name: 'vite:cesium', configureServer: () => {} },
    { name: 'no-hooks' },
    [{ name: 'nested-proxy', configureServer: () => {} }],
  ]).map((entry) => entry.name);
  assert.deepEqual(names, ['nested-proxy']);
  assert.ok(SKIPPED_PLUGIN_NAMES.includes('vite-plugin-cesium'));
});

test('mounting hands each plugin the stub server and lands its routes on the stack', async () => {
  const middlewares = stubMiddlewares();
  const httpServer = { on: () => {} };
  const seen = [];
  const result = await mountApiPlugins({
    plugins: [
      {
        name: 'alpha-proxy',
        configureServer: (server) => {
          seen.push(server);
          server.middlewares.use('/api/alpha', () => {});
        },
      },
      {
        name: 'beta-proxy',
        configureServer: (server) => {
          // The one real use of httpServer upstream is optional-chained.
          server.httpServer?.on('close', () => {});
          server.middlewares.use('/api/beta', () => {});
        },
      },
    ],
    middlewares,
    httpServer,
  });

  assert.deepEqual(result.mounted, ['alpha-proxy', 'beta-proxy']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(middlewares.routes.map(([path]) => path), ['/api/alpha', '/api/beta']);
  assert.equal(seen[0].middlewares, middlewares);
  assert.equal(seen[0].httpServer, httpServer);
});

test('a plugin without httpServer still mounts — the only use of it is optional-chained', async () => {
  const middlewares = stubMiddlewares();
  const result = await mountApiPlugins({
    plugins: [{
      name: 'ais-live-proxy',
      configureServer: (server) => {
        server.httpServer?.on('close', () => {});
        server.middlewares.use('/api/ais-live', () => {});
      },
    }],
    middlewares,
  });
  assert.deepEqual(result.mounted, ['ais-live-proxy']);
  assert.deepEqual(result.failed, []);
});

test('one broken proxy is isolated: it is reported, the rest still mount', async () => {
  const middlewares = stubMiddlewares();
  const errors = [];
  const result = await mountApiPlugins({
    plugins: [
      { name: 'bad-proxy', configureServer: () => { throw new Error('upstream key missing'); } },
      { name: 'good-proxy', configureServer: (server) => server.middlewares.use('/api/good', () => {}) },
    ],
    middlewares,
    onError: (name, error) => errors.push([name, error.message]),
  });
  assert.deepEqual(result.failed, ['bad-proxy']);
  assert.deepEqual(result.mounted, ['good-proxy']);
  assert.deepEqual(errors, [['bad-proxy', 'upstream key missing']]);
  assert.deepEqual(middlewares.routes.map(([path]) => path), ['/api/good']);
});

test('an async plugin is awaited and a returned post hook is handed back, not dropped', async () => {
  const middlewares = stubMiddlewares();
  const post = () => {};
  const result = await mountApiPlugins({
    plugins: [{
      name: 'async-proxy',
      configureServer: async (server) => {
        await Promise.resolve();
        server.middlewares.use('/api/async', () => {});
        return post;
      },
    }],
    middlewares,
  });
  assert.deepEqual(result.mounted, ['async-proxy']);
  assert.deepEqual(result.postHooks, [post]);
  assert.deepEqual(middlewares.routes.map(([path]) => path), ['/api/async']);
});

test('a stack without use() is rejected up front rather than half-mounting', async () => {
  await assert.rejects(
    () => mountApiPlugins({ plugins: [], middlewares: {} }),
    /middleware stack exposing use/,
  );
});
