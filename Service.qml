import QtQuick
import Quickshell
import Quickshell.Io

Item {
  id: root

  property var shell: null
  property var manifest: null
  property int pollIntervalSec: 10800
  property bool configured: false
  property int unrepliedCount: 0
  property string statusText: "Idle"
  property string lastError: ""
  property string processOutput: ""
  property string processError: ""

  readonly property string pluginDir: decodeURIComponent(
    String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, ""))
  readonly property string backendPath: pluginDir + "/backend/customer-reviews.ts"
  readonly property int boundedPollMs: Math.max(3600, Math.min(43200, pollIntervalSec)) * 1000

  function parseEnvelope(raw) {
    try {
      return JSON.parse(String(raw || ""))
    } catch (error) {
      return { ok: false, error: { code: "apple", message: "Invalid backend response" } }
    }
  }

  function notifyNewReviews(items) {
    var reviews = items instanceof Array ? items : []
    if (reviews.length === 0) return
    if (reviews.length > 5) {
      var titles = reviews.slice(0, 5).map(function(item) {
        return String(item.title || item.body || item.reviewId || "")
      }).filter(function(text) { return text !== "" })
      Quickshell.execDetached([
        "notify-send", "-a", "Customer Reviews", "-u", "normal",
        String(reviews.length) + " new reviews",
        titles.join("\n")
      ])
      return
    }
    for (var index = 0; index < reviews.length; index += 1) {
      var item = reviews[index] || {}
      var title = String(item.appName || "App") + " · " + String(item.rating || 0) + "★"
      var body = String(item.title || "").trim()
      if (body === "") body = String(item.body || "").trim().slice(0, 120)
      Quickshell.execDetached([
        "notify-send", "-a", "Customer Reviews", "-u", "normal", title, body
      ])
    }
  }

  function pollNow() {
    if (pollProcess.running) return
    processOutput = ""
    processError = ""
    statusText = "Checking reviews…"
    pollProcess.command = ["bun", "run", backendPath, "poll", "--compact"]
    pollProcess.running = true
  }

  function refresh() {
    pollNow()
  }

  Timer {
    interval: root.boundedPollMs
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.pollNow()
  }

  Process {
    id: pollProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.processOutput = String(text || "")
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.processError = String(text || "").trim()
    }
    onExited: function(exitCode) {
      var envelope = root.parseEnvelope(root.processOutput)
      if (!envelope || envelope.ok !== true) {
        root.lastError = (envelope && envelope.error && envelope.error.message)
          || root.processError
          || "Could not poll App Store Connect"
        root.statusText = root.lastError
        return
      }
      var data = envelope.data || {}
      root.configured = data.configured === true
      root.unrepliedCount = Number(data.unrepliedCount || 0)
      root.lastError = ""
      root.statusText = root.configured
        ? (root.unrepliedCount === 0 ? "All caught up" : String(root.unrepliedCount) + " unreplied")
        : "Not configured"
      root.notifyNewReviews(data.newReviews)
    }
  }
}
