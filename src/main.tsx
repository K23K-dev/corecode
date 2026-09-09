import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import DatabaseApp from './DatabaseApp';
import './styles.css';
import '@fontsource/geist/latin-700.css';
import './library-page.css';
import './neetcode-theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DatabaseApp />
  </StrictMode>,
);
