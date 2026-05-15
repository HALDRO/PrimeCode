/**
 * @file useChatEditor — CM6 EditorView lifecycle hook for React
 * @description Creates and manages a CodeMirror 6 EditorView instance.
 *              Uses Compartment for dynamic extension updates without remounting.
 */

import {
	Annotation,
	Compartment,
	EditorState,
	type Extension,
	Transaction,
} from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type RefObject, useEffect, useRef } from 'react';

const controlledSyncAnnotation = Annotation.define<boolean>();

function getMinimalDocChange(current: string, next: string) {
	let start = 0;
	const sharedLength = Math.min(current.length, next.length);
	while (start < sharedLength && current[start] === next[start]) start++;
	if (start === current.length && start === next.length) return null;

	let currentEnd = current.length;
	let nextEnd = next.length;
	while (currentEnd > start && nextEnd > start && current[currentEnd - 1] === next[nextEnd - 1]) {
		currentEnd--;
		nextEnd--;
	}

	return {
		from: start,
		to: currentEnd,
		insert: next.slice(start, nextEnd),
	};
}

export interface UseChatEditorOptions {
	containerRef: RefObject<HTMLDivElement | null>;
	initialValue: string;
	onChange: (value: string) => void;
	extensions?: Extension[];
	autoFocus?: boolean;
}

/**
 * Creates a CM6 EditorView on mount, destroys on unmount.
 * Uses Compartment to dynamically reconfigure extensions without destroying the editor.
 */
export function useChatEditor(options: UseChatEditorOptions): RefObject<EditorView | null> {
	const viewRef = useRef<EditorView | null>(null);
	const compartmentRef = useRef(new Compartment());
	const onChangeRef = useRef(options.onChange);
	const autoFocusRef = useRef(options.autoFocus);

	useEffect(() => {
		onChangeRef.current = options.onChange;
	}, [options.onChange]);

	useEffect(() => {
		autoFocusRef.current = options.autoFocus;
	}, [options.autoFocus]);

	// Stable refs for values that should NOT trigger EditorView re-creation
	const initialValueRef = useRef(options.initialValue);
	const extensionsRef = useRef(options.extensions);

	// Create EditorView once on mount, destroy on unmount.
	// initialValue and extensions are intentionally excluded from deps —
	// initialValue is only for the first render (synced via useSyncEditorValue),
	// extensions are dynamically reconfigured via Compartment in a separate useEffect.
	useEffect(() => {
		const container = options.containerRef.current;
		if (!container) return;

		const updateListener = EditorView.updateListener.of(update => {
			if (update.docChanged) {
				if (
					update.transactions.some(transaction => transaction.annotation(controlledSyncAnnotation))
				) {
					return;
				}
				onChangeRef.current(update.state.doc.toString());
			}
		});

		const view = new EditorView({
			state: EditorState.create({
				doc: initialValueRef.current,
				extensions: [
					updateListener,
					EditorView.lineWrapping,
					// Wrap external extensions in compartment for reactive reconfiguration
					compartmentRef.current.of(extensionsRef.current ?? []),
				],
			}),
			parent: container,
		});

		viewRef.current = view;
		if (autoFocusRef.current) {
			requestAnimationFrame(() => view.focus());
		}

		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [options.containerRef]);

	// Dynamically reconfigure extensions via Compartment (no editor re-creation)
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		view.dispatch({
			effects: compartmentRef.current.reconfigure(options.extensions ?? []),
		});
	}, [options.extensions]);

	return viewRef;
}

/**
 * Sync an external value into CM6 (for controlled mode).
 * Only dispatches when the external value differs from CM6's doc.
 * Moves cursor to end of new text — external updates (slash command selection,
 * prompt improver, etc.) always expect the cursor at the end.
 */
export function useSyncEditorValue(viewRef: RefObject<EditorView | null>, value: string): void {
	useEffect(() => {
		const view = viewRef.current;
		if (!view) return;
		const current = view.state.doc.toString();
		const change = getMinimalDocChange(current, value);
		if (!change) return;
		view.dispatch({
			changes: change,
			annotations: [controlledSyncAnnotation.of(true), Transaction.addToHistory.of(false)],
		});
	}, [value, viewRef]);
}
