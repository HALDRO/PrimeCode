import type React from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
	variant?: 'default' | 'ghost';
	isResizable?: boolean;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(
	({ variant = 'default', isResizable = false, style, className, ...props }, ref) => {
		return (
			<textarea
				ref={ref}
				className={cn(
					'w-full box-border bg-transparent border-none outline-none font-(family-name:--vscode-font-family) text-vscode-font-size leading-normal wrap-break-word overflow-anywhere text-input-text',
					isResizable ? 'resize-y' : 'resize-none',
					className,
				)}
				style={style}
				{...props}
			/>
		);
	},
);

TextArea.displayName = 'TextArea';
