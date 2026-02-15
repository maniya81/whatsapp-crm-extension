import { useEffect, useRef } from 'react';
import { Lead, normalizePhone } from '../services/api';

interface ChatHighlighterProps {
  filteredLeads: Lead[];
}

// Debounce function for performance
function debounce<T extends (...args: any[]) => void>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return function(...args: Parameters<T>) {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
}

export function ChatHighlighter({ filteredLeads }: ChatHighlighterProps) {
  const observerRef = useRef<MutationObserver | null>(null);

  useEffect(() => {
    // Create a set of normalized phone numbers for quick lookup
    const phoneSet = new Set<string>();
    filteredLeads.forEach(lead => {
      const phone = normalizePhone(lead.business.mobile);
      if (phone) {
        phoneSet.add(phone);
      }
    });

    // Function to extract phone from WhatsApp data-id attribute
    const extractPhoneFromDataId = (dataId: string): string | null => {
      // Format: "1234567890@c.us" or "1234567890@s.whatsapp.net"
      const match = dataId.match(/(\d{7,15})@/);
      return match ? match[1] : null;
    };

    // Function to highlight matching chats
    const highlightChats = () => {
      // Find all chat items in the WhatsApp UI
      const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"]');
      
      chatItems.forEach(chatItem => {
        const dataId = chatItem.getAttribute('data-id');
        if (!dataId) return;

        const phone = extractPhoneFromDataId(dataId);
        if (!phone) return;

        const normalizedPhone = normalizePhone(phone);
        const matches = phoneSet.has(normalizedPhone) || phoneSet.has(`+${normalizedPhone}`);

        // Add or remove highlight
        if (matches && filteredLeads.length > 0) {
          // Add highlight badge
          let badge = chatItem.querySelector('.ocrm-stage-badge');
          if (!badge) {
            badge = document.createElement('div');
            badge.className = 'ocrm-stage-badge';
            badge.textContent = '●';
            Object.assign((badge as HTMLElement).style, {
              position: 'absolute',
              top: '10px',
              right: '10px',
              width: '10px',
              height: '10px',
              background: '#1565c0',
              borderRadius: '50%',
              zIndex: '10',
              pointerEvents: 'none'
            });
            chatItem.appendChild(badge);
          }
          
          // Add subtle background highlight
          (chatItem as HTMLElement).style.background = 'rgba(21, 101, 192, 0.05)';
        } else {
          // Remove highlight
          const badge = chatItem.querySelector('.ocrm-stage-badge');
          if (badge) {
            badge.remove();
          }
          (chatItem as HTMLElement).style.background = '';
        }
      });
    };

    // Debounced version of highlight function
    const debouncedHighlight = debounce(highlightChats, 300);

    // Initial highlight
    highlightChats();

    // Set up MutationObserver to watch for chat list changes
    const chatListContainer = document.querySelector('#pane-side') || document.body;
    
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    observerRef.current = new MutationObserver(debouncedHighlight);
    observerRef.current.observe(chatListContainer, {
      childList: true,
      subtree: true
    });

    // Cleanup
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
    };
  }, [filteredLeads]);

  // This component doesn't render anything
  return null;
}
