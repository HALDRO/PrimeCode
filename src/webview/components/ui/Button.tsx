/**
 * @file Button - reusable button components
 * @description Provides Button and IconButton components with consistent styling.
 *              Uses CSS classes for hover states instead of useState to avoid unnecessary re-renders.
 *              Supports multiple variants (primary, secondary, ghost, icon, danger, tool) and sizes.
 *              Automatically wraps buttons with Tooltip when title prop is provided.
 */

import { cva, type VariantProps } from 'class-variance-authority';
import type React from 'react';
import { cn } from '../../lib/cn';
import { Tooltip, type TooltipPosition } from './Tooltip';

export const buttonVariants = cva(
	'inline-flex items-center justify-center gap-(--gap-1-5) font-medium rounded cursor-pointer transition-colors duration-200 select-none border border-transparent font-(family-name:--vscode-font-family) focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:opacity-50 disabled:cursor-not-allowed',
	{
		variants: {
			variant: {
				primary:
					'bg-vscode-button-background text-vscode-button-foreground hover:bg-vscode-button-hoverBackground',
				secondary:
					'bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground hover:bg-vscode-button-secondaryHoverBackground',
				ghost: 'bg-transparent text-vscode-foreground hover:bg-(--alpha-10)',
				danger: 'bg-error text-white hover:opacity-90',
				tool: 'bg-transparent text-vscode-foreground hover:bg-(--alpha-10) rounded-md',
				icon: 'bg-transparent text-vscode-icon-foreground hover:bg-(--alpha-10) rounded-md p-(--gap-1)',
			},
			size: {
				xs: 'text-xs h-(--btn-height-xs) px-(--gap-1)',
				sm: 'text-sm h-(--btn-height-sm) px-(--gap-2-5)',
				md: 'text-base h-(--btn-height-md) px-(--gap-3)',
				icon: 'h-(--icon-btn-md) w-(--icon-btn-md) p-0 justify-center',
			},
			fullWidth: {
				true: 'w-full',
				false: '',
			},
		},
		defaultVariants: {
			variant: 'primary',
			size: 'md',
			fullWidth: false,
		},
	},
);

export type ButtonVariantProps = VariantProps<typeof buttonVariants>;

interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		Omit<ButtonVariantProps, 'fullWidth'> {
	icon?: React.ReactNode;
	title?: string;
	tooltipPosition?: TooltipPosition;
	fullWidth?: boolean;
	width?: string | number;
	height?: string | number;
}

export const Button: React.FC<ButtonProps> = ({
	variant,
	size,
	icon,
	children,
	style,
	disabled,
	fullWidth,
	width,
	height,
	className,
	title,
	tooltipPosition = 'top',
	...props
}) => {
	const customStyles = {
		...(width && { '--btn-width': typeof width === 'number' ? `${width}px` : width }),
		...(height && { '--btn-height': typeof height === 'number' ? `${height}px` : height }),
		...style,
	} as React.CSSProperties;

	const button = (
		<button
			type="button"
			className={cn(
				buttonVariants({ variant, size, fullWidth }),
				width && 'w-(--btn-width)',
				height && 'h-(--btn-height)',
				className,
			)}
			style={Object.keys(customStyles).length > 0 ? customStyles : undefined}
			disabled={disabled}
			{...props}
		>
			{icon}
			{children}
		</button>
	);

	if (title) {
		return (
			<Tooltip content={title} position={tooltipPosition} delay={200}>
				{button}
			</Tooltip>
		);
	}

	return button;
};

/** Compact icon-only button for toolbars and inline actions */
type IconButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | number;

interface IconButtonProps extends Omit<ButtonProps, 'variant' | 'size' | 'children'> {
	icon: React.ReactNode;
	size?: IconButtonSize;
	danger?: boolean;
}

/** Icon button size mapping to CSS variables */
const ICON_BUTTON_SIZE_VARS: Record<string, string> = {
	xs: 'var(--icon-btn-xs)',
	sm: 'var(--icon-btn-sm)',
	md: 'var(--icon-btn-md)',
	lg: 'var(--icon-btn-lg)',
	xl: 'var(--icon-btn-lg)', // xl uses lg for now
};

export const IconButton: React.FC<IconButtonProps> = ({
	size = 'md',
	danger = false,
	icon,
	style,
	className,
	title,
	tooltipPosition = 'top',
	...props
}) => {
	const sizeValue = typeof size === 'number' ? `${size}px` : ICON_BUTTON_SIZE_VARS[size];

	const classes = cn(
		'inline-flex items-center justify-center rounded cursor-pointer transition-all duration-150 bg-transparent border-none p-0',
		danger
			? 'text-error hover:bg-error/15'
			: 'text-vscode-icon-foreground hover:bg-(--header-item-hover) hover:text-vscode-foreground',
		className,
	);

	const button = (
		<button
			type="button"
			className={classes}
			style={{
				width: sizeValue,
				height: sizeValue,
				...style,
			}}
			{...props}
		>
			{icon}
		</button>
	);

	if (title) {
		return (
			<Tooltip content={title} position={tooltipPosition} delay={200}>
				{button}
			</Tooltip>
		);
	}

	return button;
};
