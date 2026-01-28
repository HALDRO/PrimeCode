
import { Show, createSignal, onCleanup } from "solid-js";

interface ThinkingIndicatorProps {
  when: boolean;
}

export function ThinkingIndicator(props: ThinkingIndicatorProps) {
  const frames = ['\\', '|', '/', '-'];
  const [frameIndex, setFrameIndex] = createSignal(0);

  const interval = setInterval(() => {
    setFrameIndex((prev) => (prev + 1) % frames.length);
  }, 150);

  onCleanup(() => clearInterval(interval));

  return (
    <Show when={props.when}>
      <div class="loading-indicator">
        {frames[frameIndex()]}
      </div>
    </Show>
  );
}
