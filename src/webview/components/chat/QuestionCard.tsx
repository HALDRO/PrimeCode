/**
 * @file Question card component
 * @description Step-by-step carousel for OpenCode question tool prompts.
 * Inspired by VS Code Copilot Chat's ChatResponseQuestionCarouselPart.
 * Shows one question at a time with radio/checkbox options, always-visible
 * "Other" free-text input, step indicator, and back/next/skip navigation.
 */

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { cn } from '../../lib/cn';
import { useChatActions } from '../../store';
import type { Message } from '../../store/chatStore';
import { useSessionMessage } from '../../utils/vscode';
import { CheckIcon, ChevronDownIcon, CloseIcon } from '../icons';
import { GlowDot } from '../ui';

type QuestionMessage = Extract<Message, { type: 'question' }>;

interface QuestionCardProps {
	message: QuestionMessage;
}

/* ------------------------------------------------------------------ */
/*  Resolved (collapsed) state                                        */
/* ------------------------------------------------------------------ */

const ResolvedSummary: React.FC<{ answers?: string[][] }> = ({ answers }) => {
	const summary = answers
		? answers
				.map(a => a.join(', '))
				.filter(Boolean)
				.join(' · ') || 'Dismissed'
		: 'Dismissed';

	return (
		<div className="flex items-center gap-1.5 py-px ml-0.5">
			<GlowDot color="var(--color-success)" glow="var(--glow-success)" />
			<span className="text-sm leading-none text-vscode-foreground opacity-70 truncate">
				{summary}
			</span>
		</div>
	);
};

/* ------------------------------------------------------------------ */
/*  Option button (radio / checkbox style)                            */
/* ------------------------------------------------------------------ */

const OptionButton: React.FC<{
	label: string;
	description?: string;
	selected: boolean;
	multiple: boolean;
	recommended?: boolean;
	onClick: () => void;
}> = ({ label, description, selected, multiple, recommended, onClick }) => (
	<button
		type="button"
		onClick={onClick}
		className={cn(
			'group/opt flex items-center gap-2.5 w-full text-left',
			'px-2.5 py-1.5 rounded-md border transition-all duration-150',
			'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
			selected
				? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]/8'
				: 'border-(--tool-border-color) bg-transparent hover:bg-(--alpha-5)',
		)}
	>
		{/* indicator */}
		<span
			className={cn(
				'flex items-center justify-center shrink-0 transition-colors duration-150',
				'border',
				multiple ? 'w-3.5 h-3.5 rounded-sm' : 'w-3.5 h-3.5 rounded-full',
				selected
					? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]'
					: 'border-(--tool-border-color) bg-transparent group-hover/opt:border-vscode-foreground/40',
			)}
		>
			{selected && (
				<span className={cn(multiple ? 'text-white' : '', 'flex items-center justify-center')}>
					{multiple ? (
						<CheckIcon size={10} />
					) : (
						<span className="block w-1.5 h-1.5 rounded-full bg-white" />
					)}
				</span>
			)}
		</span>

		{/* label + description */}
		<span className="flex flex-col min-w-0 gap-px flex-1">
			<span className="flex items-center gap-1.5">
				<span className="text-sm text-vscode-foreground leading-tight truncate">{label}</span>
				{recommended && (
					<span className="text-[10px] px-1 py-px rounded bg-[var(--vscode-focusBorder)]/15 text-[var(--vscode-focusBorder)] font-medium shrink-0">
						Recommended
					</span>
				)}
			</span>
			{description && (
				<span className="text-xs text-vscode-foreground/50 leading-tight truncate">
					{description}
				</span>
			)}
		</span>
	</button>
);

/* ------------------------------------------------------------------ */
/*  Step dots indicator                                               */
/* ------------------------------------------------------------------ */

const StepDots: React.FC<{ total: number; current: number; onDotClick: (i: number) => void }> = ({
	total,
	current,
	onDotClick,
}) => {
	if (total <= 1) return null;
	return (
		<div className="flex items-center gap-1">
			{Array.from({ length: total }, (_, i) => {
				const dotKey = `step-dot-${String(i)}`;
				return (
					<button
						key={dotKey}
						type="button"
						onClick={() => onDotClick(i)}
						className={cn(
							'w-1.5 h-1.5 rounded-full transition-all duration-200',
							'focus:outline-none',
							i === current
								? 'bg-[var(--vscode-focusBorder)] scale-125'
								: i < current
									? 'bg-vscode-foreground/40'
									: 'bg-vscode-foreground/15',
						)}
						aria-label={`Step ${i + 1}`}
					/>
				);
			})}
		</div>
	);
};

