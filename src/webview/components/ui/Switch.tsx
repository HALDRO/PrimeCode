import type React from 'react';
import { cn } from '../../lib/cn';

interface SwitchProps {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	className?: string;
	style?: React.CSSProperties;
}

export const Switch: React.FC<SwitchProps> = ({
	checked,
	onChange,
	disabled,
	className,
	style,
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		onClick={() => !disabled && onChange(!checked)}
		disabled={disabled}
		className={cn(
			'relative inline-flex items-center justify-start p-0 border-none outline-none transition-colors duration-200 rounded-full shrink-0',
			'w-(--switch-width) h-(--switch-height) min-w-(--switch-width) min-h-(--switch-height)',
			checked ? 'bg-(--color-accent)' : 'bg-(--alpha-10) hover:bg-(--alpha-15)',
			disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer',
			className,
		)}
		style={style}
	>
		<div
			className={cn(
				'bg-white rounded-full shadow-[0_1px_2px_rgba(0,0,0,0.3)] transition-transform duration-200 ease-out',
				'w-(--switch-thumb) h-(--switch-thumb)',
				checked ? 'translate-x-[14px]' : 'translate-x-(--switch-thumb-offset)',
			)}
		/>
	</button>
);
