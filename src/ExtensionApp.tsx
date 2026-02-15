import React, { useEffect, useState } from 'react';
import { LeadProvider } from './context/LeadContext';
import { StageBar } from './components/StageBar';
import { ChatHighlighter } from './components/ChatHighlighter';
import { useLeads } from './hooks/useLeads';

function ExtensionContent() {
  const [orgId, setOrgId] = useState<string | null>(null);
  
  // Get org ID from extension storage
  useEffect(() => {
    chrome.storage.local.get(['orgId'], (result) => {
      if (result.orgId) {
        setOrgId(result.orgId);
      } else {
        console.warn('[ExtensionApp] No orgId found in storage');
      }
    });
  }, []);

  const { leadsByStage, filteredLeads, stages } = useLeads(orgId);

  // Don't render if no orgId
  if (!orgId) {
    return null;
  }

  return (
    <>
      <StageBar leadsByStage={leadsByStage} />
      <ChatHighlighter filteredLeads={filteredLeads} />
    </>
  );
}

export function ExtensionApp() {
  return (
    <LeadProvider>
      <ExtensionContent />
    </LeadProvider>
  );
}
