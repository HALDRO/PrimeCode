import type React from 'react';
import { useEffect, useState } from 'react';
import {
	useActiveModal,
	useChatInputState,
	useUIActions,
	useWorkspaceFiles,
	type WorkspaceFile,
} from '../../store';
import { useVSCode } from '../../utils/vscode';
import { FileTypeIcon } from '../icons/FileTypeIcon';
import { ScrollContainer, TextInput } from '../ui';
import { Modal } from './Modal';

export const FilePicker: React.FC = () => {
	// Optimized selectors
	const activeModal = useActiveModal();
	const { setActiveModal } = useUIActions();
	const workspaceFiles = useWorkspaceFiles();
	const { input, setInput } = useChatInputState();
	const { postMessage } = useVSCode();
	const [search, setSearch] = useState('');

	const isOpen = activeModal === 'filePicker';

	useEffect(() => {
		if (isOpen) {
			postMessage('getWorkspaceFiles', { searchTerm: '' });
			setSearch('');

			setTimeout(() => {
				document.getElementById('file-picker-search')?.focus();
			}, 100);
		}
	}, [isOpen, postMessage]);

	const handleSearchChange = (value: string) => {
		setSearch(value);
		postMessage('getWorkspaceFiles', { searchTerm: value });
	};

	const handleSelect = (file: WorkspaceFile) => {
		const newInput = input ? `${input} @${file.path} ` : `@${file.path} `;
		setInput(newInput);
		setActiveModal(null);

		setTimeout(() => {
			document.querySelector('textarea')?.focus();
		}, 100);
	};

	return (
		<Modal
			title="Select File"
			isOpen={isOpen}
			onClose={() => setActiveModal(null)}
			width="var(--modal-width-sm)"
		>
			<div className="flex flex-col h-(--modal-content-height)">
				<div className="mb-(--gap-6)">
					<TextInput
						id="file-picker-search"
						value={search}
						onChange={e => handleSearchChange(e.target.value)}
						placeholder="Search files..."
						style={{ width: '100%' }}
					/>
				</div>

				<ScrollContainer className="flex-1 max-h-(--modal-content-height)">
					{workspaceFiles.length === 0 ? (
						<div className="p-(--gap-4) text-center text-vscode-descriptionForeground">
							{search ? 'No files found matching your search.' : 'Loading files...'}
						</div>
					) : (
						<div className="flex flex-col gap-(--spacing-px)">
							{workspaceFiles.map((file, i) => (
								<div
									key={file.path || i}
									className="flex items-center p-(--gap-4) pl-(--gap-6) cursor-pointer rounded-md text-base gap-(--gap-4) transition-colors hover:bg-vscode-list-hoverBackground"
									onClick={() => handleSelect(file)}
								>
									<FileTypeIcon name={file.name} size={16} />
									<div className="flex-1 overflow-hidden min-w-0">
										<div className="font-medium text-vscode-foreground whitespace-nowrap overflow-hidden text-ellipsis">
											{file.name}
										</div>
										<div className="text-sm text-vscode-descriptionForeground whitespace-nowrap overflow-hidden text-ellipsis opacity-80">
											{file.path}
										</div>
									</div>
								</div>
							))}
						</div>
					)}
				</ScrollContainer>

				<div className="mt-(--gap-6) pt-(--gap-6) border-t border-vscode-panel-border text-sm text-vscode-descriptionForeground flex justify-between">
					<span>Click to add file reference to your message</span>
					<span>{workspaceFiles.length} files</span>
				</div>
			</div>
		</Modal>
	);
};
