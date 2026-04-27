/**
 * @file CM6 Extensions for ChatInput
 * @description Combined CodeMirror 6 extensions: theme, keymap, highlighter, trigger detector.
 *              All chat-editor extensions live in this single file to avoid over-decomposition.
 */

import { type Extension, Facet, Prec, RangeSetBuilder } from '@codemirror/state';
import {
	placeholder as cmPlaceholder,
	Decoration,
	type DecorationSet,
	EditorView,
	keymap,
	ViewPlugin,
	type ViewUpdate,
	WidgetType,
} from '@codemirror/view';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { extractInlineAttachmentMatches } from '../../../common/inlineAttachments';
import { getMessageHighlights } from '../../utils/messageParser';
import { vscode } from '../../utils/vscode';
import { InlineAttachmentChip } from '../ui';

const isBoundaryChar = (char: string | undefined): boolean => !char || /\s/.test(char);

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

interface InlineAttachmentRange {
	from: number;
	to: number;
}

class InlineAttachmentWidget extends WidgetType {
	constructor(
		private readonly match: ReturnType<typeof extractInlineAttachmentMatches>[number],
		private readonly onOpen: (filePath: string, startLine?: number, endLine?: number) => void,
	) {
		super();
	}

	eq(other: InlineAttachmentWidget): boolean {
		return other.match.raw === this.match.raw && other.match.start === this.match.start;
	}

	toDOM(): HTMLElement {
		const wrap = document.createElement('span');
		wrap.className = 'cm-inline-attachment-chip';
		wrap.contentEditable = 'false';
		const root: Root = createRoot(wrap);
		root.render(
			createElement(InlineAttachmentChip, {
				match: this.match,
				onOpen: this.onOpen,
			}),
		);
		(wrap as HTMLElement & { __root?: Root | null }).__root = root;
		return wrap;
	}

	destroy(dom: HTMLElement): void {
		const host = dom as HTMLElement & { __root?: Root | null };
		host.__root?.unmount();
		host.__root = null;
	}

	ignoreEvent(): boolean {
		return false;
	}
}

function buildHighlightDecorations(view: EditorView): DecorationSet {
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

function buildInlineAttachmentDecorations(view: EditorView): DecorationSet {
	const doc = view.state.doc.toString();
	const matches = extractInlineAttachmentMatches(doc);
	if (matches.length === 0) return Decoration.none;

	const builder = new RangeSetBuilder<Decoration>();
	const openFile = (filePath: string, startLine?: number, endLine?: number) => {
		vscode.postMessage({ type: 'openFile', filePath, startLine, endLine });
	};
	for (const match of matches) {
		builder.add(
			match.start,
			match.end,
			Decoration.replace({
				widget: new InlineAttachmentWidget(match, openFile),
				inclusive: false,
			}),
		);
	}
	return builder.finish();
}

function getInlineAttachmentRanges(doc: string): InlineAttachmentRange[] {
	return extractInlineAttachmentMatches(doc).map(match => ({ from: match.start, to: match.end }));
}

function findInlineRangeAt(
	ranges: InlineAttachmentRange[],
	position: number,
): InlineAttachmentRange | null {
	for (const range of ranges) {
		if (position >= range.from && position <= range.to) return range;
	}
	return null;
}

function findInlineRangeTouching(
	ranges: InlineAttachmentRange[],
	position: number,
	direction: 'backward' | 'forward',
): InlineAttachmentRange | null {
	for (const range of ranges) {
		if (direction === 'backward' && position === range.to) return range;
		if (direction === 'forward' && position === range.from) return range;
	}
	return null;
}

function removeInlineAttachmentAtSelection(
	view: EditorView,
	direction: 'backward' | 'forward',
): boolean {
	const selection = view.state.selection.main;
	const ranges = getInlineAttachmentRanges(view.state.doc.toString());
	if (ranges.length === 0) return false;

	let target: InlineAttachmentRange | null = null;
	if (!selection.empty) {
		target = ranges.find(range => selection.from < range.to && selection.to > range.from) ?? null;
	} else {
		target = findInlineRangeTouching(ranges, selection.from, direction);
		if (!target) {
			target = findInlineRangeAt(ranges, selection.from);
		}
	}
	if (!target) return false;

	view.dispatch({
		changes: { from: target.from, to: target.to, insert: '' },
		selection: { anchor: target.from },
	});
	return true;
}

const inlineAttachmentKeymap: Extension = Prec.high(
	keymap.of([
		{
			key: 'Backspace',
			run: view => removeInlineAttachmentAtSelection(view, 'backward'),
		},
		{
			key: 'Delete',
			run: view => removeInlineAttachmentAtSelection(view, 'forward'),
		},
	]),
);

class ChatHighlighterPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildHighlightDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = buildHighlightDecorations(update.view);
		}
	}
}

const chatHighlighterPlugin = ViewPlugin.fromClass(ChatHighlighterPlugin, {
	decorations: v => v.decorations,
});

export const chatHighlighter: Extension = chatHighlighterPlugin;

class InlineAttachmentPlugin {
	decorations: DecorationSet;

	constructor(view: EditorView) {
		this.decorations = buildInlineAttachmentDecorations(view);
	}

	update(update: ViewUpdate) {
		if (update.docChanged || update.viewportChanged) {
			this.decorations = buildInlineAttachmentDecorations(update.view);
		}
	}
}

const inlineAttachmentPlugin = ViewPlugin.fromClass(InlineAttachmentPlugin, {
	decorations: v => v.decorations,
});

const inlineAttachmentAtomicRanges = EditorView.atomicRanges.of(view => {
	const plugin = view.plugin(inlineAttachmentPlugin);
	return plugin?.decorations ?? Decoration.none;
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
			// Only trigger if / forms a standalone token boundary.
			if (isBoundaryChar(prevChar)) {
				const token = textBeforeCursor.substring(lastSlash);
				if (/^\/[a-zA-Z0-9_-]*$/.test(token) && token.length > 0) {
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
			if (isBoundaryChar(prevChar)) {
				const filter = textBeforeCursor.substring(lastAt + 1);
				if (/^[a-zA-Z0-9_-]*$/.test(filter)) {
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

export const inlineAttachmentBehavior: Extension = [
	inlineAttachmentPlugin,
	inlineAttachmentKeymap,
	inlineAttachmentAtomicRanges,
];

// Re-export placeholder for convenience
export { cmPlaceholder as placeholder };
