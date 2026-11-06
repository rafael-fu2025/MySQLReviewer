import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';
import { sanitizeModelOutput } from '@/lib/sanitize';

export function Markdown({
  children,
  className,
  sanitize = false,
}: {
  children: string;
  className?: string;
  sanitize?: boolean;
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
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
