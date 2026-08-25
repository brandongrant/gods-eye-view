/**
 * Open the private Cloud Run deployment in a normal browser.
 *
 * The service runs with `--no-allow-unauthenticated`, so every request needs a
 * Google-signed identity token — which a browser address bar cannot attach.
 * This listens on localhost and forwards each request upstream with the token
 * belonging to whoever is logged into gcloud, so the deployment stays reachable
 * only by principals holding `roles/run.invoker` and nothing is exposed
 * publicly.
 *
 * (`gcloud run services proxy` does the same job, but it needs the
 * `cloud-run-proxy` component, and installing that writes into the SDK
 * directory — which needs Administrator on this machine.)
 *
 *   node tools/gev-proxy.mjs            → http://localhost:8080
 *   node tools/gev-proxy.mjs --port 9000
 *
 * @module tools/gev-proxy
 */

import http from 'node:http';
import https from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const DEFAULT_TARGET = 'https://gods-eye-view-1073062544076.us-central1.run.app';
const args = process.argv.slice(2);
const readArg = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const target = new URL(readArg('--target', process.env.GEV_TARGET || DEFAULT_TARGET));
const port = Number.parseInt(readArg('--port', '8080'), 10);
// Identity tokens are good for an hour; refresh well inside that.
const TOKEN_TTL_MS = 30 * 60 * 1000;

let token = null;
let tokenFetchedAt = 0;

async function identityToken() {
  if (token && Date.now() - tokenFetchedAt < TOKEN_TTL_MS) return token;
  // On Windows gcloud is a .cmd, and since the CVE-2024-27980 hardening Node
  // refuses to spawn one without a shell. The argv is static, so there is
  // nothing here for a shell to interpolate.
  const isWindows = process.platform === 'win32';
  const { stdout } = await execFileAsync(
    isWindows ? 'gcloud.cmd' : 'gcloud',
    ['auth', 'print-identity-token'],
    { maxBuffer: 1024 * 1024, shell: isWindows },
  );
  token = stdout.trim();
  tokenFetchedAt = Date.now();
  if (!token) throw new Error('gcloud returned an empty identity token — run `gcloud auth login`');
  return token;
}

const server = http.createServer(async (req, res) => {
  let bearer;
  try {
    bearer = await identityToken();
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end(`Could not get an identity token: ${error.message}\n`);
    return;
  }

  // Strip hop-by-hop and identity headers, then re-sign as this user. Host must
  // be the Cloud Run host or the request is routed to the wrong service.
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  delete headers['accept-encoding'];
  headers.authorization = `Bearer ${bearer}`;

  const request = https.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: req.url,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  request.on('error', (error) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`upstream error: ${error.message}\n`);
  });

  req.pipe(request);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[gev-proxy] ${target.origin} -> http://localhost:${port}`);
  console.log('[gev-proxy] open that URL in a browser; Ctrl-C to stop');
});
