import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles/tokens.css';
import './styles/global.css';
import './ui/ui.css';
import './styles/dashboard.css';
import './styles/pages/repos.css';
import './styles/pages/time.css';
import './styles/pages/cleanup.css';
import './styles/pages/accounts.css';
import './styles/pages/settings.css';
import './styles/pages/welcome.css';
import './styles/pages/start.css';
import './styles/pages/issues.css';
import './styles/pages/today.css';
import './styles/pages/inbox.css';
import './styles/pages/sessions.css';
import './styles/pages/session.css';
import './styles/pages/rail.css';
import './styles/pages/reviews.css';
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
