/**
 * @file FilePickerDropdown - Workspace file picker
 * @description Uses universal DropdownMenu for consistent styling. Shows workspace files
 *              with type icons and keyboard navigation. The owning ChatInput provides the
 *              transient search/open state so multiple editor instances do not mirror each
 *              other's @-trigger UI while still reusing shared workspace file results.
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspaceFile } from '../../store';
import { useUIStore } from '../../store';
import { vscode } from '../../utils/vscode';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { type AnchorRectLike, DropdownMenu, type DropdownMenuItem } from '../ui';

interface FilePickerDropdownProps {
	onSelectFile: (filePath: string) => void;
	/** Optional anchor element for positioning */
	anchorElement?: HTMLElement | null;
	/** Optional explicit anchor rect override (e.g. caret position). */
	anchorRect?: AnchorRectLike | null;
	fileFilter: string;
	setFileFilter: (value: string) => void;
	onClose: () => void;
	/** Show a search input inside the dropdown */
	showSearch?: boolean;
	/** Autofocus the dropdown search input when shown */
	searchAutoFocus?: boolean;
	/** When true, the dropdown search input mirrors fileFilter and is read-only (typing happens in textarea) */
	searchReadOnly?: boolean;
}

export const FilePickerDropdown: React.FC<FilePickerDropdownProps> = ({
	onSelectFile,
	anchorElement,
	anchorRect,
	fileFilter,
	setFileFilter,
	onClose,
	showSearch = false,
	searchAutoFocus = false,
	searchReadOnly = false,
}) => {
	const workspaceFiles = useUIStore(state => state.workspaceFiles);
	const [isLoading, setIsLoading] = useState(true);
	const requestIdRef = useRef(0);

	useEffect(() => {
		setIsLoading(true);
		requestIdRef.current += 1;
		vscode.postMessage({ type: 'getWorkspaceFiles', searchTerm: fileFilter || '' });
		const timeout = setTimeout(() => setIsLoading(false), 500);
		return () => clearTimeout(timeout);
	}, [fileFilter]);

	useEffect(() => {
		if (workspaceFiles.length > 0) {
			setIsLoading(false);
		}
	}, [workspaceFiles]);

	const handleSelect = useCallback(
		(file: WorkspaceFile) => {
			onSelectFile(file.path);
			onClose();
		},
		[onSelectFile, onClose],
	);

	const items = useMemo(
		(): DropdownMenuItem<WorkspaceFile>[] =>
			workspaceFiles.map(file => ({
				id: file.path,
				label: file.name,
				icon: <FileTypeIcon name={file.name} size={14} />,
				data: file,
			})),
		[workspaceFiles],
	);

	return (
		<DropdownMenu
			items={items}
			onSelect={handleSelect}
			onClose={onClose}
			keyHints={{}}
			loading={isLoading}
			emptyMessage={fileFilter ? `No files matching "${fileFilter}"` : 'No files found'}
			searchable={showSearch}
			searchPlaceholder="Search files..."
			searchValue={fileFilter}
			onSearchChange={value => setFileFilter(value)}
			searchAutoFocus={searchAutoFocus}
			searchReadOnly={searchReadOnly}
			position="top"
			minWidth={280}
			maxWidth={340}
			maxHeight={360}
			maxHeightVh={40}
			anchorElement={anchorElement}
			anchorRect={anchorRect}
		/>
	);
};