/* ------------------------------------------------------------------ */
/*  Question icon SVG                                                 */
/* ------------------------------------------------------------------ */

const QuestionIcon: React.FC = () => (
	<svg
		width="16"
		height="16"
		viewBox="0 0 16 16"
		fill="currentColor"
		className="text-info"
		role="img"
		aria-label="Question"
	>
		<title>Question</title>
		<path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM6.5 5.5a1.5 1.5 0 1 1 3 0c0 .56-.31 1.05-.77 1.3A1.75 1.75 0 0 0 7.75 8.5v.25a.25.25 0 0 0 .5 0V8.5c0-.52.33-.97.8-1.14A2 2 0 0 0 6.5 5.5ZM8 11.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z" />
	</svg>
);

/* ------------------------------------------------------------------ */
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export const QuestionCard: React.FC<QuestionCardProps> = ({ message }) => {
	const { requestId, questions = [], resolved, answers: savedAnswers, id } = message;
	const { postSessionMessage } = useSessionMessage();
	const { updateMessage } = useChatActions();
	const inputRef = useRef<HTMLInputElement>(null);

	const isCarousel = questions.length > 1;
	const [step, setStep] = useState(0);

	const [selections, setSelections] = useState<Set<string>[]>(() =>
		questions.map(() => new Set<string>()),
	);
	const [customInputs, setCustomInputs] = useState<string[]>(() => questions.map(() => ''));

	const toggleOption = useCallback((qIdx: number, label: string, multiple: boolean) => {
		setSelections(prev => {
			const next = [...prev];
			const set = new Set(next[qIdx]);
			if (multiple) {
				if (set.has(label)) set.delete(label);
				else set.add(label);
			} else {
				if (set.has(label)) {
					set.delete(label);
				} else {
					set.clear();
					set.add(label);
				}
			}
			next[qIdx] = set;
			return next;
		});
	}, []);

	const updateCustomInput = useCallback((qIdx: number, value: string) => {
		setCustomInputs(prev => {
			const next = [...prev];
			next[qIdx] = value;
			return next;
		});
	}, []);

	const handleSubmit = useCallback(() => {
		const answers = questions.map((_q, i) => {
			const parts = [...selections[i]];
			const custom = customInputs[i]?.trim();
			if (custom) parts.push(custom);
			return parts;
		});
		postSessionMessage({ type: 'questionResponse', requestId, answers });
		if (id) updateMessage(id, { resolved: true, answers });
	}, [questions, selections, customInputs, requestId, id, postSessionMessage, updateMessage]);

	const handleDismiss = useCallback(() => {
		postSessionMessage({ type: 'questionReject', requestId });
		if (id) updateMessage(id, { resolved: true });
	}, [requestId, id, postSessionMessage, updateMessage]);

	if (resolved) return <ResolvedSummary answers={savedAnswers} />;

	const q = questions[step];
	if (!q) return null;

	const stepHasAnswer =
		(selections[step]?.size ?? 0) > 0 || (customInputs[step]?.trim().length ?? 0) > 0;
	const isLastStep = step === questions.length - 1;
	const canSubmit = selections.some(s => s.size > 0) || customInputs.some(c => c.trim());

	const goNext = () => {
		if (isLastStep) {
			handleSubmit();
		} else {
			setStep(s => Math.min(s + 1, questions.length - 1));
		}
	};

	const goBack = () => setStep(s => Math.max(s - 1, 0));

	return (
		<div className="mb-(--tool-block-margin)">
			<div className="bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden">
				{/* Header */}
				<div className="flex items-center justify-between h-(--tool-header-height) px-(--tool-header-padding)">
					<div className="flex items-center gap-2">
						<span className="flex items-center justify-center w-[18px] h-[18px] shrink-0">
							<QuestionIcon />
						</span>
						<span className="text-sm font-medium text-vscode-foreground">
							{isCarousel ? `Question ${step + 1} of ${questions.length}` : 'Question'}
						</span>
					</div>
					{isCarousel && <StepDots total={questions.length} current={step} onDotClick={setStep} />}
				</div>

				{/* Body — single question at a time */}
				<div className="px-(--tool-content-padding) pb-2">
					{q.header && (
						<div className="text-xs font-medium text-vscode-foreground/50 uppercase tracking-wide mb-1">
							{q.header}
						</div>
					)}
					<div className="text-sm text-vscode-foreground mb-2 whitespace-pre-wrap">
						{q.question}
					</div>

					{q.options.length > 0 && (
						<div className="flex flex-col gap-1 mb-2">
							{q.options.map(opt => (
								<OptionButton
									key={opt.label}
									label={opt.label}
									description={opt.description}
									selected={selections[step]?.has(opt.label) ?? false}
									multiple={!!q.multiple}
									recommended={opt.recommended}
									onClick={() => toggleOption(step, opt.label, !!q.multiple)}
								/>
							))}
						</div>
					)}

					{/* Always-visible "Other" free-text input */}
					<div className="relative">
						<input
							ref={inputRef}
							type="text"
							value={customInputs[step] ?? ''}
							onChange={e => updateCustomInput(step, e.target.value)}
							onKeyDown={e => {
								if (e.key === 'Enter') {
									if (isLastStep && (stepHasAnswer || customInputs[step]?.trim())) {
										handleSubmit();
									} else if (!isLastStep) {
										goNext();
									}
								}
							}}
							placeholder="Other…"
							className={cn(
								'w-full text-sm pl-2.5 pr-8 py-1.5 rounded-md',
								'bg-vscode-input-background border border-(--tool-border-color)',
								'text-vscode-foreground placeholder:text-vscode-foreground/30',
								'outline-none focus:border-[var(--vscode-focusBorder)]',
								'transition-colors duration-150',
							)}
						/>
						{customInputs[step]?.trim() && (
							<button
								type="button"
								onClick={() => updateCustomInput(step, '')}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-vscode-foreground/30 hover:text-vscode-foreground/60"
								aria-label="Clear"
							>
								<CloseIcon size={12} />
							</button>
						)}
					</div>
				</div>

				{/* Footer — navigation + actions */}
				<div className="flex items-center justify-between px-(--tool-content-padding) py-1.5 border-t border-(--tool-border-color)">
					<div className="flex items-center gap-1.5">
						{/* Back button (carousel only) */}
						{isCarousel && step > 0 && (
							<button
								type="button"
								onClick={goBack}
								className={cn(
									'inline-flex items-center gap-1 h-[22px] px-2 rounded-md',
									'text-sm text-vscode-foreground/50',
									'hover:text-vscode-foreground hover:bg-(--alpha-5)',
									'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
									'transition-colors duration-150',
								)}
							>
								<ChevronDownIcon size={14} className="rotate-90" />
								<span>Back</span>
							</button>
						)}

						{/* Next / Submit button */}
						<div
							className={cn(
								'inline-flex items-stretch overflow-hidden rounded-md',
								'border border-(--tool-border-color)',
							)}
						>
							<button
								type="button"
								onClick={goNext}
								disabled={!stepHasAnswer && isLastStep && !canSubmit}
								className={cn(
									'inline-flex items-center gap-1.5 h-[22px] px-2.5',
									'bg-vscode-button-secondaryBackground text-vscode-button-secondaryForeground',
									'hover:bg-vscode-button-secondaryHoverBackground',
									'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
									'disabled:opacity-40 disabled:cursor-not-allowed',
									'transition-colors duration-150',
								)}
							>
								{isLastStep ? (
									<>
										<CheckIcon size={14} />
										<span className="text-sm font-medium">Submit</span>
									</>
								) : (
									<>
										<span className="text-sm font-medium">Next</span>
										<ChevronDownIcon size={14} className="-rotate-90" />
									</>
								)}
							</button>
						</div>

						{/* Skip (carousel, non-last step) */}
						{isCarousel && !isLastStep && (
							<button
								type="button"
								onClick={goNext}
								className={cn(
									'inline-flex items-center h-[22px] px-2 rounded-md',
									'text-sm text-vscode-foreground/35',
									'hover:text-vscode-foreground/60 hover:bg-(--alpha-5)',
									'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
									'transition-colors duration-150',
								)}
							>
								Skip
							</button>
						)}
					</div>

					{/* Dismiss */}
					<button
						type="button"
						onClick={handleDismiss}
						className={cn(
							'inline-flex items-center gap-1 h-[22px] px-2 rounded-md',
							'text-sm text-vscode-foreground/35',
							'hover:text-vscode-foreground/60 hover:bg-(--alpha-5)',
							'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
							'transition-colors duration-150',
						)}
					>
						<CloseIcon size={12} />
						<span>Dismiss</span>
					</button>
				</div>
			</div>
		</div>
	);
};
