import { NextRequest, NextResponse } from 'next/server';
import { asUntrusted, fence, type DocId } from '@strata/core';
import { vault, NotSignedIn } from '../../../lib/vault';
import { streamDocAnswer, type ChatMessage } from '../../../lib/llm-provider';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<Response> {
  let v;
  try {
    v = await vault();
  } catch (e) {
    if (e instanceof NotSignedIn) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ error: 'Internal Error' }, { status: 500 });
  }

  const { docs, scope } = v;

  let body: {
    docId?: string;
    question?: string;
    history?: ChatMessage[];
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { docId, question, history } = body;

  if (!docId || typeof docId !== 'string' || !question || typeof question !== 'string') {
    return NextResponse.json({ error: 'Missing required docId or question' }, { status: 400 });
  }

  let doc;
  try {
    doc = await docs.get(scope, docId as DocId);
  } catch {
    return NextResponse.json({ error: 'Document not found or inaccessible' }, { status: 404 });
  }

  // Safe prompt fencing (ADR 0005): Wrap untrusted document body with nonce envelope
  const fencedBody = fence(asUntrusted(doc.body));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const generator = streamDocAnswer({
          question: question.trim(),
          docTitle: doc.title,
          docFolder: doc.folder.value,
          fencedBody,
          history: history ?? [],
        });

        for await (const chunk of generator) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Transfer-Encoding': 'chunked',
    },
  });
}
