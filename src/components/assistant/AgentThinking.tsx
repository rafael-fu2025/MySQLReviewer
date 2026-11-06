/**
 * The waiting indicator shown while a turn streams and nothing has arrived
 * yet. Ported from SeaSID's busy row — theirs is a wave.gif; there is no
 * asset here, so three pulsing dots stand in.
 */
export function AgentThinking({ label = 'Agent thinking…' }: { label?: string }) {
  return (
    <div className="ai-thinking-row" role="status" data-testid="agent-thinking">
      <span className="ai-thinking-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{label}</span>
    </div>
  );
}
