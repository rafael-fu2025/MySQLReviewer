import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TextCombobox } from '../src/components/Combobox';

/**
 * The model fields (Practice generator, ProviderForm) used a native datalist,
 * whose OS-styled popup clashed with the design. They now use TextCombobox,
 * which must keep free-text entry while rendering suggestions in the app's
 * combo popover.
 */
describe('TextCombobox', () => {
  const options = [
    { value: 'cx/gpt-6-luna', label: 'cx/gpt-6-luna' },
    { value: 'cx/gpt-5.6-luna', label: 'cx/gpt-5.6-luna' },
  ];

  it('renders a combobox input that carries the typed value', () => {
    const html = renderToStaticMarkup(
      <TextCombobox
        value="cx/gpt-6-luna"
        onChange={() => undefined}
        options={options}
        ariaLabel="Model"
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('value="cx/gpt-6-luna"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('does not fall back to the native datalist', () => {
    const html = renderToStaticMarkup(
      <TextCombobox value="" onChange={() => undefined} options={options} />,
    );
    expect(html).not.toContain('datalist');
    expect(html).not.toContain('list=');
  });

  it('keeps the popover closed while static, so nothing leaks outside the field', () => {
    const html = renderToStaticMarkup(
      <TextCombobox value="cx" onChange={() => undefined} options={options} />,
    );
    expect(html).not.toContain('combo-popover');
    expect(html).not.toContain('combo-option');
  });
});
