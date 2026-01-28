import { createEffect, onMount } from "solid-js";

interface EditableUserMessageProps {
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function EditableUserMessage(props: EditableUserMessageProps) {
  let textareaRef!: HTMLTextAreaElement;

  const adjustTextareaHeight = () => {
    if (textareaRef) {
      textareaRef.style.height = "auto";
      textareaRef.style.height = `${Math.min(textareaRef.scrollHeight, 200)}px`;
    }
  };

  createEffect(() => {
    props.text;
    adjustTextareaHeight();
  });

  onMount(() => {
    textareaRef?.focus();
    // Move cursor to end
    textareaRef.selectionStart = textareaRef.value.length;
    textareaRef.selectionEnd = textareaRef.value.length;
    adjustTextareaHeight();
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
      return;
    }
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      props.onSubmit();
    }
  };

  const handleContainerClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest("button") && textareaRef) {
      textareaRef.focus();
    }
  };

  return (
    <div class="editable-message" onClick={handleContainerClick}>
      <textarea
        ref={textareaRef!}
        class="editable-message__input"
        value={props.text}
        onInput={(e) => props.onTextChange(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
      />
      <div class="editable-message__actions">
        <button
          type="button"
          class="editable-message__cancel"
          onClick={() => props.onCancel()}
          aria-label="Cancel (Escape)"
        >
          Cancel
        </button>
        <button
          type="button"
          class="shortcut-button shortcut-button--secondary"
          disabled={!props.text.trim()}
          onClick={() => props.onSubmit()}
          aria-label="Submit (Cmd+Enter)"
        >
          ⌘⏎
        </button>
      </div>
    </div>
  );
}
