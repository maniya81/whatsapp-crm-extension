import React from 'react';
import ReactDOM from 'react-dom/client';
import { ExtensionApp } from './ExtensionApp';

// Wait for WhatsApp to be ready
function waitForWhatsAppReady(): Promise<void> {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const appElement = document.querySelector('#app');
      if (appElement) {
        clearInterval(checkInterval);
        resolve();
      }
    }, 100);

    // Timeout after 30 seconds
    setTimeout(() => {
      clearInterval(checkInterval);
      resolve();
    }, 30000);
  });
}

async function injectReactApp() {
  console.log('[OceanCRM] Waiting for WhatsApp to load...');
  
  await waitForWhatsAppReady();
  
  console.log('[OceanCRM] Injecting React app...');

  // Create container for our React app
  const container = document.createElement('div');
  container.id = 'ocrm-react-root';
  container.style.position = 'fixed';
  container.style.top = '0';
  container.style.left = '0';
  container.style.width = '100%';
  container.style.zIndex = '199';
  container.style.pointerEvents = 'none';
  
  // Make children interactive
  const style = document.createElement('style');
  style.textContent = `
    #ocrm-react-root > * {
      pointer-events: auto;
    }
  `;
  document.head.appendChild(style);

  document.body.appendChild(container);

  // Mount React app
  const root = ReactDOM.createRoot(container);
  root.render(<ExtensionApp />);

  console.log('[OceanCRM] React app mounted successfully!');
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectReactApp);
} else {
  injectReactApp();
}
