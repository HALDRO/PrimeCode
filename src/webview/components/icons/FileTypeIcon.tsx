import { useState } from 'react';
import { getIconForFile, getIconForFolder, getIconForOpenFolder } from 'vscode-icons-js';

const ICONS_CDN_BASE = 'https://raw.githubusercontent.com/vscode-icons/vscode-icons/master/icons/';

interface FileTypeIconProps {
	name: string;
	size?: number;
	isFolder?: boolean;
	isOpen?: boolean;
	className?: string;
}

const FallbackIcon: React.FC<{ size: number; isFolder: boolean }> = ({ size, isFolder }) => (
	<svg
		width={size}
		height={size}
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.5"
		strokeLinecap="round"
		strokeLinejoin="round"
		aria-hidden="true"
		style={{ opacity: 0.7 }}
	>
		{isFolder ? (
			<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
		) : (
			<>
				<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
				<polyline points="14 2 14 8 20 8" />
			</>
		)}
	</svg>
);

export const FileTypeIcon: React.FC<FileTypeIconProps> = ({
	name,
	size = 16,
	isFolder = false,
	isOpen = false,
	className,
}) => {
	const [hasError, setHasError] = useState(false);

	let iconFileName: string | undefined;
	if (isFolder) {
		iconFileName = isOpen ? getIconForOpenFolder(name) : getIconForFolder(name);
	} else {
		iconFileName = getIconForFile(name);
	}

	if (hasError || !iconFileName) {
		return <FallbackIcon size={size} isFolder={isFolder} />;
	}

	const iconUrl = `${ICONS_CDN_BASE}${iconFileName}`;

	if (hasError) {
		return <FallbackIcon size={size} isFolder={isFolder} />;
	}

	return (
		<img
			src={iconUrl}
			alt=""
			width={size}
			height={size}
			className={className}
			style={{
				display: 'inline-block',
				verticalAlign: 'middle',
				flexShrink: 0,
			}}
			onError={() => setHasError(true)}
			loading="lazy"
		/>
	);
};

export default FileTypeIcon;
