/**
 * @file CM6 Extensions for ChatInput
 * @description Combined CodeMirror 6 extensions: theme, keymap, highlighter, trigger detector.
 *              All chat-editor extensions live in this single file to avoid over-decomposition.
 */

import { type Extension, Facet, RangeSetBuilder } from '@codemirror/state';
import {
	placeholder as cmPlaceholder,
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
} from '@codemirror/view';
import { getMessageHighlights } from '../../utils/messageParser';

// ============================================================================
// AnchorRect type (matches ui/Dropdown expectations)
// ============================================================================

export interface AnchorRectLike {
	left: number;
	right: number;
	top: number;
	bottom: number;
	width: number;
	height: number;
}

// ============================================================================
// Chat Theme — VS Code matching styles
// ============================================================================

export const chatTheme = EditorView.theme({
	'&': {
		fontSize: 'var(--font-size-base)',
		fontFamily: 'var(--font-family-base)',
		background: 'transparent',
	},
	'.cm-content': {
		padding: 'var(--gap-1-5) var(--gap-3)',
		caretColor: 'var(--vscode-foreground)',
		color: 'var(--input-text-color)',
		lineHeight: 'var(--line-height-base)',
		minHeight: 'var(--input-min-height)',
	},
	'&.cm-focused': { outline: 'none' },
	'.cm-scroller': {
		overflow: 'auto',
		maxHeight: 'var(--input-max-height)',
		scrollbarGutter: 'stable',
		borderRadius: 'inherit',
	},
	'.cm-line': { padding: '0' },
	'.cm-placeholder': {
		color: 'var(--vscode-input-placeholderForeground, var(--vscode-descriptionForeground))',
	},
	'.cm-cursor': {
		borderLeftColor: 'var(--vscode-foreground)',
	},
});

// ============================================================================
// Chat Keymap — Enter to send, Escape to cancel
// Returns boolean: true = event consumed, false = pass through (e.g. to dropdown)
// ============================================================================

interface ChatKeymapOptions {
	onSubmit: () => boolean;
	onCancel?: () => boolean;
}

export function chatKeymap(options: ChatKeymapOptions): Extension {
	return keymap.of([
		{
			key: 'Enter',
			run: () => options.onSubmit(),
			// Shift+Enter = newline (default CM6 behavior, no override needed)
		},
		{
			key: 'Escape',
			run: () => options.onCancel?.() ?? false,
		},
	]);
}

// ============================================================================
// Chat Highlighter — /commands and @mentions decoration
// ============================================================================

/** Facet to pass valid command names from React into CM6 */
export const validCommandsFacet = Facet.define<Set<string>, Set<string>>({
	combine: values => values[0] ?? new Set(),
});

/** Facet to pass valid subagent names from React into CM6 */
export const validSubagentsFacet = Facet.define<Set<string>, Set<string>>({
	combine: values => values[0] ?? new Set(),
});

const commandMark = Decoration.mark({ class: 'cm-slash-command' });
const subagentMark = Decoration.mark({ class: 'cm-subagent' });

function buildDecorations(view: EditorView): DecorationSet {
	const validCommands = view.state.facet(validCommandsFacet);
	const validSubagents = view.state.facet(validSubagentsFacet);
	const doc = view.state.doc.toString();
	const highlights = getMessageHighlights(doc, validCommands, validSubagents);

	const builder = new RangeSetBuilder<Decoration>();
	for (const h of highlights) {
		builder.add(h.start, h.end, h.type === 'command' ? commandMark : subagentMark);
	}
	return builder.finish();
}

class ChatHighlighterPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = buildDecorations(update.view);
		}
	}
}

export const chatHighlighter: Extension = ViewPlugin.fromClass(ChatHighlighterPlugin, {
	decorations: v => v.decorations,
});

// ============================================================================
// Trigger Detector — / and @ dropdown triggers via CM6
// Reacts to both docChanged AND selectionSet (click/arrow navigation)
// ============================================================================

