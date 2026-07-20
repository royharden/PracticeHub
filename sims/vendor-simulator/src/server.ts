import { createServer, type ServerResponse } from 'node:http';

const scenarios = new Map<string, string>();

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://vendor-simulator.local');
  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJson(response, 200, {
      service: 'practicehub-vendor-simulator',
      synthetic: true,
      status: 'ok',
    });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/scenarios') {
    writeJson(response, 200, { scenarios: Object.fromEntries(scenarios), synthetic: true });
    return;
  }

  const match = /^\/scenarios\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (request.method === 'POST' && match?.[1] && match[2]) {
    const rail = decodeURIComponent(match[1]);
    const scenario = decodeURIComponent(match[2]);
    scenarios.set(rail, scenario);
    writeJson(response, 200, { rail, scenario, synthetic: true });
    return;
  }
  writeJson(response, 404, { error: 'not-found', synthetic: true });
});

const port = Number.parseInt(process.env.PORT ?? '9090', 10);
await new Promise<void>((resolve) => {
  server.listen(port, '0.0.0.0', resolve);
});
