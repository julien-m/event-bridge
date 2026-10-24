/** Render minimized snapshots with text nodes; EventSource reconnects without polling providers. */
(() => {
	const node = (id) => document.getElementById(id);
	const put = (id, text) => {
		node(id).textContent = text;
	};
	const date = (at) =>
		at == null ? "Not observed" : new Date(at).toLocaleString();
	let snapshot;
	let receivedAt = 0;
	let connected = false;
	let events;
	let clock;
	const freshness = () => {
		const fresh = connected && Date.now() - receivedAt < 45000;
		put(
			"freshness",
			fresh
				? `Live local process · Last contact ${date(receivedAt)}`
				: "Disconnected or stale · Displayed data is not current",
		);
	};
	const options = (id, values) => {
		const select = node(id);
		const prior = select.value;
		select.replaceChildren();
		for (const value of ["", ...new Set(values.filter(Boolean))]) {
			const option = document.createElement("option");
			option.value = value;
			option.textContent = value || "All";
			select.append(option);
		}
		select.value = values.includes(prior) ? prior : "";
	};
	const dispatcher = (health, modules = false) =>
		[
			health.stopped
				? "STOPPED"
				: health.draining
					? "Checking queue"
					: "Waiting for events",
			`Running: ${health.running}`,
			`Last check started: ${date(health.lastStartedAt)}`,
			`Last check finished: ${date(health.lastFinishedAt)}`,
			...(modules
				? [
						`Configuration: ${health.configurationValid === null ? "Not checked" : health.configurationValid ? "Valid" : "INVALID"}`,
						`Tasks enabled: ${health.activeTasks} / ${health.registered}`,
					]
				: []),
		].join("\n");
	const render = () => {
		if (!snapshot) return;
		const s = snapshot;
		put(
			"process",
			`${s.health.process}\nExecution enabled: ${s.health.enabled}\nStarted: ${date(s.startedAt)}\nJournal: ${s.journalAvailable ? "Available" : "FAILED"}`,
		);
		put(
			"worker",
			`${s.health.worker}\nTransport only; dispatcher health is separate.\nLast connection: ${date(s.last.connection?.at)}`,
		);
		put(
			"ownership",
			`${s.health.ownership}\nActive or uncertain owners: ${s.health.owners}\nLast observation: ${date(s.health.ownershipCheckedAt)}`,
		);
		put("github", dispatcher(s.health.github));
		put("modules", dispatcher(s.health.modules, true));
		put(
			"latest",
			Object.entries({
				received: "Received",
				ackSent: "ACK sent (not confirmation)",
				ackConfirmed: "ACK confirmed by relay",
				result: "Result",
				error: "Error",
			})
				.map(
					([key, label]) =>
						`${label}: ${date(s.last[key]?.at)} ${s.last[key]?.state || s.last[key]?.code || ""}`,
				)
				.join("\n"),
		);
		put(
			"queue",
			s.queueAvailable
				? s.queue
						.map(
							(q) =>
								`${q.source} · ${q.state}: ${q.count}\n  Oldest known: ${date(q.oldestReceivedAt)}${q.oldestReceivedAt == null ? "" : ` (${Math.max(0, Math.floor((Date.now() - q.oldestReceivedAt) / 1000))} s)`} · Unknown ages: ${q.unknownAge}`,
						)
						.join("\n") || "No local queued jobs"
				: "Queue unavailable; counts unknown",
		);
		put(
			"counters",
			Object.entries(s.counters)
				.map(([key, count]) => `${key}: ${count}`)
				.join(" · "),
		);
		node("events").replaceChildren();
		const rows = s.events.filter(
			(e) =>
				(node("severity").value !== "errors" || e.level === "error") &&
				(node("severity").value !== "blocked" || e.state === "blocked") &&
				(!node("module").value || node("module").value === e.module) &&
				(!node("repo").value || node("repo").value === e.repo),
		);
		for (const event of rows) {
			const tr = document.createElement("tr");
			tr.dataset.testid = "panel-event";
			for (const value of [
				date(event.at),
				[event.source, event.repo, event.module].filter(Boolean).join(" / "),
				[event.code, event.state, event.id].filter(Boolean).join(" · "),
				String(event.count),
			]) {
				const td = document.createElement("td");
				td.textContent = value;
				tr.append(td);
			}
			node("events").append(tr);
		}
	};
	const connect = () => {
		// pageshow also fires on initial load; this guard prevents duplicate streams and clocks.
		if (events) return;
		connected = false;
		freshness();
		const stream = new EventSource("/events");
		events = stream;
		stream.addEventListener("snapshot", (event) => {
			if (events !== stream) return;
			snapshot = JSON.parse(event.data);
			connected = true;
			receivedAt = Date.now();
			options(
				"repo",
				snapshot.events.map((e) => e.repo),
			);
			options(
				"module",
				snapshot.events.map((e) => e.module),
			);
			render();
			freshness();
		});
		stream.addEventListener("heartbeat", () => {
			if (events !== stream) return;
			connected = true;
			receivedAt = Date.now();
			freshness();
			render();
		});
		stream.onerror = () => {
			if (events !== stream) return;
			connected = false;
			freshness();
		};
		// A local display clock detects silence; it makes no HTTP requests.
		clock = setInterval(freshness, 5000);
	};
	for (const id of ["severity", "module", "repo"])
		node(id).addEventListener("change", render);
	window.addEventListener("pagehide", () => {
		const stream = events;
		events = undefined;
		clearInterval(clock);
		clock = undefined;
		connected = false;
		stream?.close();
		freshness();
	});
	// BFCache restores this script's existing state rather than executing it again.
	window.addEventListener("pageshow", connect);
	connect();
})();
