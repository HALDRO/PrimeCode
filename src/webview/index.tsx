import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './global.css';

const isDev = process.env.NODE_ENV === 'development';

function renderApp() {
	const container = document.getElementById('root');
	if (!container) {
		throw new Error('Root container not found');
	}

	const root = createRoot(container);
	// StrictMode only in development for double-render checks
	root.render(
		isDev ? (
			<React.StrictMode>
				<App />
			</React.StrictMode>
		) : (
			<App />
		),
	);
}

renderApp();
