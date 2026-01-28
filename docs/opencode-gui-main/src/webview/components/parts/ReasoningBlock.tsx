
import type { MessagePart } from "../../types";

interface ReasoningBlockProps {
  part: MessagePart;
}

export function ReasoningBlock(props: ReasoningBlockProps) {
  return (
    <details class="reasoning-block">
      <summary>
        <span>Thinking</span>
      </summary>
      <div class="reasoning-content">{props.part.text}</div>
    </details>
  );
}
