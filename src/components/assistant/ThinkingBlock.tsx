import { useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger, Spinner } from '@/components/ui';

/**
 * The collapsible reasoning lane of an assistant turn.
 *
 * Text streams into it live; the character count updates as it grows. The
 * block renders nothing when the model produced no reasoning, so providers
 * without a thinking lane see no dead chrome.
 */
export function ThinkingBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text.trim()) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="ai-thinking">
      <CollapsibleTrigger className="ai-thinking-toggle">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} aria-hidden="true" />
        <span>Thinking</span>
        <span className="ai-thinking-count">{text.length.toLocaleString()} chars</span>
        {streaming ? <Spinner size={10} /> : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="ai-thinking-body">{text}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}
