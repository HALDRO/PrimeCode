import { render } from 'solid-js/web';
import App from './App';
import './App.css';

console.log('[OpenCode] Webview main.tsx loading...');
console.log('[OpenCode] Root element:', document.getElementById('root'));

try {
  render(() => <App />, document.getElementById('root')!);
  console.log('[OpenCode] Webview rendered successfully');
} catch (error) {
  console.error('[OpenCode] Error rendering webview:', error);
}
