/**
 * @file useChatEditor — CM6 EditorView lifecycle hook for React
 * @description Creates and manages a CodeMirror 6 EditorView instance.
 *              Uses Compartment for dynamic extension updates without remounting.
 */

import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { type RefObject, useEffect, useRef } from 'react';

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

	useEffect(() => {
		onChangeRef.current = options.onChange;
	}, [options.onChange]);

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
		if (options.autoFocus) {
			requestAnimationFrame(() => view.focus());
		}

		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [options.autoFocus, options.containerRef]);

	// Dynamically reconfigure extensions via Compartment (no editor re-creation)
	useEffect(() => {
		if (viewRef.current && options.extensions) {
			viewRef.current.dispatch({
				effects: compartmentRef.current.reconfigure(options.extensions),
			});
		}
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
		if (current !== value) {
			view.dispatch({
				changes: { from: 0, to: current.length, insert: value },
				selection: { anchor: value.length },
			});
		}
	}, [value, viewRef]);
}
