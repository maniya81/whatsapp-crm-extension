// API Service for OceanCRM
const DEFAULT_BASE_URL = "https://crm.oceantechnolab.com/api";

export interface Stage {
  id: string;
  name: string;
  color?: string;
}

export interface Lead {
  id: string;
  stage: string;
  business: {
    mobile: string;
  };
  [key: string]: any;
}

export interface LeadsResponse {
  items: Lead[];
}

async function sendMessage(message: any): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

export async function fetchStages(orgId: string): Promise<Stage[]> {
  try {
    const response = await sendMessage({
      type: "getStages",
      orgId: orgId,
      baseUrl: DEFAULT_BASE_URL
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to fetch stages");
    }

    return response.data || [];
  } catch (error) {
    console.error("[API] Error fetching stages:", error);
    throw error;
  }
}

export async function fetchLeads(orgId: string): Promise<Lead[]> {
  try {
    const response = await sendMessage({
      type: "getLeads",
      orgId: orgId,
      baseUrl: DEFAULT_BASE_URL
    });

    if (!response.ok) {
      throw new Error(response.error || "Failed to fetch leads");
    }

    const data: LeadsResponse = response.data;
    return data.items || [];
  } catch (error) {
    console.error("[API] Error fetching leads:", error);
    throw error;
  }
}

// Normalize phone number for comparison
export function normalizePhone(phone: string): string {
  if (!phone) return "";
  // Remove spaces, brackets, but keep + prefix
  return phone.replace(/[\s\(\)\-]/g, "");
}
