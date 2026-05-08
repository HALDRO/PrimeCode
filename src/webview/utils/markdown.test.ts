import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';

let Markdown: typeof import('./markdown').Markdown;

beforeAll(async () => {
	Object.defineProperty(globalThis, 'document', {
		value: { documentElement: {} },
		configurable: true,
	});
	Object.defineProperty(globalThis, 'getComputedStyle', {
		value: () => ({ getPropertyValue: () => '6' }),
		configurable: true,
	});
	({ Markdown } = await import('./markdown'));
});

describe('Markdown', () => {
	it('renders local markdown links as path chips instead of plain anchors', () => {
		const html = renderToStaticMarkup(
			React.createElement(Markdown, {
				content:
					'[eventReducer.ts](/C:/Users/Comp/Desktop/PrimeCode/src/webview/store/eventReducer.ts:147)',
			}),
		);

		expect(html).toContain('cursor-pointer');
		expect(html).toContain('eventReducer.ts');
		expect(html).not.toContain('<a');
	});
});
