import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "ryuhzk.customer-reviews"

  readonly property var reviewsService: bar && bar.shell
    ? bar.shell.serviceFor(moduleName) : null
  readonly property int panelWidth: boundedInt(setting("panelWidth", 720), 420, 1100)
  readonly property int pollIntervalSec: boundedInt(setting("pollIntervalSec", 10800), 3600, 43200)
  readonly property bool unrepliedOnly: setting("unrepliedOnly", true) === true
  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property int unrepliedCount: reviewsService ? Number(reviewsService.unrepliedCount || 0) : 0
  readonly property string barLabel: unrepliedCount > 0 ? ("Reviews " + unrepliedCount) : "Reviews"

  Binding { target: root.reviewsService; property: "pollIntervalSec"; value: root.pollIntervalSec; when: root.reviewsService !== null }

  function boundedInt(value, minimum, maximum) {
    var parsed = parseInt(String(value), 10)
    if (!isFinite(parsed)) parsed = minimum
    return Math.max(minimum, Math.min(maximum, parsed))
  }

  function open() {
    if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item) panelLoader.item.close()
  }

  function toggle() {
    if (panelLoader.item) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  function injectPanel() {
    if (!panelLoader.item) return
    panelLoader.item.bar = root.bar
    panelLoader.item.anchorItem = root
    panelLoader.item.hostWidget = root
    panelLoader.item.reviewsService = root.reviewsService
    panelLoader.item.panelWidth = root.panelWidth
    panelLoader.item.unrepliedOnly = root.unrepliedOnly
  }

  implicitWidth: row.implicitWidth + Style.space(14)
  implicitHeight: barSize

  onBarChanged: injectPanel()
  onReviewsServiceChanged: injectPanel()
  onPanelWidthChanged: injectPanel()
  onUnrepliedOnlyChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  Row {
    id: row
    anchors.centerIn: parent
    spacing: Style.space(6)

    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: "󰓀"
      color: root.bar ? root.bar.barForeground : Color.foreground
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      text: root.barLabel
      color: root.bar ? root.bar.barForeground : Color.foreground
      font.family: root.bar ? root.bar.fontFamily : Style.font.family
      font.pixelSize: Style.font.body
    }
  }

  MouseArea {
    anchors.fill: parent
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: root.toggle()
    onEntered: if (root.bar) root.bar.showTooltip(root, "Customer Reviews")
    onExited: if (root.bar) root.bar.hideTooltip(root)
  }
}
