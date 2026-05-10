/**
 * @file Compact text input primitive
 * @description Provides the shared VS Code themed input used across settings forms. The control keeps
 *              a fixed box model and line height so dense settings rows align labels and inputs reliably.
 */

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
			'block box-border w-(--input-width-sm) h-(--field-height) min-h-(--field-height) px-(--control-padding-x) py-0 text-sm leading-[var(--field-line-height)] bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded-(--control-radius) outline-none',
			'focus:border-vscode-focusBorder',
			className,
		)}
		style={style}
		onFocus={onFocus}
		onBlur={onBlur}
	/>
);
