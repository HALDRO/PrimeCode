/**
 * @file EditorCore — CM6 React wrapper component
 * @description Thin wrapper around CodeMirror 6 EditorView for use in ChatInput.
 *              Exposes EditorView via forwardRef for precise text manipulation.
 */

import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import React, { useImperativeHandle, useMemo, useRef } from 'react';
import { useChatEditor, useSyncEditorValue } from '../../hooks/useChatEditor';
import { cn } from '../../lib/cn';
import { chatTheme, placeholder } from '.';

export interface EditorCoreRef {
	view: EditorView | null;
}

interface EditorCoreProps {
	value: string;
	onChange: (value: string) => void;
	placeholderText?: string;
	autoFocus?: boolean;
	extensions?: Extension[];
	className?: string;
}

export const EditorCore = React.forwardRef<EditorCoreRef, EditorCoreProps>(
	(
		{ value, onChange, placeholderText, autoFocus, extensions: extraExtensions, className },
		ref,
	) => {
		const containerRef = useRef<HTMLDivElement>(null);

		const extensions = useMemo(
			() => [
				chatTheme,
				...(placeholderText ? [placeholder(placeholderText)] : []),
				...(extraExtensions ?? []),
			],
			[placeholderText, extraExtensions],
		);

		const viewRef = useChatEditor({
			containerRef,
			initialValue: value,
			onChange,
			extensions,
			autoFocus,
		});

		useImperativeHandle(ref, () => ({
			get view() {
				return viewRef.current;
			},
		}));

		useSyncEditorValue(viewRef, value);

		return <div ref={containerRef} className={cn('cm-chat-editor w-full min-w-0', className)} />;
	},
);
EditorCore.displayName = 'EditorCore';
