import type React from 'react';
import { cn } from '../../lib/cn';

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const TextInput: React.FC<TextInputProps> = ({
	style,
	className,
	onFocus,
	onBlur,
	...props
}) => (
	<input
		{...props}
		className={cn(
			'w-(--input-width-sm) px-2 py-(--gap-1) text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-sm outline-none h-6',
			'focus:border-vscode-focusBorder',
			className,
		)}
		style={style}
		onFocus={onFocus}
		onBlur={onBlur}
	/>
);
