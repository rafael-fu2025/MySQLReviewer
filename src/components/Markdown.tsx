import { isValidElement, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';

import { cn } from '@/lib/utils';
import { copyText } from '@/lib/format';
import { sanitizeModelOutput } from '@/lib/sanitize';

/** Flattens React children to their text content (fenced code blocks are plain text). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) {
    return nodeText((node.props as { children?: ReactNode }).children);
  }
  return '';
}

/**
 * A fenced code block with a compact copy button in its top-right corner.
 * Surfaces opt in through Markdown's `codeCopy` — the button reuses the shared
 * icon-stack crossfade (copy → check with scale/blur) and the mint
 * `.pulse-success` ring, matching CopyButton's feedback language.
 */
function CodeBlock(props: ComponentProps<'pre'>) {
  const [copied, setCopied] = useState(false);
  const [pulse, setPulse] = useState(false);
  const code = nodeText(props.children);
  return (
    <div className="markdown-code">
      <pre {...props} />
      <button
        type="button"
        className={cn('code-copy', pulse && 'pulse-success')}
        aria-label={copied ? 'Code copied' : 'Copy code'}
        disabled={!code}
        onClick={async () => {
          if (!(await copyText(code))) return;
          setCopied(true);
          setPulse(true);
          setTimeout(() => setCopied(false), 1_500);
          setTimeout(() => setPulse(false), 500);
        }}
      >
        <span className="icon-stack" aria-hidden="true">
          <Copy size={12} className={copied ? 'icon-off' : 'icon-crossfade'} />
          <Check size={12} className={cn('text-mint', copied ? 'icon-crossfade' : 'icon-off')} />
        </span>
      </button>
    </div>
  );
}

export function Markdown({
  children,
  className,
  sanitize = false,
  codeCopy = false,
}: {
  children: string;
  className?: string;
  sanitize?: boolean;
  /** Render fenced code blocks with a corner copy button (assistant surfaces). */
  codeCopy?: boolean;
}) {
  const content = sanitize ? sanitizeModelOutput(children) : children;
  return (
    <div className={cn('markdown', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          table: ({ node: _node, ...props }) => (
            <div className="overflow-auto">
              <table {...props} />
            </div>
          ),
          ...(codeCopy
            ? {
                pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
              }
            : {}),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
