/**
 * The only JavaScript in the product.
 *
 * Two rules shape it. First: every page here works with scripting disabled —
 * the run detail page is fully rendered server-side, and this only adds
 * liveness on top of it. Second: the client never renders a result. It appends
 * timeline rows and swaps a screenshot, and the moment the run reaches a
 * terminal status it reloads the page exactly once and stops, so the result you
 * end up looking at was rendered by the same server code path that renders an
 * archived run. There is exactly one result renderer, and it is not in the
 * browser.
 */

/**
 * Serializes a value as a JavaScript string literal that is also safe to sit
 * inside an inline `<script>` element. HTML-escaping would corrupt the JS, so
 * the escaping goes the other way: `<`, `>` and `&` become unicode escapes,
 * which makes `</script>` unrepresentable in the output.
 */
export function jsString(value: string): string {
  return JSON.stringify(String(value))
    .replace(/</g, "\\u003C")
    .replace(/>/g, "\\u003E")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export interface PollScriptOptions {
  runId: string;
  /** Poll interval in ms. Defaults to 1500. */
  pollMs?: number;
}

export function pollScript(opts: PollScriptOptions): string {
  const runId = jsString(opts.runId);
  const pollMs = Number.isFinite(opts.pollMs) && (opts.pollMs ?? 0) > 0 ? Math.floor(opts.pollMs as number) : 1500;

  return `<script>
(function () {
  var runId = ${runId};
  var pollMs = ${pollMs};
  var statusUrl = "/api/runs/" + encodeURIComponent(runId) + "/status";
  var eventsUrl = "/api/runs/" + encodeURIComponent(runId) + "/events";
  var timeline = document.getElementById("timeline");
  var shot = document.getElementById("live-screenshot");
  var statusHost = document.querySelector("[data-run-status] [data-status]");
  var renderedStatus = statusHost ? statusHost.getAttribute("data-status") : null;
  var stopped = false;
  var reloaded = false;
  var consecutiveErrors = 0;
  var cursor = -1;

  if (timeline) {
    var rows = timeline.querySelectorAll("[data-event-index]");
    for (var i = 0; i < rows.length; i++) {
      var n = parseInt(rows[i].getAttribute("data-event-index") || "-1", 10);
      if (!isNaN(n) && n > cursor) cursor = n;
    }
  }

  function isTerminal(status) {
    return status && status !== "running" && status !== "escalation_pending";
  }

  function stop() { stopped = true; }

  function finish() {
    // Exactly once. The server re-renders the finished run, including the
    // result section, which the client deliberately does not know how to draw.
    if (reloaded) return;
    reloaded = true;
    stop();
    location.reload();
  }

  function fieldText(event) {
    // The model's turn is the one event worth formatting on the client. A
    // discovery run is mostly these, and "reasoning=... tool=... input=..."
    // is unreadable at the speed they arrive.
    if (event.type === "model_decision") {
      var args = [];
      if (event.input && typeof event.input === "object") {
        for (var k in event.input) {
          if (!Object.prototype.hasOwnProperty.call(event.input, k)) continue;
          var v = event.input[k];
          if (typeof v !== "string") v = JSON.stringify(v);
          args.push(k + "=" + (v && v.length > 60 ? v.slice(0, 60) + "\u2026" : v));
        }
      }
      var head = (event.tool || "?") + "(" + args.join(", ") + ")";
      return event.reasoning ? head + " \u00b7 \u201c" + event.reasoning + "\u201d" : head;
    }
    var skip = { type: 1, timestamp: 1, index: 1 };
    var parts = [];
    for (var key in event) {
      if (!Object.prototype.hasOwnProperty.call(event, key) || skip[key]) continue;
      var value = event[key];
      if (value === null || value === undefined) continue;
      if (typeof value === "object") value = JSON.stringify(value);
      parts.push(key + "=" + value);
      if (parts.length >= 6) break;
    }
    return parts.join(" · ");
  }

  // textContent only: run events quote text scraped out of the target app,
  // and this is the one place that text would otherwise reach innerHTML.
  function appendEvent(event) {
    if (!timeline) return;
    var li = document.createElement("li");
    li.className = "flex gap-3 py-2.5 bg-blue-50/40";
    li.setAttribute("data-event-index", String(event.index));

    var when = document.createElement("span");
    when.className = "w-14 shrink-0 pt-0.5 text-right font-mono text-[11px] tabular-nums text-slate-400";
    when.textContent = "live";
    when.title = String(event.timestamp || "");

    var kind = document.createElement("span");
    kind.className = "inline-flex h-5 shrink-0 items-center gap-1 rounded px-1.5 text-[11px] font-medium ring-1 ring-inset bg-slate-100 text-slate-600 ring-slate-400/25";
    kind.textContent = String(event.type || "event");

    var body = document.createElement("span");
    body.className = "min-w-0 flex-1 break-words text-sm text-slate-700";
    body.textContent = fieldText(event);

    li.appendChild(when);
    li.appendChild(kind);
    li.appendChild(body);
    timeline.appendChild(li);
  }

  function pullEvents() {
    return fetch(eventsUrl + "?since=" + encodeURIComponent(String(cursor + 1)), { headers: { accept: "application/json" } })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data) return;
        var events = Array.isArray(data) ? data : data.events;
        if (!Array.isArray(events)) return;
        for (var i = 0; i < events.length; i++) {
          var event = events[i];
          if (typeof event.index === "number" && event.index <= cursor) continue;
          appendEvent(event);
          if (typeof event.index === "number") cursor = event.index;
        }
      });
  }

  function refreshScreenshot() {
    if (!shot) return;
    shot.src = "/runs/" + encodeURIComponent(runId) + "/screenshot?t=" + Date.now();
  }

  function tick() {
    if (stopped) return;
    fetch(statusUrl, { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("status " + res.status);
        return res.json();
      })
      .then(function (data) {
        consecutiveErrors = 0;
        var status = data && (data.status || (data.run && data.run.status));
        return pullEvents().then(function () {
          refreshScreenshot();
          // Any status change at all is the server's business to render: a run
          // slipping into escalation_pending needs the amber banner, and that
          // banner exists once, on the server.
          if (isTerminal(status) || (status && renderedStatus && status !== renderedStatus)) finish();
        });
      })
      .catch(function () {
        consecutiveErrors++;
        // The server going away mid-run is a real possibility (it is the thing
        // driving the browser). Give up quietly rather than hammering it.
        if (consecutiveErrors >= 10) stop();
      })
      .then(function () {
        if (!stopped) setTimeout(tick, pollMs);
      });
  }

  setTimeout(tick, pollMs);
  window.addEventListener("pagehide", stop);
})();
</script>`;
}

/**
 * For the catalog and overview pages: the runner is single-flight, so the
 * invoke controls are disabled while something is running. Without this, the
 * page stays stale after a run finishes and the reviewer's next click does
 * nothing until they think to refresh.
 */
export function runnerPollScript(opts?: { pollMs?: number }): string {
  const pollMs = Number.isFinite(opts?.pollMs) && (opts?.pollMs ?? 0) > 0 ? Math.floor(opts?.pollMs as number) : 3000;
  return `<script>
(function () {
  var pollMs = ${pollMs};
  var stopped = false;
  var consecutiveErrors = 0;

  // Both directions. This used to only ever *enable*: a run started in another
  // tab left every Invoke button live, so the next click lost the race for the
  // single-flight runner and got an error instead of a disabled control.
  var ENABLED = ["bg-slate-900", "text-white"];
  var DISABLED = ["bg-slate-300", "text-slate-500", "cursor-not-allowed"];

  function swapClasses(el, remove, add) {
    var classes = el.className.split(/\s+/).filter(function (c) {
      return c !== "" && remove.indexOf(c) === -1;
    });
    for (var i = 0; i < add.length; i++) {
      if (classes.indexOf(add[i]) === -1) classes.push(add[i]);
    }
    el.className = classes.join(" ");
  }

  function setFree(free) {
    var controls = document.querySelectorAll("[data-runner-lock]");
    for (var i = 0; i < controls.length; i++) {
      if (free) {
        controls[i].removeAttribute("disabled");
        swapClasses(controls[i], DISABLED, ENABLED);
      } else {
        controls[i].setAttribute("disabled", "disabled");
        swapClasses(controls[i], ENABLED, DISABLED);
      }
    }
    var banners = document.querySelectorAll("[data-runner-banner]");
    for (var j = 0; j < banners.length; j++) {
      banners[j].hidden = free;
    }
  }

  function tick() {
    if (stopped) return;
    fetch("/api/runner", { headers: { accept: "application/json" } })
      .then(function (res) {
        if (!res.ok) throw new Error("status " + res.status);
        return res.json();
      })
      .then(function (data) {
        consecutiveErrors = 0;
        // Tolerant of shape: { busy } or { active } or { state: "idle" }.
        var busy = data
          ? data.busy === true || (data.active !== null && data.active !== undefined) || data.state === "busy"
          : false;
        setFree(!busy);
      })
      .catch(function () {
        consecutiveErrors++;
        if (consecutiveErrors >= 10) stopped = true;
      })
      .then(function () {
        if (!stopped) setTimeout(tick, pollMs);
      });
  }

  setTimeout(tick, pollMs);
  window.addEventListener("pagehide", function () { stopped = true; });
})();
</script>`;
}
