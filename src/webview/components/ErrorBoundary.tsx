/**
 * @file Global React ErrorBoundary with centered non-blocking notification
 * @description Catches unhandled React render errors and displays a compact notification
 *              centered horizontally, positioned below center vertically. Shows the error
 *              message with a copy button (for cases where render loops make text selection
 *              impossible) and an OK button that retries rendering then dismisses.
 *              Preserves the last successfully rendered children beneath the overlay.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { webviewLogger } from '../utils/logger';

const log = webviewLogger.forComponent('ErrorBoundary');

interface Props {
	children: ReactNode;
}

interface State {
	hasError: boolean;
	error: Error | null;
}

const TOAST_STYLES: Record<string, React.CSSProperties> = {
	container: {
		position: 'fixed',
		left: '50%',
		top: '65%',
		transform: 'translate(-50%, -50%)',
		zIndex: 9999,
		maxWidth: '380px',
		width: 'calc(100% - 32px)',
		padding: '14px 16px',
		borderRadius: '10px',
		backgroundColor: 'var(--vscode-editorWidget-background, #252526)',
		border: '1px solid var(--vscode-editorWidget-border, #454545)',
		boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4), 0 2px 8px rgba(0, 0, 0, 0.2)',
		color: 'var(--vscode-foreground, #ccc)',
		fontFamily: 'var(--vscode-font-family, sans-serif)',
		fontSize: '12px',
		display: 'flex',
		flexDirection: 'column',
		gap: '10px',
		animation: 'errorBoundaryFadeIn 0.2s ease-out',
	},
	header: {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
	},
	icon: {
		flexShrink: 0,
		color: 'var(--vscode-errorForeground, #f48771)',
	},
	title: {
		fontWeight: 500,
		fontSize: '12px',
		color: 'var(--vscode-errorForeground, #f48771)',
	},
	message: {
		opacity: 0.8,
		lineHeight: '1.4',
		fontSize: '11px',
		overflow: 'hidden',
		textOverflow: 'ellipsis',
		display: '-webkit-box',
		WebkitLineClamp: 4,
		WebkitBoxOrient: 'vertical',
		userSelect: 'text',
		cursor: 'text',
	},
	actions: {
		display: 'flex',
		gap: '8px',
		justifyContent: 'flex-end',
		alignItems: 'center',
		marginTop: '2px',
	},
	btnOk: {
		padding: '5px 16px',
		border: '1px solid var(--vscode-button-border, transparent)',
		borderRadius: '4px',
		backgroundColor: 'var(--vscode-button-background, #0e639c)',
		color: 'var(--vscode-button-foreground, #fff)',
		fontSize: '11px',
		cursor: 'pointer',
		fontWeight: 500,
	},
	btnCopy: {
		padding: '5px 10px',
		border: '1px solid var(--vscode-button-secondaryBorder, transparent)',
		borderRadius: '4px',
		backgroundColor: 'var(--vscode-button-secondaryBackground, #3a3d41)',
		color: 'var(--vscode-button-secondaryForeground, #fff)',
		fontSize: '11px',
		cursor: 'pointer',
	},
};

export class ErrorBoundary extends Component<Props, State> {
	state: State = { hasError: false, error: null };

	static getDerivedStateFromError(error: Error): State {
		return { hasError: true, error };
	}

	componentDidCatch(error: Error, info: ErrorInfo): void {
		const stack = info.componentStack ?? '';
		log.error(`Unhandled render error: ${error.message}`, {
			name: error.name,
			stack: error.stack,
			componentStack: stack,
		});
	}

	private handleOk = (): void => {
		this.setState({ hasError: false, error: null });
	};

	private handleCopy = (): void => {
		const message = this.state.error?.message ?? 'Unknown error';
		const stack = this.state.error?.stack ?? '';
		const text = stack ? `${message}\n\n${stack}` : message;
		void navigator.clipboard.writeText(text);
	};

	render(): ReactNode {
		const { hasError, error } = this.state;

		if (!hasError) {
			return this.props.children;
		}

		return (
			<>
				{this.props.children}
				<div style={TOAST_STYLES.container} role="alert" aria-live="assertive">
					<div style={TOAST_STYLES.header}>
						<svg
							width="16"
							height="16"
							viewBox="0 0 16 16"
							fill="none"
							style={TOAST_STYLES.icon}
							aria-hidden="true"
						>
							<path
								d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5ZM8 11.5A.75.75 0 1 1 8 10a.75.75 0 0 1 0 1.5Z"
								fill="currentColor"
							/>
						</svg>
						<span style={TOAST_STYLES.title}>Render Error</span>
					</div>
					<span style={TOAST_STYLES.message}>
						{error?.message ?? 'An unexpected error occurred'}
					</span>
					<div style={TOAST_STYLES.actions}>
						<button type="button" onClick={this.handleCopy} style={TOAST_STYLES.btnCopy}>
							Copy
						</button>
						<button type="button" onClick={this.handleOk} style={TOAST_STYLES.btnOk}>
							OK
						</button>
					</div>
				</div>
				<style>
					{`@keyframes errorBoundaryFadeIn {
						from { opacity: 0; transform: translate(-50%, -50%) scale(0.95); }
						to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
					}`}
				</style>
			</>
		);
	}
}
