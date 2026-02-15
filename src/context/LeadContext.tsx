import React, { createContext, useContext, useState, ReactNode } from 'react';
import { Lead, Stage } from '../services/api';

interface LeadContextType {
  leads: Lead[];
  stages: Stage[];
  activeStage: string | null;
  setLeads: (leads: Lead[]) => void;
  setStages: (stages: Stage[]) => void;
  setActiveStage: (stage: string | null) => void;
  loading: boolean;
  setLoading: (loading: boolean) => void;
  error: string | null;
  setError: (error: string | null) => void;
}

const LeadContext = createContext<LeadContextType | undefined>(undefined);

export function LeadProvider({ children }: { children: ReactNode }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <LeadContext.Provider
      value={{
        leads,
        stages,
        activeStage,
        setLeads,
        setStages,
        setActiveStage,
        loading,
        setLoading,
        error,
        setError
      }}
    >
      {children}
    </LeadContext.Provider>
  );
}

export function useLeadContext() {
  const context = useContext(LeadContext);
  if (!context) {
    throw new Error('useLeadContext must be used within a LeadProvider');
  }
  return context;
}
