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
  property bool unrepliedOnly: false
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
  property bool appleConfigured: false
  property bool playConfigured: false
  property bool keyPathExists: false
  property string playKeyPath: ""
  property bool playKeyPathExists: false
  property var apps: []
  property var watchedAppIds: []
  property var activeFamilyIds: []
  property var cliQueue: []
  property var reviewsByApp: ({})
  property var nextByApp: ({})
  property string activeAppId: ""
  property var reviews: []
  property string nextPage: ""
  property var selectedReview: null
  property string replyDraft: ""
  property string pendingReviewId: ""
  property string pendingReplyBody: ""
  property string sentReviewId: ""

  readonly property color foreground: bar ? bar.foreground : Color.foreground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property color dim: Qt.darker(foreground, 1.55)
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family
  readonly property string pluginDir: decodeURIComponent(
    String(Qt.resolvedUrl(".")).replace(/^file:\/\//, "").replace(/\/$/, ""))
  readonly property string backendPath: pluginDir + "/backend/customer-reviews.ts"
  readonly property bool busy: cliProcess.running
  readonly property var visibleReviews: {
    var list = []
    for (var index = 0; index < reviews.length; index += 1) {
      var item = reviews[index]
      if (!item) continue
      var selected = selectedReview && selectedReview.id === item.id
      if (!unrepliedOnly || item.response === null || selected) list.push(item)
    }
    return list
  }
  readonly property var appGroups: groupAppList(apps)
  readonly property var watchedGroups: groupAppList(resolveWatchedApps(watchedAppIds, apps))

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

  function reviewerName(review) {
    var name = String((review && review.nickname) || "").trim()
    return name !== "" ? name : "Customer"
  }

  function appNameFor(appId) {
    var id = String(appId || "")
    for (var index = 0; index < apps.length; index += 1) {
      if (String(apps[index].id) === id) return String(apps[index].name || id)
    }
    return id
  }

  function storeOf(value) {
    if (!value) return "apple"
    if (typeof value === "string")
      return value.indexOf("play:") === 0 ? "play" : "apple"
    if (value.store === "play") return "play"
    return String(value.id || "").indexOf("play:") === 0 ? "play" : "apple"
  }

  function storeIcon(store) {
    return String(store) === "play" ? "󰀲" : "󰀵"
  }

  function lastBundleSegment(app) {
    var bundle = String((app && app.bundleId) || "")
    if (bundle === "") {
      var raw = String((app && app.id) || "")
      if (raw.indexOf("play:") === 0) raw = raw.slice(5)
      if (raw.indexOf("apple:") === 0) raw = raw.slice(6)
      bundle = raw
    }
    var parts = bundle.split(".")
    return String(parts[parts.length - 1] || "").trim().toLowerCase()
  }

  function appFamilyKeys(app) {
    var keys = []
    var name = String((app && app.name) || "").trim().toLowerCase()
    var seg = lastBundleSegment(app)
    var generic = { app: 1, ios: 1, android: 1, mobile: 1, free: 1, lite: 1, pro: 1 }
    if (name !== "" && name.indexOf(".") < 0) keys.push("n:" + name)
    if (seg !== "" && !generic[seg] && seg.length >= 2) keys.push("s:" + seg)
    if (keys.length === 0) keys.push("i:" + String((app && app.id) || ""))
    return keys
  }

  function groupAppList(list) {
    var items = []
    var index
    for (index = 0; index < list.length; index += 1) {
      if (list[index] && list[index].id) items.push(list[index])
    }
    var parent = []
    for (index = 0; index < items.length; index += 1) parent.push(index)
    function find(ix) {
      if (parent[ix] !== ix) parent[ix] = find(parent[ix])
      return parent[ix]
    }
    function union(left, right) {
      var leftRoot = find(left)
      var rightRoot = find(right)
      if (leftRoot !== rightRoot) parent[leftRoot] = rightRoot
    }
    var owner = ({})
    for (index = 0; index < items.length; index += 1) {
      var keys = appFamilyKeys(items[index])
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
        var key = keys[keyIndex]
        if (owner[key] === undefined) owner[key] = index
        else union(owner[key], index)
      }
    }
    var buckets = ({})
    var roots = []
    for (index = 0; index < items.length; index += 1) {
      var root = find(index)
      if (!buckets[root]) {
        buckets[root] = []
        roots.push(root)
      }
      buckets[root].push(items[index])
    }
    var groups = []
    for (index = 0; index < roots.length; index += 1) {
      var members = buckets[roots[index]].slice()
      members.sort(function(left, right) {
        var leftPlay = storeOf(left) === "play" ? 1 : 0
        var rightPlay = storeOf(right) === "play" ? 1 : 0
        if (leftPlay !== rightPlay) return leftPlay - rightPlay
        return String(left.name || "").localeCompare(String(right.name || ""))
      })
      var named = ""
      for (var memberIndex = 0; memberIndex < members.length; memberIndex += 1) {
        var label = String(members[memberIndex].name || "")
        if (label !== "" && label.indexOf(".") < 0) {
          named = label
          break
        }
      }
      if (named === "") named = String(members[0].name || members[0].id)
      groups.push({
        id: members.map(function(item) { return item.id }).join(","),
        name: named,
        members: members
      })
    }
    return groups
  }

  function resolveWatchedApps(ids, allApps) {
    var list = []
    for (var index = 0; index < ids.length; index += 1) {
      var id = String(ids[index] || "")
      var found = null
      for (var appIndex = 0; appIndex < allApps.length; appIndex += 1) {
        if (String(allApps[appIndex].id) === id) found = allApps[appIndex]
      }
      list.push(found || {
        id: id,
        name: appNameFor(id),
        bundleId: id.indexOf("play:") === 0 ? id.slice(5) : "",
        sku: "",
        store: id.indexOf("play:") === 0 ? "play" : "apple"
      })
    }
    return list
  }

  function memberIds(group) {
    var members = (group && group.members) || []
    var ids = []
    for (var index = 0; index < members.length; index += 1) ids.push(String(members[index].id))
    return ids
  }

  function familyIdsFor(appId) {
    return familyIdsForFrom(appId, apps, watchedAppIds)
  }

  function familyIdsForFrom(appId, allApps, watchedIds) {
    var id = String(appId || "")
    var groups = groupAppList(allApps || []).concat(groupAppList(resolveWatchedApps(watchedIds || [], allApps || [])))
    for (var index = 0; index < groups.length; index += 1) {
      var ids = memberIds(groups[index])
      if (ids.indexOf(id) >= 0) return ids
    }
    return id !== "" ? [id] : []
  }

  function firstFamilyIds(allApps, watchedIds) {
    var groups = groupAppList(resolveWatchedApps(watchedIds || [], allApps || []))
    if (groups.length > 0) return memberIds(groups[0])
    if (watchedIds && watchedIds.length > 0) return familyIdsForFrom(watchedIds[0], allApps, watchedIds)
    return []
  }

  function groupStores(group) {
    var stores = []
    var seen = ({})
    var members = (group && group.members) || []
    for (var index = 0; index < members.length; index += 1) {
      var store = storeOf(members[index])
      if (!seen[store]) {
        seen[store] = true
        stores.push(store)
      }
    }
    return stores
  }

  function groupSubtitle(group) {
    var seen = ({})
    var parts = []
    var members = (group && group.members) || []
    for (var index = 0; index < members.length; index += 1) {
      var line = String(members[index].bundleId || members[index].id || "")
      if (line.indexOf("play:") === 0) line = line.slice(5)
      if (line.indexOf("apple:") === 0) line = line.slice(6)
      if (line !== "" && !seen[line]) {
        seen[line] = true
        parts.push(line)
      }
    }
    return parts.join(" · ")
  }

  function sameIdSet(left, right) {
    if (left.length !== right.length) return false
    var copy = left.slice().sort()
    var other = right.slice().sort()
    for (var index = 0; index < copy.length; index += 1) {
      if (String(copy[index]) !== String(other[index])) return false
    }
    return true
  }

  function groupWatched(group) {
    var ids = memberIds(group)
    if (ids.length === 0) return false
    for (var index = 0; index < ids.length; index += 1) {
      if (watchedAppIds.indexOf(ids[index]) < 0) return false
    }
    return true
  }

  function toggleGroup(group) {
    var ids = memberIds(group)
    var next = watchedAppIds.slice()
    var allOn = groupWatched(group)
    for (var index = 0; index < ids.length; index += 1) {
      var found = next.indexOf(ids[index])
      if (allOn && found >= 0) next.splice(found, 1)
      if (!allOn && found < 0) next.push(ids[index])
    }
    watchedAppIds = next
  }

  function addPlayPackage() {
    var pkg = playPackageField.text.trim()
    if (pkg.indexOf("play:") === 0) pkg = pkg.slice(5)
    if (pkg === "") {
      lastError = "Enter a Play package name"
      return
    }
    var id = "play:" + pkg
    var nextApps = apps.slice()
    var found = false
    for (var index = 0; index < nextApps.length; index += 1) {
      if (String(nextApps[index].id) === id) found = true
    }
    if (!found) {
      nextApps.push({ id: id, name: pkg, bundleId: pkg, sku: "", store: "play" })
      apps = nextApps
    }
    var nextWatched = watchedAppIds.slice()
    if (nextWatched.indexOf(id) < 0) nextWatched.push(id)
    watchedAppIds = nextWatched
    playPackageField.text = ""
    lastError = ""
  }

  function reviewStore(review) {
    if (review && review.store === "play") return "play"
    return storeOf((review && review.appId) || activeAppId)
  }

  function replyLimitFor(review) {
    return reviewStore(review) === "play" ? 350 : 4000
  }

  function flattenReviews(map, ids) {
    var list = []
    var keys = ids && ids.length > 0 ? ids : Object.keys(map)
    for (var index = 0; index < keys.length; index += 1) {
      var items = map[keys[index]] || []
      for (var itemIndex = 0; itemIndex < items.length; itemIndex += 1) list.push(items[itemIndex])
    }
    list.sort(function(left, right) {
      return String(right.createdDate || "").localeCompare(String(left.createdDate || ""))
    })
    return list
  }

  function tagReviews(appId, reviews) {
    var tagged = []
    for (var index = 0; index < reviews.length; index += 1) {
      var item = reviews[index]
      if (!item) continue
      var copy = copyReview(item, item.response)
      copy.appId = appId
      if (!copy.store) copy.store = storeOf(appId)
      tagged.push(copy)
    }
    return tagged
  }

  function familyHasMore() {
    var map = nextByApp
    var keys = Object.keys(map)
    for (var index = 0; index < keys.length; index += 1) {
      if (String(map[keys[index]] || "") !== "") return true
    }
    return false
  }

  function runCli(kind, args) {
    if (cliProcess.running) {
      cliQueue = cliQueue.concat([{ kind: kind, args: args }])
      return
    }
    pendingKind = kind
    processOutput = ""
    processError = ""
    statusText = "Working…"
    cliProcess.command = ["bun", "run", backendPath].concat(args).concat(["--compact"])
    cliProcess.running = true
  }

  function flushCliQueue() {
    if (cliProcess.running || cliQueue.length === 0) return
    var next = cliQueue[0]
    cliQueue = cliQueue.slice(1)
    runCli(next.kind, next.args)
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
    appleConfigured = data.appleConfigured === true
    playConfigured = data.playConfigured === true
    issuerId = String(data.issuerId || "")
    keyId = String(data.keyId || "")
    keyPath = String(data.keyPath || "")
    keyPathExists = data.keyPathExists === true
    playKeyPath = String(data.playKeyPath || "")
    playKeyPathExists = data.playKeyPathExists === true
    watchedAppIds = data.watchedAppIds instanceof Array ? data.watchedAppIds.slice() : []
    activeAppId = String(data.activeAppId || "")
    if (data.apps instanceof Array && data.apps.length > 0) apps = data.apps
    if (issuerField.text === "") issuerField.text = issuerId
    if (keyIdField.text === "") keyIdField.text = keyId
    if (playKeyPathField.text === "") playKeyPathField.text = playKeyPath
    if (!configured) {
      view = "setup"
      statusText = "Add App Store Connect or Google Play credentials"
      return
    }
    if (watchedAppIds.length === 0) {
      view = "apps"
      statusText = "Choose apps to watch"
      runCli("apps", ["apps"])
      return
    }
    view = "inbox"
    selectGroup(firstFamilyIds(apps, watchedAppIds), data.inbox)
  }

  function cloneMap(map) {
    var next = ({})
    var keys = Object.keys(map || {})
    for (var index = 0; index < keys.length; index += 1) next[keys[index]] = map[keys[index]]
    return next
  }

  function applyInbox(data, cached, appId) {
    var id = String(appId || (data && data.appId) || activeAppId)
    if (activeFamilyIds.length > 0 && activeFamilyIds.indexOf(id) < 0) return
    var incoming = data && data.reviews instanceof Array ? data.reviews : []
    var map = cloneMap(reviewsByApp)
    map[id] = tagReviews(id, incoming)
    reviewsByApp = map
    reviews = flattenReviews(map, activeFamilyIds)
    var nextMap = cloneMap(nextByApp)
    nextMap[id] = String((data && data.next) || "")
    nextByApp = nextMap
    nextPage = familyHasMore() ? "1" : ""
    if (selectedReview) {
      var matched = null
      for (var index = 0; index < reviews.length; index += 1) {
        if (reviews[index].id === selectedReview.id) matched = reviews[index]
      }
      selectedReview = matched
    }
    statusText = cached
      ? (incoming.length > 0 ? "Updating…" : "Loading…")
      : String(visibleReviews.length) + " reviews"
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

  function savePlayCredentials() {
    var path = playKeyPathField.text.trim()
    if (path === "") {
      lastError = "The Google Play service account JSON is required"
      return
    }
    lastError = ""
    runCli("config-set-play", ["config", "set-play", "--key", path])
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

  function copyReview(review, response) {
    return {
      id: review.id,
      appId: review.appId || "",
      store: review.store || storeOf(review.appId || review.id),
      rating: review.rating,
      title: review.title,
      body: review.body,
      nickname: review.nickname,
      createdDate: review.createdDate,
      territory: review.territory,
      version: review.version || "",
      response: response
    }
  }

  function patchReview(reviewId, response) {
    var next = []
    var patched = null
    for (var index = 0; index < reviews.length; index += 1) {
      var item = reviews[index]
      if (item && item.id === reviewId) {
        patched = copyReview(item, response)
        next.push(patched)
      } else {
        next.push(item)
      }
    }
    reviews = next
    if (selectedReview && selectedReview.id === reviewId) selectedReview = patched
    return patched
  }

  function refreshBadge() {
    if (reviewsService && typeof reviewsService.refresh === "function") reviewsService.refresh()
  }

  function selectApp(appId) {
    if (appId === "") return
    selectGroup(familyIdsFor(appId))
  }

  function selectGroup(ids, seedInbox) {
    if (!ids || ids.length === 0) return
    activeFamilyIds = ids.slice()
    activeAppId = String(ids[0] || "")
    selectedReview = null
    replyDraft = ""
    pendingReviewId = ""
    pendingReplyBody = ""
    sentReviewId = ""
    reviewsByApp = ({})
    nextByApp = ({})
    reviews = []
    nextPage = ""
    cliQueue = []
    if (seedInbox && seedInbox.reviews instanceof Array && seedInbox.reviews.length > 0)
      applyInbox(seedInbox, true, seedInbox.appId)
    for (var index = 0; index < ids.length; index += 1)
      runCli("reviews-cached", ["reviews", "cached", "--app", ids[index]])
    for (index = 0; index < ids.length; index += 1)
      runCli("reviews-list", ["reviews", "list", "--app", ids[index]])
  }

  function toggleReview(review) {
    if (!review) return
    if (selectedReview && selectedReview.id === review.id) {
      selectedReview = null
      sentReviewId = ""
      statusText = String(visibleReviews.length) + " reviews"
      return
    }
    selectedReview = review
    if (sentReviewId !== review.id) sentReviewId = ""
    if (review.response && reviewStore(review) === "play")
      replyDraft = String(review.response.body || "")
    else if (!review.response)
      replyDraft = ""
  }

  function revealItem(item) {
    if (!item || !panelFlick) return
    var top = item.mapToItem(panelFlick.contentItem, 0, 0).y
    var bottom = top + item.height
    var viewTop = panelFlick.contentY
    var viewBottom = viewTop + panelFlick.height
    var maxY = Math.max(0, panelFlick.contentHeight - panelFlick.height)
    if (bottom > viewBottom)
      panelFlick.contentY = Math.min(maxY, bottom - panelFlick.height + Style.space(16))
    else if (top < viewTop)
      panelFlick.contentY = Math.max(0, top - Style.space(12))
  }

  function loadMore() {
    if (!familyHasMore() || busy) return
    var ids = activeFamilyIds.length > 0 ? activeFamilyIds : Object.keys(nextByApp)
    for (var index = 0; index < ids.length; index += 1) {
      var cursor = String(nextByApp[ids[index]] || "")
      if (cursor !== "")
        runCli("reviews-next", ["reviews", "list", "--app", ids[index], "--next", cursor])
    }
  }

  function submitReply() {
    if (!selectedReview || busy) return
    var body = replyDraft
    if (String(body || "").trim() === "") {
      lastError = "Reply text is required"
      return
    }
    lastError = ""
    pendingReviewId = String(selectedReview.id || "")
    pendingReplyBody = body
    runCli("reply", ["reviews", "reply", "--review", selectedReview.id, "--body", body, "--app", String(selectedReview.appId || activeAppId)])
  }

  function removeReply() {
    if (!selectedReview || !selectedReview.response || busy) return
    runCli("delete-reply", ["reviews", "delete-reply", "--response", selectedReview.response.id, "--app", String(selectedReview.appId || activeAppId)])
  }

  function handleResult(kind, envelope) {
    if (!envelope || envelope.ok !== true) {
      lastError = (envelope && envelope.error && envelope.error.message)
        || processError
        || "Request failed"
      if ((kind === "reviews-list" || kind === "reviews-next") && reviews.length > 0)
        statusText = lastError + " · showing cached reviews"
      else
        statusText = lastError
      return
    }
    lastError = ""
    var data = envelope.data || {}
    if (kind === "config-show" || kind === "config-set" || kind === "config-set-play") {
      applyConfig(data)
      if (kind === "config-set") statusText = "API key saved"
      if (kind === "config-set-play") statusText = "Play service account saved"
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
      selectGroup(firstFamilyIds(apps, watchedAppIds))
      return
    }
    if (kind === "reviews-cached") {
      applyInbox(data, true, data.appId)
      return
    }
    if (kind === "reviews-list" || kind === "reviews-next") {
      applyInbox(data, false, data.appId)
      return
    }
    if (kind === "reply") {
      var reviewId = String(data.reviewId || pendingReviewId)
      var response = {
        id: String(data.responseId || ""),
        body: pendingReplyBody,
        lastModifiedDate: new Date().toISOString(),
        state: "PUBLISHED"
      }
      var patched = patchReview(reviewId, response)
      sentReviewId = reviewId
      replyDraft = ""
      pendingReviewId = ""
      pendingReplyBody = ""
      statusText = "Replied to " + reviewerName(patched || selectedReview)
      refreshBadge()
      return
    }
    if (kind === "delete-reply") {
      var deleted = selectedReview
      patchReview(deleted ? deleted.id : "", null)
      sentReviewId = ""
      replyDraft = ""
      statusText = "Reply to " + reviewerName(deleted) + " deleted"
      refreshBadge()
    }
  }

  FileDialog {
    id: keyDialog
    title: "Choose the App Store Connect .p8 key"
    fileMode: FileDialog.OpenFile
    nameFilters: ["Private key (*.p8)", "All files (*)"]
    onAccepted: keyPathField.text = root.filePathFromUrl(String(selectedFile))
  }

  FileDialog {
    id: playKeyDialog
    title: "Choose the Google Play service account JSON"
    fileMode: FileDialog.OpenFile
    nameFilters: ["Service account (*.json)", "All files (*)"]
    onAccepted: playKeyPathField.text = root.filePathFromUrl(String(selectedFile))
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
      var kind = root.pendingKind
      root.pendingKind = ""
      root.handleResult(kind, root.parseEnvelope(root.processOutput))
      root.flushCliQueue()
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
    contentHeight: panel.fittedContentHeight(Style.space(780), Style.space(960))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }

      Flickable {
        id: panelFlick
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
            meta: root.view === "setup" ? "Stores" : (root.view === "apps" ? "Watched apps" : "Inbox")
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
              text: "App Store Connect"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

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

            Text {
              width: parent.width
              text: "Google Play"
              color: root.foreground
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
              font.bold: true
            }

            Text {
              width: parent.width
              text: "1. In Google Cloud, enable Google Play Android Developer API and create a service account JSON key.\n2. In Play Console, link that Cloud project under Setup → API access, then invite the service account with Reply to reviews.\n3. Choose the JSON below. Play only returns the last 7 days of commented production reviews."
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
              wrapMode: Text.WordWrap
            }

            Row {
              width: parent.width
              spacing: Style.space(8)

              TextField {
                id: playKeyPathField
                width: parent.width - playBrowseButton.width - parent.spacing
                placeholderText: "Path to play-service-account.json"
                foreground: root.foreground
              }

              Button {
                id: playBrowseButton
                text: "Browse"
                bordered: true
                onClicked: playKeyDialog.open()
              }
            }

            Button {
              text: root.busy ? "Saving…" : "Save service account"
              iconText: root.busy ? "󰑓" : "󰆓"
              iconSpinning: root.busy
              bordered: true
              enabled: !root.busy
              onClicked: root.savePlayCredentials()
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
              model: root.appGroups

              Rectangle {
                id: appCard
                required property var modelData
                readonly property bool watched: root.groupWatched(modelData)
                readonly property var stores: root.groupStores(modelData)
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

                  Row {
                    spacing: Style.space(8)

                    Repeater {
                      model: appCard.stores

                      Text {
                        required property var modelData
                        text: root.storeIcon(modelData)
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.body
                      }
                    }

                    Text {
                      text: String(modelData.name || modelData.id)
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.body
                      font.bold: true
                    }
                  }

                  Text {
                    text: root.groupSubtitle(modelData)
                    color: root.dim
                    font.family: root.fontFamily
                    font.pixelSize: Style.font.caption
                  }
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.toggleGroup(parent.modelData)
                }
              }
            }

            Row {
              width: parent.width
              spacing: Style.space(8)
              visible: root.playConfigured

              TextField {
                id: playPackageField
                width: parent.width - addPlayButton.width - parent.spacing
                placeholderText: "Add Play package (com.example.app)"
                foreground: root.foreground
              }

              Button {
                id: addPlayButton
                text: "Add"
                bordered: true
                enabled: !root.busy
                onClicked: root.addPlayPackage()
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
                model: root.watchedGroups

                Rectangle {
                  id: watchChip
                  required property var modelData
                  readonly property var ids: root.memberIds(modelData)
                  readonly property bool active: root.sameIdSet(ids, root.activeFamilyIds)
                  readonly property var stores: root.groupStores(modelData)
                  width: chipRow.implicitWidth + Style.space(20)
                  height: chipRow.implicitHeight + Style.space(10)
                  radius: height / 2
                  color: active ? Util.alpha(Color.accent, 0.22) : Util.alpha(root.foreground, 0.07)
                  border.width: active ? 1 : 0
                  border.color: Color.accent

                  Row {
                    id: chipRow
                    anchors.centerIn: parent
                    spacing: Style.space(6)

                    Repeater {
                      model: watchChip.stores

                      Text {
                        required property var modelData
                        text: root.storeIcon(modelData)
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                      }
                    }

                    Text {
                      text: String(watchChip.modelData.name || watchChip.ids[0] || "")
                      color: root.foreground
                      font.family: root.fontFamily
                      font.pixelSize: Style.font.bodySmall
                    }
                  }

                  MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.selectGroup(watchChip.ids)
                  }
                }
              }
            }

            Row {
              spacing: Style.space(8)

              Button {
                text: "All reviews"
                bordered: true
                selected: !root.unrepliedOnly
                onClicked: root.unrepliedOnly = false
              }

              Button {
                text: "Unreplied"
                bordered: true
                selected: root.unrepliedOnly
                onClicked: root.unrepliedOnly = true
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

            Text {
              visible: !root.busy && root.visibleReviews.length === 0
              width: parent.width
              text: root.unrepliedOnly ? "No unreplied reviews" : "No reviews yet"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            Text {
              visible: root.visibleReviews.length > 0 && root.selectedReview === null
              width: parent.width
              text: "Click a review to reply"
              color: root.dim
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Column {
              id: reviewList
              width: parent.width
              spacing: Style.space(8)

              Repeater {
                model: root.visibleReviews

                Rectangle {
                id: reviewCard
                required property var modelData
                required property int index
                readonly property bool expanded: !!(root.selectedReview && root.selectedReview.id === modelData.id)
                readonly property bool hasReply: !!(modelData.response)

                width: reviewList.width
                height: cardColumn.implicitHeight + Style.space(20)
                radius: Style.space(10)
                color: expanded
                  ? Style.selectedFillFor(root.foreground, Color.accent)
                  : Util.alpha(root.foreground, 0.05)
                opacity: (!root.selectedReview || expanded) ? 1 : 0.42
                border.width: expanded ? 1 : 0
                border.color: Color.accent
                clip: true

                Behavior on color {
                  ColorAnimation { duration: 140 }
                }

                Behavior on opacity {
                  NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
                }

                Timer {
                  id: expandAnimTimer
                  interval: 240
                  repeat: false
                  onTriggered: if (reviewCard.expanded) root.revealItem(reviewCard)
                }

                onExpandedChanged: expandAnimTimer.restart()
                onHeightChanged: if (expanded && !expandAnimTimer.running) root.revealItem(reviewCard)

                Column {
                  id: cardColumn
                  anchors.left: parent.left
                  anchors.right: parent.right
                  anchors.top: parent.top
                  anchors.margins: Style.space(12)
                  spacing: Style.space(8)

                  Item {
                    width: parent.width
                    height: headerColumn.implicitHeight

                    Column {
                      id: headerColumn
                      width: parent.width
                      spacing: Style.space(3)

                      Row {
                        width: parent.width
                        spacing: Style.space(8)

                        Text {
                          width: parent.width - (replyingBadge.visible ? replyingBadge.width + Style.space(8) : 0)
                          text: root.stars(modelData.rating) + "  " + String(modelData.title || "Untitled")
                          color: root.foreground
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.body
                          font.bold: true
                          elide: Text.ElideRight
                        }

                        Rectangle {
                          id: replyingBadge
                          visible: reviewCard.expanded && (!reviewCard.hasReply || root.sentReviewId === String(modelData.id))
                          anchors.verticalCenter: parent.verticalCenter
                          width: badgeText.implicitWidth + Style.space(12)
                          height: badgeText.implicitHeight + Style.space(4)
                          radius: height / 2
                          color: Util.alpha(Color.accent, 0.22)
                          border.width: 1
                          border.color: Color.accent

                          Text {
                            id: badgeText
                            anchors.centerIn: parent
                            text: reviewCard.hasReply ? "Sent" : "Replying"
                            color: Color.accent
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: true
                          }
                        }
                      }

                      Row {
                        width: parent.width
                        spacing: Style.space(6)

                        Text {
                          text: root.storeIcon(modelData.store)
                          color: root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.bodySmall
                        }

                        Text {
                          width: parent.width - Style.space(22)
                          text: [modelData.version, modelData.nickname, modelData.territory, root.shortDate(modelData.createdDate)].filter(function(value) {
                            return String(value || "") !== ""
                          }).join(" · ")
                          color: root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                          elide: Text.ElideRight
                        }
                      }
                    }

                    MouseArea {
                      anchors.fill: parent
                      cursorShape: Qt.PointingHandCursor
                      onClicked: {
                        var reviewId = String(reviewCard.modelData.id || "")
                        root.toggleReview(reviewCard.modelData)
                        if (root.selectedReview && String(root.selectedReview.id) === reviewId)
                          Qt.callLater(function() { root.revealItem(reviewCard) })
                      }
                    }
                  }

                    Item {
                    id: expandWrap
                    width: parent.width
                    height: reviewCard.expanded ? expandColumn.implicitHeight : 0
                    clip: true
                    opacity: reviewCard.expanded ? 1 : 0

                    Behavior on height {
                      enabled: expandAnimTimer.running || !reviewCard.expanded
                      NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
                    }

                    Behavior on opacity {
                      NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                    }

                    Column {
                      id: expandColumn
                      width: parent.width
                      spacing: Style.space(10)
                      opacity: expandWrap.opacity
                      y: reviewCard.expanded ? 0 : Style.space(-6)

                      Behavior on y {
                        NumberAnimation { duration: 220; easing.type: Easing.OutCubic }
                      }

                      Rectangle {
                        width: parent.width
                        height: quoteColumn.implicitHeight + Style.space(16)
                        radius: Style.space(8)
                        color: Util.alpha(root.foreground, 0.06)

                        Rectangle {
                          width: Style.space(3)
                          anchors.left: parent.left
                          anchors.top: parent.top
                          anchors.bottom: parent.bottom
                          anchors.margins: Style.space(8)
                          radius: width / 2
                          color: Color.accent
                        }

                        Column {
                          id: quoteColumn
                          anchors.left: parent.left
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          anchors.leftMargin: Style.space(18)
                          anchors.rightMargin: Style.space(10)
                          spacing: Style.space(4)

                          Text {
                            width: parent.width
                            text: String(modelData.body || "")
                            color: root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.body
                            wrapMode: Text.WordWrap
                          }
                        }
                      }

                      Rectangle {
                        visible: !reviewCard.hasReply
                        width: parent.width
                        height: targetColumn.implicitHeight + Style.space(16)
                        radius: Style.space(8)
                        color: Util.alpha(Color.accent, 0.16)
                        border.width: 1
                        border.color: Color.accent

                        Column {
                          id: targetColumn
                          anchors.left: parent.left
                          anchors.right: parent.right
                          anchors.verticalCenter: parent.verticalCenter
                          anchors.margins: Style.space(10)
                          spacing: Style.space(2)

                          Text {
                            text: "Replying to"
                            color: Color.accent
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            font.bold: true
                          }

                          Text {
                            width: parent.width
                            text: root.reviewerName(modelData)
                            color: root.foreground
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.subtitle
                            font.bold: true
                            elide: Text.ElideRight
                          }

                          Text {
                            width: parent.width
                            text: [root.stars(modelData.rating), String(modelData.title || "Untitled"), root.appNameFor(root.activeAppId)].filter(function(value) {
                              return String(value || "") !== ""
                            }).join(" · ")
                            color: root.dim
                            font.family: root.fontFamily
                            font.pixelSize: Style.font.caption
                            elide: Text.ElideRight
                          }
                        }
                      }

                      Text {
                        width: parent.width
                        visible: reviewCard.hasReply && root.reviewStore(modelData) !== "play"
                        text: "Your reply to " + root.reviewerName(modelData)
                        color: root.dim
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.caption
                        font.bold: true
                      }

                      Text {
                        width: parent.width
                        visible: reviewCard.hasReply && root.reviewStore(modelData) !== "play"
                        text: reviewCard.hasReply ? String(modelData.response.body || "") : ""
                        color: root.foreground
                        font.family: root.fontFamily
                        font.pixelSize: Style.font.bodySmall
                        wrapMode: Text.WordWrap
                      }

                        Loader {
                        id: composerLoader
                        width: parent.width
                        height: (!reviewCard.hasReply || root.reviewStore(modelData) === "play")
                          ? (item ? item.boxHeight : Style.space(160))
                          : 0
                        active: (!reviewCard.hasReply || root.reviewStore(modelData) === "play") && (reviewCard.expanded || expandWrap.height > 8)

                        sourceComponent: Component {
                          Item {
                            id: composerRoot
                            readonly property int boxMin: Style.space(160)
                            readonly property int boxMax: Style.space(380)
                            readonly property int boxHeight: Math.min(boxMax, Math.max(boxMin, inlineReply.contentHeight + Style.space(28)))
                            implicitHeight: boxHeight
                            height: boxHeight
                            width: parent.width

                            BorderSurface {
                              anchors.fill: parent
                              color: Style.controlFill(inlineReply.activeFocus, inlineReply.hovered, root.foreground, Color.accent)
                              borderSpec: Border.controlSpec(inlineReply.activeFocus ? "focus" : "normal", root.foreground, Color.accent)
                              radius: Style.cornerRadius

                              ScrollView {
                                id: replyScroll
                                anchors.fill: parent
                                anchors.margins: Style.space(8)
                                clip: true
                                contentWidth: availableWidth
                                ScrollBar.vertical.policy: composerRoot.boxHeight >= composerRoot.boxMax
                                  ? ScrollBar.AlwaysOn
                                  : ScrollBar.AsNeeded

                                TextArea {
                                  id: inlineReply
                                  width: replyScroll.availableWidth
                                  text: root.replyDraft
                                  placeholderText: "Public reply to " + root.reviewerName(reviewCard.modelData)
                                  placeholderTextColor: root.dim
                                  wrapMode: TextEdit.Wrap
                                  selectByMouse: true
                                  color: root.foreground
                                  selectionColor: Style.selectionFillFor(root.foreground, Color.accent)
                                  selectedTextColor: root.foreground
                                  font.family: root.fontFamily
                                  font.pixelSize: Style.font.body
                                  background: null
                                  onTextChanged: if (reviewCard.expanded) root.replyDraft = text
                                }
                              }
                            }
                          }
                        }
                      }

                      Row {
                        spacing: Style.space(8)

                        Button {
                          visible: !reviewCard.hasReply
                          text: root.busy ? "Sending…" : "Reply to " + root.reviewerName(modelData)
                          bordered: true
                          enabled: !root.busy
                          onClicked: root.submitReply()
                        }

                        Button {
                          visible: reviewCard.hasReply && root.reviewStore(modelData) === "play"
                          text: root.busy ? "Saving…" : "Update reply"
                          bordered: true
                          enabled: !root.busy
                          onClicked: root.submitReply()
                        }

                        Button {
                          visible: reviewCard.hasReply && root.reviewStore(modelData) !== "play"
                          text: "Delete reply"
                          bordered: true
                          enabled: !root.busy
                          onClicked: root.removeReply()
                        }

                        Text {
                          anchors.verticalCenter: parent.verticalCenter
                          visible: !reviewCard.hasReply || root.reviewStore(modelData) === "play"
                          text: String(root.replyDraft.length) + " / " + root.replyLimitFor(modelData)
                          color: root.replyDraft.length > root.replyLimitFor(modelData) ? root.urgent : root.dim
                          font.family: root.fontFamily
                          font.pixelSize: Style.font.caption
                        }
                      }
                    }
                  }
                }
                }
              }
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
