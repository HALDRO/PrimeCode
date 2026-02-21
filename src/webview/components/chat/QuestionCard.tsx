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
import { CheckIcon, ChevronDownIcon, CloseIcon, HelpCircleIcon } from '../icons';
import { ChevronIcon } from '../icons/CustomIcons';

type QuestionMessage = Extract<Message, { type: 'question' }>;

interface QuestionCardProps {
	message: QuestionMessage;
}

/* ------------------------------------------------------------------ */
/*  (ResolvedSummary removed — resolved state now uses the same card) */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Option button (radio / checkbox style)                            */
/* ------------------------------------------------------------------ */

const OptionButton: React.FC<{
	label: string;
	description?: string;
	selected: boolean;
	multiple: boolean;
	recommended?: boolean;
	disabled?: boolean;
	onClick: () => void;
}> = ({ label, description, selected, multiple, recommended, disabled, onClick }) => (
	<button
		type="button"
		onClick={disabled ? undefined : onClick}
		className={cn(
			'group/opt flex items-start gap-2.5 w-full text-left',
			'px-2.5 py-1.5 rounded-md border transition-all duration-150',
			'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
			disabled && 'cursor-default',
			selected
				? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]/8'
				: 'border-(--tool-border-color) bg-transparent',
			!disabled && !selected && 'hover:bg-(--alpha-5)',
		)}
	>
		{/* indicator */}
		<span
			className={cn(
				'flex items-center justify-center shrink-0 mt-1 transition-colors duration-150',
				'border',
				multiple ? 'w-3.5 h-3.5 rounded-sm' : 'w-3.5 h-3.5 rounded-full',
				selected
					? 'border-[var(--vscode-focusBorder)] bg-[var(--vscode-focusBorder)]'
					: 'border-(--tool-border-color) bg-transparent',
				!disabled && !selected && 'group-hover/opt:border-vscode-foreground/40',
			)}
		>
			{selected &&
				(multiple ? (
					<CheckIcon size={10} className="text-white" />
				) : (
					<span className="block w-[6px] h-[6px] rounded-full bg-white" />
				))}
		</span>

		{/* label + description */}
		<span className="flex flex-col min-w-0 gap-px flex-1">
			<span className="flex items-start gap-1.5">
				<span className="text-sm text-vscode-foreground leading-tight break-words whitespace-normal">
					{label}
				</span>
				{recommended && (
					<span className="text-[10px] px-1 py-px rounded bg-[var(--vscode-focusBorder)]/15 text-[var(--vscode-focusBorder)] font-medium shrink-0">
						Recommended
					</span>
				)}
			</span>
			{description && (
				<span className="text-xs text-vscode-foreground/50 leading-tight break-words whitespace-normal">
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
/*  Main component                                                    */
/* ------------------------------------------------------------------ */

export const QuestionCard: React.FC<QuestionCardProps> = ({ message }) => {
	const { requestId, questions = [], resolved, answers: savedAnswers, id } = message;
	const { postSessionMessage } = useSessionMessage();
	const { updateMessage } = useChatActions();
	const inputRef = useRef<HTMLInputElement>(null);

	const isCarousel = questions.length > 1;
	const [step, setStep] = useState(0);
	const [expanded, setExpanded] = useState(!resolved);

	const [selections, setSelections] = useState<Set<string>[]>(() =>
		questions.map(() => new Set<string>()),
	);
	const [customInputs, setCustomInputs] = useState<string[]>(() => questions.map(() => ''));

	const toggleOption = useCallback(
		(qIdx: number, label: string, multiple: boolean) => {
			if (resolved) return;
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
		},
		[resolved],
	);

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
		setExpanded(false);
	}, [questions, selections, customInputs, requestId, id, postSessionMessage, updateMessage]);

	const handleDismiss = useCallback(() => {
		postSessionMessage({ type: 'questionReject', requestId });
		if (id) updateMessage(id, { resolved: true });
		setExpanded(false);
	}, [requestId, id, postSessionMessage, updateMessage]);

	const q = questions[step];
	if (!q) return null;

	// Build the set of selected labels for the current step
	const optionLabels = new Set(q.options.map(o => o.label));
	const stepAnswers = resolved ? (savedAnswers?.[step] ?? []) : [];
	const resolvedSelections = new Set(stepAnswers.filter(a => optionLabels.has(a)));
	const customAnswer = stepAnswers.find(a => !optionLabels.has(a)) ?? '';

	const activeSelections = resolved ? resolvedSelections : (selections[step] ?? new Set());

	// Summary text for collapsed resolved header
	const summaryText = resolved
		? savedAnswers
				?.map(a => a.join(', '))
				.filter(Boolean)
				.join(' · ') || 'Answered'
		: '';

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
			<div
				className={cn(
					'bg-(--tool-bg-header) border border-(--tool-border-color) rounded-lg overflow-hidden',
				)}
			>
				{/* Header — clickable to toggle when resolved */}
				{resolved ? (
					<button
						type="button"
						onClick={() => setExpanded(prev => !prev)}
						className={cn(
							'group/qh flex items-center gap-2 w-full h-(--tool-header-height) px-(--tool-header-padding)',
							'bg-transparent border-none text-left cursor-pointer hover:bg-(--alpha-5)',
						)}
					>
						<span className="flex items-center justify-center w-[18px] h-[18px] shrink-0">
							<span className="group-hover/qh:hidden">
								<HelpCircleIcon size={16} className="text-info" />
							</span>
							<span className="hidden group-hover/qh:inline-flex">
								<ChevronIcon expanded={expanded} size={12} />
							</span>
						</span>
						<span className="text-sm font-medium text-vscode-foreground shrink-0">Question</span>
						{!expanded && summaryText && (
							<>
								<span className="text-sm text-vscode-descriptionForeground">·</span>
								<span className="text-sm leading-none text-vscode-foreground opacity-60 min-w-0 truncate">
									{summaryText}
								</span>
							</>
						)}
					</button>
				) : (
					<div className="flex items-center justify-between h-(--tool-header-height) px-(--tool-header-padding)">
						<div className="flex items-center gap-2">
							<span className="flex items-center justify-center w-[18px] h-[18px] shrink-0">
								<HelpCircleIcon size={16} className="text-info" />
							</span>
							<span className="text-sm font-medium text-vscode-foreground">
								{isCarousel ? `Question ${step + 1} of ${questions.length}` : 'Question'}
							</span>
						</div>
						{isCarousel && (
							<StepDots total={questions.length} current={step} onDotClick={setStep} />
						)}
					</div>
				)}

				{/* Body — visible when expanded (always for active, toggle for resolved) */}
				{expanded && (
					<div className="px-(--tool-content-padding) pb-2">
						{resolved && isCarousel && (
							<div className="flex items-center justify-between mb-2">
								<span className="text-sm text-vscode-foreground/50">
									Question {step + 1} of {questions.length}
								</span>
								<StepDots total={questions.length} current={step} onDotClick={setStep} />
							</div>
						)}
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
										selected={activeSelections.has(opt.label)}
										multiple={!!q.multiple}
										recommended={opt.recommended}
										disabled={!!resolved}
										onClick={() => toggleOption(step, opt.label, !!q.multiple)}
									/>
								))}
							</div>
						)}

						{/* "Other" input — read-only when resolved, editable when active */}
						{resolved ? (
							customAnswer ? (
								<div
									className={cn(
										'w-full text-sm pl-2.5 py-1.5 rounded-md',
										'bg-vscode-input-background border border-(--tool-border-color)',
										'text-vscode-foreground opacity-60',
									)}
								>
									{customAnswer}
								</div>
							) : null
						) : (
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
						)}
					</div>
				)}

				{/* Resolved carousel navigation */}
				{resolved && expanded && isCarousel && (
					<div className="flex items-center justify-center gap-2 px-(--tool-content-padding) py-1.5 border-t border-(--tool-border-color)">
						<button
							type="button"
							onClick={goBack}
							disabled={step === 0}
							className={cn(
								'inline-flex items-center gap-1 h-[22px] px-2 rounded-md',
								'text-sm text-vscode-foreground/50',
								'hover:text-vscode-foreground hover:bg-(--alpha-5)',
								'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
								'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
								'transition-colors duration-150',
							)}
						>
							<ChevronDownIcon size={14} className="rotate-90" />
							<span>Back</span>
						</button>
						<span className="text-xs text-vscode-foreground/40">
							{step + 1} / {questions.length}
						</span>
						<button
							type="button"
							onClick={() => setStep(s => Math.min(s + 1, questions.length - 1))}
							disabled={step === questions.length - 1}
							className={cn(
								'inline-flex items-center gap-1 h-[22px] px-2 rounded-md',
								'text-sm text-vscode-foreground/50',
								'hover:text-vscode-foreground hover:bg-(--alpha-5)',
								'focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder',
								'disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent',
								'transition-colors duration-150',
							)}
						>
							<span>Next</span>
							<ChevronDownIcon size={14} className="-rotate-90" />
						</button>
					</div>
				)}

				{/* Footer — only when not resolved and expanded */}
				{!resolved && expanded && (
					<div className="flex items-center justify-between px-(--tool-content-padding) py-1.5 border-t border-(--tool-border-color)">
						<div className="flex items-center gap-1.5">
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
				)}
			</div>
		</div>
	);
};
