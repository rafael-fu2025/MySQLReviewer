import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentToolCallView } from '@shared/types';
import { ToolCallList } from '../src/components/assistant/ToolCallList';

function call(overrides: Partial<AgentToolCallView> = {}): AgentToolCallView {
  return {
    id: 'c1',
    name: 'list_tables',
    arguments: {},
    status: 'complete',
    output: '{}',
    ...overrides,
  };
}

describe('ToolCallList proposal cards', () => {
  it('renders Insert and Copy actions for a finished proposal', () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        calls={[
          call({
            name: 'propose_sql',
            arguments: {
              title: 'Add index',
              sql: 'CREATE INDEX i ON t (c)',
              rationale: 'speeds the filter',
            },
          }),
        ]}
        onInsertSql={() => {}}
      />,
    );
    expect(html).toContain('Add index');
    expect(html).toContain('CREATE INDEX i ON t (c)');
    expect(html).toContain('speeds the filter');
    expect(html).toContain('Insert into editor');
    expect(html).toContain('Copy');
  });

  it('degrades to Copy-only without an editor host', () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        calls={[call({ name: 'propose_sql', arguments: { title: 't', sql: 'SELECT 1' } })]}
      />,
    );
    expect(html).not.toContain('Insert into editor');
    expect(html).toContain('Copy');
  });

  it('shows a failed proposal without actions', () => {
    const html = renderToStaticMarkup(
      <ToolCallList
        calls={[
          call({
            name: 'propose_sql',
            status: 'error',
            error: 'The `sql` argument is required.',
            arguments: {},
          }),
        ]}
        onInsertSql={() => {}}
      />,
    );
    expect(html).toContain('proposal failed');
    expect(html).not.toContain('Insert into editor');
    expect(html).not.toContain('>Copy<');
  });

  it('keeps ordinary tool rows free of proposal actions', () => {
    const html = renderToStaticMarkup(
      <ToolCallList calls={[call({ name: 'run_readonly_query' })]} onInsertSql={() => {}} />,
    );
    expect(html).not.toContain('Insert into editor');
    expect(html).toContain('run_readonly_query');
  });
});
