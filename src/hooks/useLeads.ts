import { useEffect, useMemo } from 'react';
import { useLeadContext } from '../context/LeadContext';
import { fetchStages, fetchLeads, Lead } from '../services/api';

export function useLeads(orgId: string | null) {
  const {
    leads,
    stages,
    activeStage,
    setLeads,
    setStages,
    setLoading,
    setError
  } = useLeadContext();

  // Fetch stages and leads on mount
  useEffect(() => {
    if (!orgId) return;

    const loadData = async () => {
      setLoading(true);
      setError(null);
      
      try {
        // Fetch both stages and leads in parallel
        const [stagesData, leadsData] = await Promise.all([
          fetchStages(orgId),
          fetchLeads(orgId)
        ]);

        setStages(stagesData);
        setLeads(leadsData);
      } catch (err: any) {
        console.error('[useLeads] Error loading data:', err);
        setError(err.message || 'Failed to load data');
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [orgId, setLoading, setError, setStages, setLeads]);

  // Group leads by stage using useMemo for performance
  const leadsByStage = useMemo(() => {
    const grouped: Record<string, Lead[]> = {};
    
    leads.forEach(lead => {
      const stage = lead.stage;
      // Skip leads without a stage assignment
      if (!stage) return;
      
      if (!grouped[stage]) {
        grouped[stage] = [];
      }
      grouped[stage].push(lead);
    });

    return grouped;
  }, [leads]);

  // Filter leads by active stage
  const filteredLeads = useMemo(() => {
    if (!activeStage) {
      return leads; // Show all leads when no stage is selected
    }
    return leadsByStage[activeStage] || [];
  }, [activeStage, leads, leadsByStage]);

  return {
    leadsByStage,
    filteredLeads,
    stages,
    activeStage
  };
}
