
import { Show, createMemo } from "solid-js";
import type { ContextInfo } from "../types";

interface ContextIndicatorProps {
  contextInfo: ContextInfo | null;
}

export function ContextIndicator(props: ContextIndicatorProps) {
  const percentage = createMemo(() => props.contextInfo?.percentage ?? 0);
  
  // Color based on usage: blue < 60%, yellow 60-85%, orange > 85%
  // Using OKLCH for perceptually uniform lightness and chroma across hues
  const color = createMemo(() => 
    percentage() < 60 
      ? 'oklch(0.7 0.12 250)' 
      : percentage() < 85 
      ? 'oklch(0.7 0.12 90)' 
      : 'oklch(0.7 0.12 30)'
  );

  return (
    <Show when={props.contextInfo}>
      <div class="context-indicator">
        <svg class="context-indicator__ring" viewBox="0 0 100 100">
          {/* Background circle */}
          <circle
            class="context-indicator__ring-bg"
            cx="50"
            cy="50"
            r="42"
            stroke-width="16"
            fill="none"
          />
          {/* Progress circle */}
          <circle
            class="context-indicator__ring-progress"
            cx="50"
            cy="50"
            r="42"
            stroke={color()}
            stroke-width="16"
            stroke-linecap="round"
            fill="none"
            stroke-dasharray="264"
            stroke-dashoffset={264 - (264 * percentage()) / 100}
            transform="rotate(-90 50 50)"
          />
        </svg>
        <span class="context-indicator__text">
          {percentage().toFixed(0)}%
        </span>
      </div>
    </Show>
  );
}
