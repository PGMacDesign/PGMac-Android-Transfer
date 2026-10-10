import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'material-symbols/rounded.css';
import './styles.css';
import { App } from './App.tsx';
import { initialDensity, initialTheme } from './prefs.ts';

// Set before first paint so a dark-mode user never sees a light flash.
document.documentElement.dataset.theme = initialTheme();
document.documentElement.dataset.density = initialDensity();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
