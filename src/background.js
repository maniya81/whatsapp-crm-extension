const DEFAULT_BASE_URL = "https://crm.oceantechnolab.com/api";
const ACCESS_COOKIE_NAME = "access_token_cookie";
const CSRF_COOKIE_NAME = "csrf_access_token";

function normalizeBaseUrl(baseUrl) {
	if (!baseUrl) {
		return DEFAULT_BASE_URL;
	}
	return baseUrl.replace(/\/$/, "");
}

function getOrigin(baseUrl) {
	const url = new URL(baseUrl);
	return url.origin;
}

async function getCookieValue(origin, name) {
	const cookie = await chrome.cookies.get({ url: origin, name });
	return cookie ? cookie.value : "";
}

async function getAuthHeaders(baseUrl) {
	const origin = getOrigin(baseUrl);
	const accessToken = await getCookieValue(origin, ACCESS_COOKIE_NAME);
	const csrfToken = await getCookieValue(origin, CSRF_COOKIE_NAME);

	if (!accessToken) {
		throw new Error("Missing access token cookie. Log into CRM first.");
	}

	const headers = {
		"x-access-token": accessToken,
		Accept: "application/json",
	};

	if (csrfToken) {
		headers["X-CSRF-Token"] = csrfToken;
	}

	return headers;
}

async function apiRequest(baseUrl, path, options = {}) {
	const normalizedBase = normalizeBaseUrl(baseUrl);
	const headers = await getAuthHeaders(normalizedBase);
	const response = await fetch(`${normalizedBase}${path}`, {
		method: options.method || "GET",
		headers: { ...headers, ...(options.headers || {}) },
		body: options.body ? JSON.stringify(options.body) : undefined,
	});

	if (!response.ok) {
		const text = await response.text();
		throw new Error(`API ${response.status}: ${text}`);
	}

	if (response.status === 204) {
		return null;
	}

	return response.json();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const baseUrl = message.baseUrl || DEFAULT_BASE_URL;

	if (message.type === "getOrgs") {
		apiRequest(baseUrl, "/v1/org/current")
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (message.type === "getStages") {
		const headers = { "x-org-id": message.orgId };
		apiRequest(baseUrl, "/v1/lead/stage/", { headers })
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (message.type === "createLead") {
		const headers = {
			"x-org-id": message.orgId,
			"Content-Type": "application/json",
		};
		apiRequest(baseUrl, "/v1/lead", {
			method: "POST",
			headers,
			body: message.lead,
		})
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (message.type === "getLeads") {
		const headers = { "x-org-id": message.orgId };
		apiRequest(baseUrl, "/v1/lead?page_size=1000", { headers })
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	if (message.type === "pingAuth") {
		apiRequest(baseUrl, "/v1/user/logged")
			.then((data) => sendResponse({ ok: true, data }))
			.catch((error) => sendResponse({ ok: false, error: error.message }));
		return true;
	}

	sendResponse({ ok: false, error: "Unknown message type." });
	return false;
});
