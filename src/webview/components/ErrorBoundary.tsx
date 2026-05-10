/**
 * @file Global React ErrorBoundary for the webview
 * @description Catches unhandled React render errors that would otherwise crash the entire
 *              component tree and leave the webview as a blank gray screen. Logs the error
 *              to both browser console and the VS Code Output channel via webviewLogger,
 *              then renders a minimal fallback UI with a retry button.
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

	private handleRetry = (): void => {
		this.setState({ hasError: false, error: null });
	};

	render(): ReactNode {
		if (!this.state.hasError) {
			return this.props.children;
		}

		return (
			<div
				style={{
					display: 'flex',
					flexDirection: 'column',
					alignItems: 'center',
					justifyContent: 'center',
					height: '100vh',
					padding: '24px',
					backgroundColor: 'var(--surface-base, var(--vscode-sideBar-background, #1e1e1e))',
					color: 'var(--vscode-foreground, #ccc)',
					fontFamily: 'var(--vscode-font-family, sans-serif)',
					fontSize: '13px',
					textAlign: 'center',
					gap: '12px',
				}}
			>
				<svg
					width="32"
					height="32"
					viewBox="0 0 16 16"
					fill="none"
					style={{ opacity: 0.6 }}
					aria-hidden="true"
					role="img"
				>
					<title>Error icon</title>
					<path
						d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7.25 4.75a.75.75 0 0 1 1.5 0v3.5a.75.75 0 0 1-1.5 0v-3.5ZM8 11.5A.75.75 0 1 1 8 10a.75.75 0 0 1 0 1.5Z"
						fill="currentColor"
					/>
				</svg>
				<span style={{ fontWeight: 500 }}>Something went wrong</span>
				<span style={{ opacity: 0.7, maxWidth: '300px', lineHeight: '1.4' }}>
					{this.state.error?.message ?? 'An unexpected error occurred'}
				</span>
				<button
					type="button"
					onClick={this.handleRetry}
					style={{
						marginTop: '8px',
						padding: '6px 16px',
						border: '1px solid var(--vscode-button-border, transparent)',
						borderRadius: '4px',
						backgroundColor: 'var(--vscode-button-background, #0e639c)',
						color: 'var(--vscode-button-foreground, #fff)',
						fontSize: '12px',
						cursor: 'pointer',
					}}
				>
					Retry
				</button>
			</div>
		);
	}
}
