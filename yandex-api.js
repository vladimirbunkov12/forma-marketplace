"use strict";

const YANDEX_API_URL = "https://b2b.taxi.yandex.net";

async function yandexRequest(apiKey, endpoint, data = {}) {
	if (!apiKey || typeof apiKey !== "string") {
		throw new Error("API-ключ Яндекс Доставки отсутствует");
	}

	if (!endpoint.startsWith("/b2b/cargo/integration/")) {
		throw new Error("Недопустимый адрес API");
	}

	const response = await fetch(`${YANDEX_API_URL}${endpoint}`, {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify(data),
		signal: AbortSignal.timeout(15000)
	});

	const result = await response.json();

	if (!response.ok) {
		throw new Error(
			`Ошибка Яндекс Доставки: HTTP ${response.status}`
		);
	}

	return result;
}

module.exports = { yandexRequest };
