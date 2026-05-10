/**
 * @file Compact select primitive
 * @description Renders a VS Code themed dropdown trigger backed by the shared DropdownMenu. The trigger
 *              uses the same fixed control metrics as inputs so settings rows stay vertically aligned.
 */

import type React from 'react';
import { useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { ChevronDownIcon } from '../icons';
import { DropdownMenu } from './Dropdown';
import { GlowDot } from './GlowDot';

interface SelectProps {
	value: string;
	onChange: (e: { target: { value: string } }) => void;
	options: { value: string; label: string }[];
	className?: string;
	style?: React.CSSProperties;
	disabled?: boolean;
}

export const Select: React.FC<SelectProps> = ({
	value,
	onChange,
	options,
	className,
	style,
	disabled,
}) => {
	const [isOpen, setIsOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement>(null);

	const selectedOption = options.find(opt => opt.value === value) || options[0];

	return (
		<>
			<button
				ref={triggerRef}
				type="button"
				disabled={disabled}
				onClick={() => setIsOpen(!isOpen)}
				className={cn(
					'flex items-center justify-between box-border gap-(--gap-2) h-(--field-height) min-h-(--field-height) min-w-(--select-min-width) px-(--control-padding-x) py-0 rounded-(--control-radius) bg-(--alpha-5) border border-(--alpha-10) text-sm leading-none text-(--alpha-90) cursor-pointer outline-none transition-all duration-200',
					'hover:bg-(--alpha-8) hover:border-(--alpha-20)',
					isOpen && 'border-(--color-accent)/50 bg-(--alpha-10) ring-1 ring-(--color-accent)/20',
					disabled && 'opacity-40 cursor-not-allowed',
					className,
				)}
				style={style}
			>
				<span className="truncate leading-none">{selectedOption?.label}</span>
				<ChevronDownIcon
					size={12}
					className={cn(
						'opacity-40 transition-transform duration-200',
						isOpen && 'rotate-180 opacity-80',
					)}
				/>
			</button>

			{isOpen && (
				<DropdownMenu
					anchorElement={triggerRef.current}
					onClose={() => setIsOpen(false)}
					minWidth={triggerRef.current?.offsetWidth || 120}
					maxWidth={400}
					keyHints={{ navigate: true, select: true, close: true }}
					items={options.map(opt => ({
						id: opt.value,
						label: opt.label,
						data: opt.value,
					}))}
					onSelect={val => {
						onChange({ target: { value: val as string } });
						setIsOpen(false);
					}}
					renderItem={(item, { hovered, onSelect, onHover }) => {
						const isSelected = item.data === value;
						return (
							<div
								key={item.id}
								onClick={onSelect}
								onMouseEnter={onHover}
								className={cn(
									'flex items-center px-(--gap-3) py-0 my-px rounded-md cursor-pointer h-(--dropdown-item-height) text-sm leading-[1.25] transition-colors hover:bg-(--alpha-8)',
									hovered ? 'bg-(--alpha-10) text-vscode-foreground' : 'text-(--alpha-70)',
									isSelected && 'text-(--color-accent) font-medium bg-(--color-accent)/10',
								)}
							>
								<span className="flex-1 whitespace-nowrap leading-[1.2]">{item.label}</span>
								{isSelected && (
									<div className="shrink-0 ml-(--gap-2)">
										<GlowDot color="var(--color-accent)" glow="var(--color-accent-glow)" size={4} />
									</div>
								)}
							</div>
						);
					}}
				/>
			)}
		</>
	);
};
