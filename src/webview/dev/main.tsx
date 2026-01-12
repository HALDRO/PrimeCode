/**
 * @file Browser development entry point
 * @description Entry point for standalone browser development of the webview.
 *              Initializes mock VS Code API and renders the App component with
 *              sample data for UI testing. CSS variables are defined in global.css.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';

// Initialize mock VS Code API BEFORE importing App
import { addSampleMessages, initMockVSCode } from './mockVSCode';

initMockVSCode();

// Import global styles (Tailwind + design system with CSS variables)
import '../global.css';

// Import the main App component
import App from '../App';

// Render the app
const container = document.getElementById('root');
if (!container) {
	throw new Error('Root container not found');
}

const root = createRoot(container);
root.render(
	<React.StrictMode>
		<App />
	</React.StrictMode>,
);

// Add sample messages after app is mounted
setTimeout(() => {
	addSampleMessages();
}, 1000);

// Log dev mode info
console.log(
	'%c🚀 PrimeCode - Browser Dev Mode',
	'color: #3794ff; font-size: 16px; font-weight: bold;',
);
console.log('%cThis is a standalone preview with mocked VS Code API.', 'color: #9d9d9d;');
console.log('%cMessages sent via postMessage are logged to console.', 'color: #9d9d9d;');

// Debug: Check if CSS variables are loaded
setTimeout(() => {
	const styles = getComputedStyle(document.documentElement);
	const bgColor = styles.getPropertyValue('--vscode-editor-background');
	const fgColor = styles.getPropertyValue('--vscode-editor-foreground');
	console.log('%cCSS Variables Debug:', 'color: #ffa500; font-weight: bold;');
	console.log('  --vscode-editor-background:', bgColor || '(not set)');
	console.log('  --vscode-editor-foreground:', fgColor || '(not set)');
	console.log('  body background:', getComputedStyle(document.body).backgroundColor);
	console.log('  body color:', getComputedStyle(document.body).color);
}, 500);
