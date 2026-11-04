const http = require('http');

const port = Number(process.env.PORT) || 3000;
const env = process.env.SDPY_ENV || 'unknown';
const moduleName = process.env.SDPY_MODULE || 'unknown';

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/health/') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ ok: true, env, module: moduleName, path: req.url }));
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ message: 'sdpy sample api', env, module: moduleName }));
});

server.listen(port, '0.0.0.0', () => {
  console.log(`sample api listening on ${port} env=${env} module=${moduleName}`);
});
