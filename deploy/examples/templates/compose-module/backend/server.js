import http from 'node:http';

const port = Number(process.env.PORT) || 3000;
const server = http.createServer((_req, res) => {
  const body = JSON.stringify({
    ok: true,
    message: 'compose-module template api',
    env: process.env.SDPY_ENV || '',
  });
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
});
server.listen(port, '0.0.0.0', () => {
  console.log(`listening 0.0.0.0:${port}`);
});
