/**
 * @file useFileAttachments
 * @description Webview hook that manages message attachments: file references, images, and code snippets.
 *              Intercepts paste/drag-drop events, requests clipboard context from the extension,
 *              and exposes stable handlers/state for the chat input.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVSCode } from '../utils/vscode';

export interface CodeSnippet {
	id: string;
	filePath: string;
	startLine: number;
	endLine: number;
	content: string;
}

export interface AttachedImage {
	id: string;
	name: string;
	dataUrl: string;
	file?: File;
	path?: string;
}

export interface UseFileAttachmentsOptions {
	initialFiles?: string[];
	initialCodeSnippets?: Array<{
		filePath: string;
		startLine: number;
		endLine: number;
		content: string;
	}>;
	initialImages?: Array<{
		id: string;
		name: string;
		dataUrl: string;
		path?: string;
	}>;
}

export function useFileAttachments(options: UseFileAttachmentsOptions = {}) {
	const { initialFiles = [], initialCodeSnippets = [], initialImages = [] } = options;
	const { postMessage } = useVSCode();
	const [attachedFiles, setAttachedFiles] = useState<string[]>(initialFiles);
	const [attachedImages, setAttachedImages] = useState<AttachedImage[]>(
		initialImages.map(img => ({ ...img, file: undefined })),
	);
	const [codeSnippets, setCodeSnippets] = useState<CodeSnippet[]>(
		initialCodeSnippets.map(s => ({
			...s,
			id: `${s.filePath}:${s.startLine}-${s.endLine}`,
		})),
	);
	const [isDragOver, setIsDragOver] = useState(false);

	// Handlers for managing attachments
	const addFile = useCallback((filePath: string) => {
		setAttachedFiles(prev => {
			if (prev.includes(filePath)) {
				return prev;
			}
			return [...prev, filePath];
		});
	}, []);

	const removeFile = useCallback((filePath: string) => {
		setAttachedFiles(prev => prev.filter(f => f !== filePath));
	}, []);

	const removeImage = useCallback((id: string) => {
		setAttachedImages(prev => prev.filter(img => img.id !== id));
	}, []);

	const removeCodeSnippet = useCallback((id: string) => {
		setCodeSnippets(prev => prev.filter(s => s.id !== id));
	}, []);

	const clearAll = useCallback(() => {
		setAttachedFiles([]);
		setAttachedImages([]);
		setCodeSnippets([]);
	}, []);

	// Drag & Drop handlers
	const handleDragOver = useCallback((e: React.DragEvent) => {
		if (!e.shiftKey) {
			setIsDragOver(false);
			return;
		}
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(true);
		e.dataTransfer.dropEffect = 'copy';
	}, []);

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault();
		e.stopPropagation();
		setIsDragOver(false);
	}, []);

	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			e.stopPropagation();
			setIsDragOver(false);

			// Handle images
			const files = e.dataTransfer.files;
			if (files && files.length > 0) {
				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					if (file.type.startsWith('image/')) {
						const reader = new FileReader();
						reader.onload = e => {
							const dataUrl = e.target?.result as string;
							if (dataUrl) {
								const id = `img-${Date.now()}-${file.name}`;
								setAttachedImages(prev => [...prev, { id, name: file.name, dataUrl, file }]);
							}
						};
						reader.readAsDataURL(file);
					}
				}
			}

			// Handle text (file paths)
			const textPlain = e.dataTransfer.getData('text');
			const textUriList = e.dataTransfer.getData('application/vnd.code.uri-list');
			const text = textPlain || textUriList;

			if (text) {
				const lines = text.split(/\r?\n/).filter(line => line.trim() !== '');
				for (const line of lines) {
					// Check for images passed as paths
					const lowerLine = line.toLowerCase();
					if (lowerLine.match(/\.(png|jpg|jpeg|gif|webp|svg|bmp|ico)$/)) {
						const name = line.split(/[/\\]/).pop() || 'image';
						const id = `img-${Date.now()}-${name}`;
						postMessage('getImageData', { path: line, id, name });
						continue;
					}

					// Regular files
					let processedPath = line;
					if (processedPath.startsWith('file://')) {
						processedPath = processedPath.substring(7);
					}
					// Add simple normalization if needed...
					addFile(processedPath);
				}
			}
		},
		[addFile, postMessage],
	);

	// Pending paste text - used when waiting for clipboard context response
	const [pendingPasteText, setPendingPasteText] = useState<string | null>(null);

	// Paste handler
	const handlePaste = useCallback(
		(e: React.ClipboardEvent) => {
			const clipboardData = e.clipboardData;
			if (!clipboardData) {
				return;
			}

			// Images
			const items = clipboardData.items;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.type.startsWith('image/')) {
					e.preventDefault();
					const file = item.getAsFile();
					if (file) {
						const reader = new FileReader();
						reader.onload = e => {
							const dataUrl = e.target?.result as string;
							if (dataUrl) {
								const id = `img-${Date.now()}-${file.name}`;
								setAttachedImages(prev => [...prev, { id, name: file.name, dataUrl, file }]);
							}
						};
						reader.readAsDataURL(file);
					}
					return;
				}
			}

			// Code snippets - always try to get context from extension
			// Extension tracks copy events and can match pasted text to source file
			const textPlain = clipboardData.getData('text/plain');

			if (textPlain?.trim()) {
				// Check if it looks like code (multiline or has code patterns)
				const lines = textPlain.split('\n');
				const isMultiline = lines.length > 1;
				const hasIndentation = lines.some(line => /^\s{2,}/.test(line));
				const hasCodePatterns =
					/^(import|export|const|let|var|function|class|interface|type|if|for|while|return|async|await|def |from |#include)\b/.test(
						textPlain.trim(),
					);

				if (isMultiline || hasIndentation || hasCodePatterns) {
					// Prevent default paste - we'll handle it based on context response
					e.preventDefault();
					// Store the text in case context is not found
					setPendingPasteText(textPlain);
					// Request context from extension
					postMessage('getClipboardContext', { text: textPlain });
				}
			}
		},
		[postMessage],
	);

	// Listen for extension messages regarding attachments
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const message = event.data;

			if (message?.type === 'clipboardContext' && message.filePath) {
				// Context found - add as code snippet badge
				const id = `${message.filePath}:${message.startLine}-${message.endLine}:${Date.now()}`;
				setCodeSnippets(prev => [
					...prev,
					{
						id,
						filePath: message.filePath,
						startLine: message.startLine,
						endLine: message.endLine,
						content: message.content,
					},
				]);
				// Clear pending paste text since we created a badge
				setPendingPasteText(null);
			}

			if (message?.type === 'clipboardContextNotFound') {
				// Context not found - don't clear pendingPasteText here
				// Let the timeout in ChatInput handle the fallback insertion
				// We just need to signal that context lookup is complete
			}

			if (message?.type === 'imageData' && message.dataUrl) {
				const id = message.id || `img-${Date.now()}`;
				const name = message.name || 'image.png';
				setAttachedImages(prev => [
					...prev,
					{ id, name, dataUrl: message.dataUrl, path: message.path },
				]);
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, []);

	return {
		attachedFiles,
		attachedImages,
		codeSnippets,
		pendingPasteText,
		isDragOver,
		addFile,
		removeFile,
		removeImage,
		removeCodeSnippet,
		clearAll,
		clearPendingPaste: () => setPendingPasteText(null),
		handleDragOver,
		handleDragLeave,
		handleDrop,
		handlePaste,
	};
}
