import type React from 'react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

export type SegmentedControlOption<T extends string> = {
	value: T;
	label: string;
	title?: string;
};

type SegmentedControlProps<T extends string> = {
	value: T;
	options: SegmentedControlOption<T>[];
	onChange: (value: T) => void;
	ariaLabel: string;
	className?: string;
};

export function SegmentedControl<T extends string>({
	value,
	options,
	onChange,
	ariaLabel,
	className,
}: SegmentedControlProps<T>): React.ReactElement {
	const idPrefix = useId();

	return (
		<div
			role="radiogroup"
			aria-label={ariaLabel}
			className={cn('inline-flex items-center gap-1', className)}
		>
			{options.map(option => {
				const selected = option.value === value;
				const id = `${idPrefix}-${option.value}`;
				return (
					<div key={option.value} className="relative">
						<input
							id={id}
							type="radio"
							name={idPrefix}
							checked={selected}
							onChange={() => onChange(option.value)}
							className="peer sr-only"
						/>
						<label
							htmlFor={id}
							title={option.title}
							className={cn(
								'flex min-h-[18px] min-w-9 cursor-pointer items-center justify-center rounded-md border px-2 py-px text-[11px] leading-[14px] font-medium transition-colors',
								'peer-focus-visible:ring-1 peer-focus-visible:ring-vscode-focusBorder',
								!selected && 'hover:text-vscode-foreground',
							)}
							style={getSegmentStyle(option.value, selected)}
						>
							{option.label}
						</label>
					</div>
				);
			})}
		</div>
	);
}

function getSegmentStyle(value: string, selected: boolean): React.CSSProperties {
	const color = getSegmentColor(value);
	if (!selected) {
		return {
			backgroundColor: 'color-mix(in srgb, var(--surface-base) 92%, var(--vscode-foreground) 8%)',
			borderColor: 'color-mix(in srgb, var(--surface-base) 84%, var(--vscode-foreground) 16%)',
			color: 'var(--vscode-descriptionForeground)',
		};
	}

	return {
		backgroundColor: `color-mix(in srgb, var(--surface-base) 86%, ${color} 14%)`,
		borderColor: `color-mix(in srgb, var(--surface-base) 70%, ${color} 30%)`,
		color,
	};
}

function getSegmentColor(value: string): string {
	switch (value) {
		case 'allow':
			return 'var(--color-success)';
		case 'ask':
			return 'var(--color-warning)';
		case 'deny':
			return 'var(--color-error)';
		default:
			return 'var(--vscode-foreground)';
	}
}
