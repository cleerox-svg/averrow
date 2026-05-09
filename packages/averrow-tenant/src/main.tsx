import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { bootstrapTheme } from '@averrow/shared/theme';
import { App } from './App';
import './index.css';

// Apply persisted theme synchronously, before React mounts.
// Without this the page renders in default dark until any
// useTheme consumer mounts, then snaps to the persisted theme
// — visible flash. Mirror of the averrow-ops main.tsx bootstrap.
bootstrapTheme();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('No #root element found in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
