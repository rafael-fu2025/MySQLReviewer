import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatComposer } from '../src/components/assistant/ChatComposer';

/**
 * Static-render checks of the composer's two button states and disabled
 * wiring. The interactive mechanics (auto-grow clamp, imperative focus,
 * Enter vs Shift+Enter) need a DOM and are covered by the manual pass.
 */
describe('ChatComposer', () => {
  it('swaps the send button for a stop button while busy', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        value="SELECT 1"
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        busy
        placeholder="Ask…"
      />,
    );
    expect(html).toContain('composer-stop');
    expect(html).not.toContain('composer-send');
    expect(html).toContain('disabled=""'); // textarea disabled while busy
  });

  it('shows a disabled send button for an empty draft', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        value=""
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        busy={false}
        placeholder="Ask…"
      />,
    );
    expect(html).toContain('composer-send');
    expect(html).not.toContain('composer-stop');
    expect(html).toContain('disabled=""');
  });

  it('enables send once there is text', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        value="SELECT 1"
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        busy={false}
        placeholder="Ask…"
      />,
    );
    expect(html).toContain('composer-send');
    // The textarea is enabled, so its disabled attribute is absent.
    expect(html).not.toContain('textarea disabled=""');
  });

  it('disables the whole composer when the host has no provider', () => {
    const html = renderToStaticMarkup(
      <ChatComposer
        value="SELECT 1"
        onChange={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        busy={false}
        disabled
        placeholder="Ask…"
      />,
    );
    expect(html).toContain('disabled=""');
  });
});
