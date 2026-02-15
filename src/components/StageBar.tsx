import React from 'react';
import { useLeadContext } from '../context/LeadContext';

interface StageBarProps {
  leadsByStage: Record<string, any[]>;
}

// Stage color mapping
const STAGE_COLORS: Record<string, string> = {
  'WON': '#198f51',
  'LOST': '#b00020',
  'DISCUSSION': '#1565c0',
  'NEW LEAD': '#f9a825',
  'DEFAULT': '#7b6f63'
};

function getStageColor(stageName: string): string {
  const upperName = stageName.toUpperCase();
  return STAGE_COLORS[upperName] || STAGE_COLORS['DEFAULT'];
}

export function StageBar({ leadsByStage }: StageBarProps) {
  const { stages, activeStage, setActiveStage } = useLeadContext();

  const handleStageClick = (stageName: string) => {
    // Toggle: if clicking the same stage, deselect it
    if (activeStage === stageName) {
      setActiveStage(null);
    } else {
      setActiveStage(stageName);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: 200,
        background: 'rgba(255, 255, 255, 0.95)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid #e0e0e0',
        padding: '8px 16px',
        display: 'flex',
        gap: '8px',
        overflowX: 'auto',
        overflowY: 'hidden',
        whiteSpace: 'nowrap',
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)'
      }}
    >
      {stages.map((stage) => {
        const stageName = stage.name;
        const count = leadsByStage[stageName]?.length || 0;
        const isActive = activeStage === stageName;
        const color = getStageColor(stageName);

        return (
          <button
            key={stage.id}
            onClick={() => handleStageClick(stageName)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              border: `2px solid ${isActive ? color : 'transparent'}`,
              borderRadius: '20px',
              background: isActive ? color : '#f5f5f5',
              color: isActive ? '#ffffff' : '#333',
              fontSize: '13px',
              fontWeight: isActive ? 600 : 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              outline: 'none',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = '#e0e0e0';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = '#f5f5f5';
              }
            }}
          >
            <span>{stageName}</span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                minWidth: '20px',
                height: '20px',
                padding: '0 6px',
                borderRadius: '10px',
                background: isActive ? 'rgba(255,255,255,0.3)' : color,
                color: isActive ? '#ffffff' : '#ffffff',
                fontSize: '11px',
                fontWeight: 700
              }}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
