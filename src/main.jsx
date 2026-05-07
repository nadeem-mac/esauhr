import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import './styles/index.css';
import { installGlobalHandlers } from './lib/clientErrors.js';

// Tier 2 fix (#5 / item 1) — capture window-level errors and unhandled
// promise rejections from anywhere in the app. Idempotent; safe to
// call multiple times in StrictMode dev re-mounts.
installGlobalHandlers();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
