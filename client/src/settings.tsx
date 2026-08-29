import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import SettingsWindow from './settingsWindow';
import './App.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SettingsWindow />
  </StrictMode>,
);