export interface TriggerCallbacks {
	onSlashTrigger: (pos: number, filter: string, rect: AnchorRectLike | null) => void;
	onSlashUpdate: (filter: string) => void;
	onSlashClose: () => void;
	onAtTrigger: (pos: number, filter: string, rect: AnchorRectLike | null) => void;
	onAtUpdate: (filter: string) => void;
	onAtClose: () => void;
}

function coordsToAnchorRect(coords: {
	left: number;
	right: number;
	top: number;
	bottom: number;
}): AnchorRectLike {
	return {
		left: coords.left,
		right: coords.right,
		top: coords.top,
		bottom: coords.bottom,
		width: coords.right - coords.left,
		height: coords.bottom - coords.top,
	};
}

export function triggerDetector(callbacks: TriggerCallbacks): Extension {
	return EditorView.updateListener.of((update: ViewUpdate) => {
		// React to text changes AND cursor movement (click, arrow keys)
		if (!update.docChanged && !update.selectionSet) return;

		const pos = update.state.selection.main.head;
		// Use lineAt(pos) instead of doc.toString() — O(line length) vs O(doc length)
		const line = update.state.doc.lineAt(pos);
		const textBeforeCursor = line.text.slice(0, pos - line.from);

		// Slash command detection — check prevChar to avoid triggering on URLs (http://)
		const lastSlash = textBeforeCursor.lastIndexOf('/');
		if (lastSlash >= 0) {
			const prevChar = lastSlash > 0 ? textBeforeCursor[lastSlash - 1] : '';
			// Only trigger if / is at start of text or preceded by whitespace
			if (!prevChar || prevChar === ' ') {
				const token = textBeforeCursor.substring(lastSlash);
				if (!token.includes(' ') && token.length > 0) {
					const absolutePos = line.from + lastSlash;
					const coords = update.view.coordsAtPos(absolutePos);
					const rect = coords ? coordsToAnchorRect(coords) : null;
					if (token === '/') {
						callbacks.onSlashTrigger(absolutePos, '', rect);
					} else {
						callbacks.onSlashUpdate(token);
					}
					return;
				}
			}
		}
		callbacks.onSlashClose();

		// @ file picker detection
		const lastAt = textBeforeCursor.lastIndexOf('@');
		if (lastAt >= 0) {
			const prevChar = lastAt > 0 ? textBeforeCursor[lastAt - 1] : '';
			if (!prevChar || prevChar === ' ') {
				const filter = textBeforeCursor.substring(lastAt + 1);
				if (!filter.includes(' ')) {
					const absolutePos = line.from + lastAt;
					const coords = update.view.coordsAtPos(absolutePos);
					const rect = coords ? coordsToAnchorRect(coords) : null;
					if (filter === '') {
						callbacks.onAtTrigger(absolutePos, '', rect);
					} else {
						callbacks.onAtUpdate(filter);
					}
					return;
				}
			}
		}
		callbacks.onAtClose();
	});
}

// ============================================================================
// Paste Handler — bridge native ClipboardEvent to React handler shape
// ============================================================================

export function pasteHandler(onPaste: (e: any) => void): Extension {
	return EditorView.domEventHandlers({
		paste(event: ClipboardEvent) {
			onPaste({
				clipboardData: event.clipboardData,
				preventDefault: () => event.preventDefault(),
			});
			// Return false to let CM6 also handle the text paste
			return false;
		},
	});
}

// ============================================================================
// Drop Handler — prevent CM6 from intercepting file drops
// CM6 natively handles drop events by inserting text into the editor.
// We return true from domEventHandlers to stop CM6's default behavior,
// letting the event bubble up to the parent container where useFileAttachments
// handles it properly (attaching files instead of inserting paths as text).
// ============================================================================

export const dropHandler: Extension = EditorView.domEventHandlers({
	drop() {
		// Block CM6's native drop handling — parent container handles file attachment
		return true;
	},
	dragover() {
		// Block CM6's native dragover — parent container manages isDragOver state
		return true;
	},
	dragleave() {
		// Block CM6's native dragleave — parent container manages isDragOver state
		return true;
	},
});

// Re-export placeholder for convenience
export { cmPlaceholder as placeholder };
