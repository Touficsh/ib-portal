import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import App from './App.jsx';
import { initTheme } from './components/ThemeToggle.jsx';
import './styles.css';

// Apply theme before first paint to avoid a dark→light flash on light-mode users
initTheme();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    {/*
      Global toast layer. `theme="system"` follows our data-theme attribute via
      CSS custom properties (we override in styles.css). position=top-right keeps
      toasts out of the way of the bottom-of-page action buttons.
    */}
    <Toaster
      position="top-right"
      theme="system"
      richColors
      closeButton
      duration={3500}
      toastOptions={{
        classNames: {
          toast: 'ui-toast',
          title: 'ui-toast-title',
          description: 'ui-toast-desc',
        },
      }}
    />
  </StrictMode>
);
