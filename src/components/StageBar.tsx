import React, { useEffect, useState } from 'react';
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

function getStageColor(stageName: string | undefined | null): string {
  if (!stageName) return STAGE_COLORS['DEFAULT'];
  const upperName = stageName.toUpperCase();
  return STAGE_COLORS[upperName] || STAGE_COLORS['DEFAULT'];
}

export function StageBar({ leadsByStage }: StageBarProps) {
  const { stages, activeStage, setActiveStage } = useLeadContext();
  const [isDarkMode, setIsDarkMode] = useState(false);

  // Detect dark mode
  useEffect(() => {
    const checkDarkMode = () => {
      setIsDarkMode(document.body.classList.contains('dark'));
    };

    checkDarkMode();

    // Watch for theme changes
    const observer = new MutationObserver(checkDarkMode);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

    return () => observer.disconnect();
  }, []);

  const handleStageClick = (stageName: string) => {
    // Toggle: if clicking the same stage, deselect it
    if (activeStage === stageName) {
      setActiveStage(null);
    } else {
      setActiveStage(stageName);
    }
  };

  const backgroundColor = isDarkMode ? 'rgba(17, 27, 33, 0.95)' : 'rgba(255, 255, 255, 0.95)';
  const borderColor = isDarkMode ? '#2a3942' : '#e0e0e0';
  const inactiveBg = isDarkMode ? '#202c33' : '#f5f5f5';
  const inactiveHoverBg = isDarkMode ? '#2a3942' : '#e0e0e0';
  const inactiveTextColor = isDarkMode ? '#e0e0e0' : '#333';

  return (
    <div
      style={{
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        zIndex: 200,
        background: backgroundColor,
        backdropFilter: 'blur(10px)',
        borderBottom: `1px solid ${borderColor}`,
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
        
        // Skip stages without names
        if (!stageName) {
          console.warn('[StageBar] Skipping stage without name:', stage);
          return null;
        }
        
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
              background: isActive ? color : inactiveBg,
              color: isActive ? '#ffffff' : inactiveTextColor,
              fontSize: '13px',
              fontWeight: isActive ? 600 : 500,
              cursor: 'pointer',
              transition: 'all 0.2s ease',
              outline: 'none',
              fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = inactiveHoverBg;
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = inactiveBg;
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
