'use client';

import { useState, useRef, useEffect } from 'react';
import { accent } from '@strata/tokens';
import { MarkdownBody } from './MarkdownBody';
import styles from './ReaderScreen.module.css';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  content: string;
}

const PROMPT_SUGGESTIONS = [
  'Summarize key points',
  'What are the risks or caveats?',
  'Explain architecture tradeoffs',
  'Extract action items or checklist',
] as const;

export function DocAssistant({
  docId,
  docTitle,
  docFolder,
  onClose,
}: {
  docId: string;
  docTitle: string;
  docFolder: string;
  onClose: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isStreaming]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const sendQuery = async (queryText: string) => {
    const trimmed = queryText.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: trimmed,
    };

    const assistantMsgId = `asst-${Date.now()}`;
    const initialAssistantMsg: ChatMessage = {
      id: assistantMsgId,
      role: 'assistant',
      content: '',
    };

    const newHistory = [...messages, userMsg];
    setMessages([...newHistory, initialAssistantMsg]);
    setInput('');
    setIsStreaming(true);

    try {
      const response = await fetch('/api/doc-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          docId,
          question: trimmed,
          history: messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `⚠️ Error: ${errorData.error || 'Failed to query assistant'}` }
              : m,
          ),
        );
        setIsStreaming(false);
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        setIsStreaming(false);
        return;
      }

      const decoder = new TextDecoder();
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        accumulated += decoder.decode(value, { stream: true });
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantMsgId ? { ...m, content: accumulated } : m)),
        );
      }
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantMsgId
            ? { ...m, content: `⚠️ Network error: ${err instanceof Error ? err.message : 'Unknown'}` }
            : m,
        ),
      );
    } finally {
      setIsStreaming(false);
    }
  };

  return (
    <aside className={styles.assistantDrawer} aria-label="Document Assistant">
      <div className={styles.assistantHeader}>
        <div className={styles.assistantBrand}>
          <span className={styles.assistantDot} style={{ background: accent.default }} />
          <span className={styles.assistantTitle}>Strata Assistant</span>
        </div>
        <button
          type="button"
          className={styles.assistantClose}
          onClick={onClose}
          aria-label="Close assistant"
        >
          ✕
        </button>
      </div>

      <div className={styles.assistantContextBar}>
        <span className={styles.contextDocName}>
          {docTitle} ({docFolder})
        </span>
      </div>

      <div className={styles.assistantMessages} ref={scrollRef}>
        {messages.length === 0 ? (
          <div className={styles.assistantEmpty}>
            <p className={styles.emptyHeading}>Ask anything about this document</p>
            <p className={styles.emptySubtitle}>
              Synthesizes answers using security-fenced context.
            </p>
            <div className={styles.promptChips}>
              {PROMPT_SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  className={styles.chipButton}
                  onClick={() => sendQuery(suggestion)}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={m.role === 'user' ? styles.userMessageWrap : styles.assistantMessageWrap}
            >
              <div className={m.role === 'user' ? styles.userBubble : styles.assistantBubble}>
                {m.role === 'assistant' ? (
                  m.content ? (
                    <MarkdownBody body={m.content} />
                  ) : (
                    <span className={styles.typingIndicator}>Thinking…</span>
                  )
                ) : (
                  <span>{m.content}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <form
        className={styles.assistantForm}
        onSubmit={(e) => {
          e.preventDefault();
          sendQuery(input);
        }}
      >
        <input
          ref={inputRef}
          className={styles.assistantInput}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask a question about this doc…"
          disabled={isStreaming}
          aria-label="Question for assistant"
        />
        <button
          type="submit"
          className={styles.assistantSubmit}
          disabled={!input.trim() || isStreaming}
          style={{ background: input.trim() && !isStreaming ? accent.default : undefined }}
          aria-label="Send question"
        >
          ↵
        </button>
      </form>
    </aside>
  );
}
