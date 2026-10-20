/**
 * Development-only mock of an OpenAI-compatible provider.
 * Run: node scripts/mock-ai.cjs
 * Then add a provider with base URL http://127.0.0.1:9999/v1 and model mock-model.
 */
const http = require('node:http');

const review = {
  verdict: 'warn',
  score: 72,
  summary:
    'Mock review: the statement is readable but should be bounded. Add a LIMIT and verify the filter with EXPLAIN.',
  findings: [
    {
      severity: 'medium',
      category: 'performance',
      title: 'Mock finding: unbounded read',
      detail: 'This is a deterministic mock finding used to verify the AI review pipeline.',
      recommendation: 'Add a LIMIT or an index that matches the predicate.',
      line: 1,
      evidence: 'mock evidence',
      table: 'customer',
      column: 'contactName',
    },
  ],
  rewrite: {
    sql: 'SELECT custId FROM customer LIMIT 100;',
    explanation: 'Mock rewrite: list one column and bound the result.',
  },
};

const chatAnswer =
  'Mock chat answer: the plan is a scan because the predicate is not backed by a selective index. Start with EXPLAIN, add an index on the filter column, and measure again.';

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let payload = {};
      try {
        payload = JSON.parse(body);
      } catch {
        // Fall back to an empty payload.
      }
      const messages = JSON.stringify(payload.messages || []);
      const isReview = messages.includes('Return ONLY one JSON object');
      const text = isReview ? JSON.stringify(review) : chatAnswer;

      if (payload.stream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        const chunks = text.match(/[\s\S]{1,24}/g) || [text];
        let index = 0;
        const timer = setInterval(() => {
          if (index >= chunks.length) {
            clearInterval(timer);
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: { content: chunks[index] } }],
            })}\n\n`,
          );
          index += 1;
        }, 15);
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: text } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        }),
      );
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock endpoint not found' } }));
  });
});

server.listen(9999, '127.0.0.1', () => {
  console.log('Mock AI provider listening on http://127.0.0.1:9999/v1');
});
