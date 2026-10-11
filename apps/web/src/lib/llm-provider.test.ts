import test from 'node:test';
import assert from 'node:assert/strict';
import { streamDocAnswer } from './llm-provider.ts';

test('streamDocAnswer fallback generates contextual streaming output without external API keys', async () => {
  const chunks: string[] = [];
  const generator = streamDocAnswer({
    question: 'Please summarize key points',
    docTitle: 'Idempotent Ledger Migrations',
    docFolder: 'Architecture',
    fencedBody: '<untrusted-document nonce="12345">\nDraft plan for ledger writes.\n</untrusted-document>',
    env: {},
  });

  for await (const chunk of generator) {
    chunks.push(chunk);
  }

  const fullText = chunks.join('');
  assert.ok(chunks.length > 1, 'Expected multiple streamed chunks');
  assert.ok(fullText.includes('Idempotent Ledger Migrations'), 'Expected document title in summary');
  assert.ok(fullText.includes('Architecture'), 'Expected folder context in response');
});

test('streamDocAnswer addresses risk queries specifically', async () => {
  const chunks: string[] = [];
  const generator = streamDocAnswer({
    question: 'What are the main security risks and hazards?',
    docTitle: 'Webhook Ingestion Pipeline',
    docFolder: 'Incidents',
    fencedBody: '<untrusted-document nonce="999">\nNotes on webhook storms.\n</untrusted-document>',
    env: {},
  });

  for await (const chunk of generator) {
    chunks.push(chunk);
  }

  const fullText = chunks.join('');
  assert.ok(fullText.includes('Identified Risks & Considerations'), 'Expected risk header in output');
  assert.ok(fullText.includes('Webhook Ingestion Pipeline'), 'Expected document title');
});

test('streamDocAnswer answers general technical queries with code sample formatting', async () => {
  const chunks: string[] = [];
  const generator = streamDocAnswer({
    question: 'How does the middleware work?',
    docTitle: 'Token Bucket Rate Limiter',
    docFolder: 'Infrastructure',
    fencedBody: '<untrusted-document nonce="abc">\nMiddleware details.\n</untrusted-document>',
    env: {},
  });

  for await (const chunk of generator) {
    chunks.push(chunk);
  }

  const fullText = chunks.join('');
  assert.ok(fullText.includes('Token Bucket Rate Limiter'));
  assert.ok(fullText.includes('```ts'));
});
