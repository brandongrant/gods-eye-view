/**
 * Production HTTP server for God's Eye View.
 *
 * Serves the `vite build` output and re-mounts the `/api/*` middleware that
 * otherwise only exists inside the Vite dev server. See
 * `src/server/mountApiPlugins.js` for why reusing the plugins beats forking
 * nineteen handlers.
 *
 * Deliberately mounts **no body parser**: `/api/overpass`,
 * `/api/openai/hud-summary` and `/api/realtime/debug-log` read the raw request
 * stream themselves, and a global parser would consume it and hang them.
 *
 * @module server/index
 */

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import compression from 'compression';
import viteConfigFactory from '../vite.config.js';
import { mountApiPlugins } from '../src/server/mountApiPlugins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number.parseInt(process.env.PORT || '', 10) || 8080;
const BIND = process.env.BIND_HOST || '0.0.0.0';

/** Content-hashed build assets are safe to cache forever; nothing else is. */
const HASHED_ASSET = /-[A-Za-z0-9_-]{8,}\.[A-Za-z0-9]+$/;

async function start() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    throw new Error(`No build found at ${DIST}. Run "npm run build" first.`);
  }

  // Calling the config factory is also what loads this checkout's .env into
  // process.env (shell values win), which every proxy reads lazily per request.
  const config = await viteConfigFactory({ mode: 'production', command: 'serve' });

  const app = express();
  app.disable('x-powered-by');

  // Cheapest possible path, ahead of every proxy, so a probe never waits on an
  // upstream API. NOT `/healthz`: Google's front end answers that path itself
  // with its own 404 and the request never reaches the container.
  app.get('/_gev/healthz', (_req, res) => res.type('text/plain').send('ok'));

  const server = http.createServer(app);

  const { mounted, failed } = await mountApiPlugins({
    plugins: config.plugins,
    middlewares: app,
    httpServer: server,
    onError: (name, error) => console.error(`[api] ${name} failed to mount: ${error.message}`),
  });
  console.log(`[api] mounted ${mounted.length} proxies: ${mounted.join(', ')}`);
  if (failed.length) console.error(`[api] NOT mounted: ${failed.join(', ')}`);

  // An unmatched /api path must not fall through to the SPA shell, or a broken
  // endpoint would answer 200 with HTML and the client would misread it. The
  // wording deliberately differs from the proxies' own "unknown endpoint" 404s
  // so a mounting bug is never mistaken for an upstream one.
  app.use('/api', (_req, res) => res.status(404).type('application/json').send('{"error":"no such api route"}'));

  app.use(compression({
    // Compressing a ranged response breaks the byte offsets the client asked for.
    filter: (req, res) => !req.headers.range && compression.filter(req, res),
  }));

  app.use(express.static(DIST, {
    index: false,
    setHeaders: (res, filePath) => {
      res.setHeader(
        'Cache-Control',
        HASHED_ASSET.test(path.basename(filePath))
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300',
      );
    },
  }));

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(DIST, 'index.html'));
  });

  await new Promise((resolve) => server.listen(PORT, BIND, resolve));
  console.log(`[gev] listening on http://${BIND}:${PORT}`);

  const shutdown = (signal) => {
    console.log(`[gev] ${signal} — closing`);
    server.close(() => process.exit(0));
    // Cloud Run allows 10s; don't let a hung upstream socket outlast it.
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error('[gev] failed to start:', error);
  process.exit(1);
});
