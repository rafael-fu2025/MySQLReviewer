/**
 * A provider that always tries to hand over the answer.
 *
 * It exists to prove the server-side guard: when the model leaks the
 * solution, the learner must never see it. The app is pointed at this
 * provider for the challenge screen and the reply is expected to be the
 * guard message instead of the statement.
 *
 * Run: node scripts/leaky-ai.cjs [port]
 */
const http = require('node:http');

const port = Number(process.argv[2] ?? 9998);

const LEAK =
  'Sure, here it is:\n' +
  '```sql\n' +
  'SELECT p.productid, p.productname, p.price\n' +
  'FROM products p\n' +
  'WHERE p.price > 20\n' +
  'ORDER BY p.price DESC, p.productid ASC;\n' +
  '```';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'leaky-model' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: LEAK } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Leaky AI provider listening on http://127.0.0.1:${port}/v1`);
});
