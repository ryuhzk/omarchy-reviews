pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

Panel {
  id: root
  moduleName: "ryuhzk.customer-reviews"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  property var reviewsService: null
  property int panelWidth: 720
  property bool unrepliedOnly: true
  property string view: "setup"
  property string statusText: "Ready"
  property string lastError: ""
  property string processOutput: ""
  property string processError: ""
  property string pendingKind: ""
  property string issuerId: ""
  property string keyId: ""
  property string keyPath: ""
  property bool configured: false
  property bool keyPathExists: false
  property var apps: []
  property var watchedAppIds: []
  property string activeAppId: ""
  property var reviews: []
  property string nextPage: ""
  property var selectedReview: null
  property string replyDraft: ""

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string pluginDir: decodeURIComponent(
    String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, ""))
  readonly property string backendPath: pluginDir + "/backend/customer-reviews.ts"
  readonly property bool busy: cliProcess.running
  readonly property var visibleReviews: unrepliedOnly
    ? reviews.filter(function(item) { return item && item.response === null })
    : reviews

  function parseEnvelope(raw) {
    try {
      return JSON.parse(String(raw || ""))
    } catch (error) {
      return { ok: false, error: { code: "apple", message: "Invalid backend response" } }
    }
  }

  function filePathFromUrl(url) {
    var text = String(url || "")
    if (text.indexOf("file://") === 0)
      return decodeURIComponent(text.replace(/^file:\/\//, ""))
    return text
  }

  function stars(value) {
    var rating = Math.max(0, Math.min(5, Number(value) || 0))
    var text = ""
    for (var index = 0; index < 5; index += 1) text += index < rating ? "★" : "☆"
    return text
  }

  function shortDate(iso) {
    var date = new Date(String(iso || ""))
    if (isNaN(date.getTime())) return ""
    return date.toLocaleDateString(Qt.locale(), "yyyy-MM-dd")
  }

  function runCli(kind, args) {
    if (cliProcess.running) return
    pendingKind = kind
    processOutput = ""
    processError = ""
    statusText = "Working…"
    cliProcess.command = ["bun", "run", backendPath].concat(args).concat(["--compact"])
    cliProcess.running = true
  }

  function loadOnOpen() {
    runCli("config-show", ["config", "show"])
  }

  function open() {
    controller.show()
    loadOnOpen()
  }

  function close() {
    controller.hide()
  }

  function toggle() {
    opened ? close() : open()
  }

  function switchPanel(direction) {
    if (bar && typeof bar.switchPanelFrom === "function")
      return bar.switchPanelFrom(hostWidget || root, direction)
    return false
  }

  function applyConfig(data) {
    configured = data.configured === true
    issuerId = String(data.issuerId || "")
    keyId = String(data.keyId || "")
    keyPath = String(data.keyPath || "")
    keyPathExists = data.keyPathExists === true
    watchedAppIds = data.watchedAppIds instanceof Array ? data.watchedAppIds.slice() : []
    activeAppId = String(data.activeAppId || "")
    if (data.apps instanceof Array && data.apps.length > 0) apps = data.apps
    if (issuerField.text === "") issuerField.text = issuerId
    if (keyIdField.text === "") keyIdField.text = keyId
    if (!configured) {
      view = "setup"
      statusText = "Add an App Store Connect API key"
      return
    }
    if (watchedAppIds.length === 0) {
      view = "apps"
      statusText = "Choose apps to watch"
      runCli("apps", ["apps"])
      return
    }
    view = "inbox"
    if (activeAppId === "") activeAppId = watchedAppIds[0]
    runCli("reviews-list", ["reviews", "list", "--app", activeAppId].concat(unrepliedOnly ? ["--unreplied"] : []))
  }

  function saveCredentials() {
    var issuer = issuerField.text.trim()
    var kid = keyIdField.text.trim()
    var path = keyPathField.text.trim()
    if (issuer === "" || kid === "" || path === "") {
      lastError = "Issuer ID, Key ID, and the .p8 file are required"
      return
    }
    lastError = ""
    runCli("config-set", ["config", "set", "--issuer", issuer, "--key-id", kid, "--key", path])
  }

  function toggleWatched(appId) {
    var next = watchedAppIds.slice()
    var index = next.indexOf(appId)
    if (index >= 0) next.splice(index, 1)
    else next.push(appId)
    watchedAppIds = next
  }

  function saveWatchList() {
    if (watchedAppIds.length === 0) {
      lastError = "Select at least one app"
      return
    }
    lastError = ""
    runCli("watch", ["watch", "--ids", watchedAppIds.join(",")])
  }

  function selectApp(appId) {
    if (appId === "" || busy) return
    activeAppId = appId
    selectedReview = null
    replyDraft = ""
    replyArea.text = ""
    runCli("reviews-list", ["reviews", "list", "--app", appId].concat(unrepliedOnly ? ["--unreplied"] : []))
  }

  function loadMore() {
    if (nextPage === "" || busy) return
    runCli("reviews-next", ["reviews", "list", "--app", activeAppId, "--next", nextPage])
  }

  function submitReply() {
    if (!selectedReview || busy) return
    var body = replyArea.text
    if (String(body || "").trim() === "") {
      lastError = "Reply text is required"
      return
    }
    lastError = ""
    runCli("reply", ["reviews", "reply", "--review", selectedReview.id, "--body", body])
  }

  function removeReply() {
    if (!selectedReview || !selectedReview.response || busy) return
    runCli("delete-reply", ["reviews", "delete-reply", "--response", selectedReview.response.id])
  }

  function handleResult(kind, envelope) {
    if (!envelope || envelope.ok !== true) {
      lastError = (envelope && envelope.error && envelope.error.message)
        || processError
        || "Request failed"
      statusText = lastError
      return
    }
    lastError = ""
    var data = envelope.data || {}
    if (kind === "config-show" || kind === "config-set") {
      applyConfig(data)
      if (kind === "config-set") statusText = "API key saved"
      return
    }
    if (kind === "apps") {
      apps = data.apps instanceof Array ? data.apps : []
      statusText = String(apps.length) + " apps"
      return
    }
    if (kind === "watch") {
      watchedAppIds = data.watchedAppIds instanceof Array ? data.watchedAppIds : watchedAppIds
      activeAppId = String(data.activeAppId || activeAppId)
      view = "inbox"
      selectApp(activeAppId)
      return
    }
    if (kind === "reviews-list" || kind === "reviews-next") {
      var incoming = data.reviews instanceof Array ? data.reviews : []
      reviews = kind === "reviews-next" ? reviews.concat(incoming) : incoming
      nextPage = String(data.next || "")
      if (selectedReview) {
        for (var index = 0; index < reviews.length; index += 1) {
          if (reviews[index].id === selectedReview.id) selectedReview = reviews[index]
        }
      } else if (visibleReviews.length > 0) {
        selectedReview = visibleReviews[0]
        replyArea.text = ""
      }
      statusText = String(visibleReviews.length) + " reviews"
      return
    }
    if (kind === "reply" || kind === "delete-reply") {
      statusText = kind === "reply" ? "Reply sent" : "Reply deleted"
      selectApp(activeAppId)
      if (reviewsService && typeof reviewsService.refresh === "function") reviewsService.refresh()
    }
  }

  FileDialog {
    id: keyDialog
    title: "Choose the App Store Connect .p8 key"
    fileMode: FileDialog.OpenFile
    nameFilters: ["Private key (*.p8)", "All files (*)"]
    onAccepted: keyPathField.text = root.filePathFromUrl(String(selectedFile))
  }

  Process {
    id: cliProcess
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.processOutput = String(text || "")
    }
    stderr: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.processError = String(text || "").trim()
    }
    onExited: function() {
      root.handleResult(root.pendingKind, root.parseEnvelope(root.processOutput))
      root.pendingKind = ""
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(root.panelWidth))
    contentHeight: panel.fittedContentHeight(Style.space(720), Style.space(780))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        anchors.fill: parent
        contentWidth: width
        contentHeight: content.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        flickableDirection: Flickable.VerticalFlick
        interactive: contentHeight > height
        ScrollBar.vertical: ScrollBar { policy: ScrollBar.AsNeeded }

        Column {
          id: content
          width: parent.width
          spacing: Style.space(12)

          PanelHero {
            width: parent.width
            title: "Customer Reviews"
            meta: root.view === "setup" ? "App Store Connect" : (root.view === "apps" ? "Watched apps" : "Inbox")
            detail: root.statusText
            foreground: root.foreground
            fontFamily: root.fontFamily
          }

          Text {
            width: parent.width
            visible: root.lastError !== ""
            text: root.lastError
            color: root.urgent
            font.family: root.fontFamily
            font.pixelSize: Style.font.bodySmall
            wrapMode: Text.WordWrap
          }

          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.view === "setup"

            Text {
              width: parent.width
              text: "1. Open App Store Connect → Users and Access → Integrations → App Store Connect API.\n2. Create a key with the Customer Support or Admin role.\n3. Download the .p8 once, then paste the Issuer ID and Key ID below."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            TextField {
              id: issuerField
              width: parent.width
              placeholderText: "Issuer ID"
              foreground: root.foreground
            }

            TextField {
              id: keyIdField
              width: parent.width
              placeholderText: "Key ID"
              foreground: root.foreground
            }

            Row {
              width: parent.width
              spacing: Style.space(8)

              TextField {
                id: keyPathField
                width: parent.width - browseButton.width - parent.spacing
                placeholderText: "Path to AuthKey_XXXX.p8"
                foreground: root.foreground
              }

              Button {
                id: browseButton
                text: "Browse"
                bordered: true
                onClicked: keyDialog.open()
              }
            }

            Button {
              text: root.busy ? "Saving…" : "Save API key"
              iconText: root.busy ? "󰑓" : "󰆓"
              iconSpinning: root.busy
              bordered: true
              enabled: !root.busy
              onClicked: root.saveCredentials()
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.view === "apps"

            Text {
              width: parent.width
              text: "Select the apps that should update the bar badge and notifications."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Repeater {
              model: root.apps

              Rectangle {
                required property var modelData
                readonly property bool watched: root.watchedAppIds.indexOf(modelData.id) >= 0
                width: content.width
                height: appLabel.implicitHeight + Style.space(16)
                radius: Style.space(8)
                color: watched
                  ? Util.alpha(Color.accent, 0.18)
                  : Util.alpha(root.foreground, 0.06)

                Column {
                  id: appLabel
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  anchors.leftMargin: Style.space(12)
                  anchors.rightMargin: Style.space(12)
                  spacing: Style.space(2)

                  Text {
                    text: String(modelData.name || modelData.id)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.body
                    font.bold: true
                  }

                  Text {
                    text: String(modelData.bundleId || "")
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleWatched(parent.modelData.id)
                }
              }
            }

            Row {
              spacing: Style.space(8)

              Button {
                text: root.busy ? "Saving…" : "Watch selected apps"
                bordered: true
                enabled: !root.busy
                onClicked: root.saveWatchList()
              }

              Button {
                text: "Change credentials"
                bordered: true
                onClicked: root.view = "setup"
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(10)
            visible: root.view === "inbox"

            Flow {
              width: parent.width
              spacing: Style.space(6)

              Repeater {
                model: root.watchedAppIds

                Rectangle {
                  required property var modelData
                  readonly property bool active: modelData === root.activeAppId
                  readonly property var app: {
                    for (var index = 0; index < root.apps.length; index += 1) {
                      if (root.apps[index].id === modelData) return root.apps[index]
                    }
                    return { id: modelData, name: modelData }
                  }
                  width: chipText.implicitWidth + Style.space(20)
                  height: chipText.implicitHeight + Style.space(10)
                  radius: height / 2
                  color: active ? Util.alpha(Color.accent, 0.22) : Util.alpha(root.foreground, 0.07)
                  border.width: active ? 1 : 0
                  border.color: Color.accent

                  Text {
                    id: chipText
                    anchors.centerIn: parent
                    text: String(parent.app.name || parent.modelData)
                    color: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.selectApp(parent.modelData)
                  }
                }
              }
            }

            Row {
              spacing: Style.space(8)

              Button {
                text: root.unrepliedOnly ? "Unreplied" : "All reviews"
                bordered: true
                onClicked: {
                  root.unrepliedOnly = !root.unrepliedOnly
                  root.selectApp(root.activeAppId)
                }
              }

              Button {
                text: root.busy ? "Loading…" : "Retry"
                bordered: true
                enabled: !root.busy
                onClicked: root.selectApp(root.activeAppId)
              }

              Button {
                text: "Apps"
                bordered: true
                onClicked: {
                  root.view = "apps"
                  root.runCli("apps", ["apps"])
                }
              }
            }

            Row {
              width: parent.width
              spacing: Style.space(12)

              ListView {
                width: parent.width * 0.42
                height: Style.space(360)
                clip: true
                model: root.visibleReviews
                spacing: Style.space(6)
                boundsBehavior: Flickable.StopAtBounds

                delegate: Rectangle {
                  required property var modelData
                  width: ListView.view.width
                  height: reviewSummary.implicitHeight + Style.space(14)
                  radius: Style.space(8)
                  color: root.selectedReview && root.selectedReview.id === modelData.id
                    ? Style.selectedFillFor(root.foreground, Color.accent)
                    : Util.alpha(root.foreground, 0.05)

                  Column {
                    id: reviewSummary
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: Style.space(10)
                    spacing: Style.space(3)

                    Text {
                      text: root.stars(modelData.rating) + "  " + String(modelData.title || "Untitled")
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                      font.bold: true
                      elide: Text.ElideRight
                      width: parent.width
                    }

                    Text {
                      text: String(modelData.nickname || "Customer") + " · " + root.shortDate(modelData.createdDate)
                      color: root.dim
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.caption
                    }
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                      root.selectedReview = modelData
                      replyArea.text = ""
                    }
                  }
                }
              }

              Column {
                width: parent.width * 0.58 - parent.spacing
                spacing: Style.space(8)

                Text {
                  width: parent.width
                  visible: root.selectedReview !== null
                  text: root.selectedReview
                    ? root.stars(root.selectedReview.rating) + "  " + String(root.selectedReview.title || "Untitled")
                    : ""
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.subtitle
                  font.bold: true
                  wrapMode: Text.WordWrap
                }

                Text {
                  width: parent.width
                  visible: root.selectedReview !== null
                  text: root.selectedReview
                    ? [root.selectedReview.nickname, root.selectedReview.territory, root.shortDate(root.selectedReview.createdDate)].filter(function(value) { return String(value || "") !== "" }).join(" · ")
                    : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.caption
                }

                Text {
                  width: parent.width
                  visible: root.selectedReview !== null
                  text: root.selectedReview ? String(root.selectedReview.body || "") : "Select a review"
                  color: root.foreground
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                Text {
                  width: parent.width
                  visible: root.selectedReview && root.selectedReview.response
                  text: root.selectedReview && root.selectedReview.response
                    ? "Your reply\n" + String(root.selectedReview.response.body || "")
                    : ""
                  color: root.dim
                  font.family: root.fontFamily
                  font.pixelSize: Style.font.bodySmall
                  wrapMode: Text.WordWrap
                }

                BorderSurface {
                  width: parent.width
                  height: Style.space(90)
                  visible: root.selectedReview !== null && (!root.selectedReview.response)
                  color: Style.controlFill(replyArea.activeFocus, replyArea.hovered, root.foreground, Color.accent)
                  borderSpec: Border.controlSpec(replyArea.activeFocus ? "focus" : "normal", root.foreground, Color.accent)
                  radius: Style.cornerRadius

                  TextArea {
                    id: replyArea
                    anchors.fill: parent
                    anchors.margins: Style.space(8)
                    placeholderText: "Write a public reply"
                    wrapMode: TextEdit.Wrap
                    color: root.foreground
                    selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
                    selectedTextColor: root.foreground
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.bodySmall
                    background: null
                  }
                }

                Row {
                  spacing: Style.space(8)

                  Button {
                    visible: root.selectedReview !== null && (!root.selectedReview.response)
                    text: root.busy ? "Sending…" : "Submit reply"
                    bordered: true
                    enabled: !root.busy
                    onClicked: root.submitReply()
                  }

                  Button {
                    visible: root.selectedReview && root.selectedReview.response
                    text: "Delete reply"
                    bordered: true
                    enabled: !root.busy
                    onClicked: root.removeReply()
                  }

                  Button {
                    visible: root.nextPage !== ""
                    text: "Load more"
                    bordered: true
                    enabled: !root.busy
                    onClicked: root.loadMore()
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
