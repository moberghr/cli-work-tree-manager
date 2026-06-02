import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './styles/global.css';
import './styles/diff.css';
import './styles/review.css';
import './styles/hljs.css';

const container = document.getElementById('root');
if (!container) throw new Error('No #root element found');
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
