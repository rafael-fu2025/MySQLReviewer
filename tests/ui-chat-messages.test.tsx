import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AiChatMessage } from '../shared/types';
import { Message } from '../src/components/assistant/Message';
import { Markdown } from '../src/components/Markdown';

describe('assistant message decomposition', () => {
  it('renders nothing while streaming an empty draft — the thinking row owns the wait', () => {
    const html = renderToStaticMarkup(
      <Message
        message={{ role: 'assistant', content: '', thinking: '', toolCalls: [] }}
        assistantLabel="mylens"
        streaming
      />,
    );
    expect(html).not.toContain('message-assistant');
  });

  it('shows the tool count badge next to the label', () => {
    const message: AiChatMessage = {
      role: 'assistant',
      content: 'Answer.',
      toolCalls: [
        { id: 'c1', name: 'list_tables', arguments: {}, status: 'complete' },
        { id: 'c2', name: 'describe_table', arguments: {}, status: 'complete' },
      ],
    };
    const html = renderToStaticMarkup(<Message message={message} assistantLabel="mylens" />);
    expect(html).toContain('message-assistant');
    expect(html).toContain('· 2 tools');
    // Radix unmounts collapsed content in static markup, so the collapsed
    // group header is what carries the latest call's name.
    expect(html).toContain('latest: describe_table');
  });

  it('singularizes a single tool call', () => {
    const html = renderToStaticMarkup(
      <Message
        message={{
          role: 'assistant',
          content: 'Answer.',
          toolCalls: [{ id: 'c1', name: 'list_tables', arguments: {}, status: 'complete' }],
        }}
        assistantLabel="mylens"
      />,
    );
    expect(html).toContain('· 1 tool');
    expect(html).not.toContain('1 tools');
  });

  it('renders user turns as plain text with the user label', () => {
    const html = renderToStaticMarkup(
      <Message message={{ role: 'user', content: 'why is this slow?' }} assistantLabel="mylens" />,
    );
    expect(html).toContain('message-user');
    expect(html).toContain('why is this slow?');
  });

  it('keeps the streaming marker on a streaming draft with content', () => {
    const html = renderToStaticMarkup(
      <Message
        message={{ role: 'assistant', content: 'partial…', toolCalls: [] }}
        assistantLabel="mylens"
        streaming
      />,
    );
    expect(html).toContain('data-streaming="true"');
    expect(html).toContain('partial…');
  });
});

describe('Markdown model-output sanitizer', () => {
  it('strips think markup and emoji pictographs when sanitize is on', () => {
    const html = renderToStaticMarkup(
      <Markdown sanitize>{'<think>hidden</think>Visible 🎉 answer'}</Markdown>,
    );
    expect(html).toContain('Visible');
    expect(html).toContain('answer');
    expect(html).not.toContain('<think>');
    expect(html).not.toContain('🎉');
  });

  it('removes a dangling think block from a mid-stream answer', () => {
    const html = renderToStaticMarkup(
      <Markdown sanitize>{'Partial answer <think>leaked reasoning'}</Markdown>,
    );
    expect(html).toContain('Partial answer');
    expect(html).not.toContain('leaked reasoning');
  });

  it('leaves plain prose untouched by default', () => {
    const html = renderToStaticMarkup(<Markdown>{'Plain **prose**'}</Markdown>);
    expect(html).toContain('prose');
    expect(html).not.toContain('sanitize');
  });
});
