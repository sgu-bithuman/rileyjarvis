// mac-bridge — native macOS perception + input helper for Ricky.
//
// One CLI, JSON out. Gives the app what AppleScript can't:
//   - accurate Accessibility geometry (click named elements, not guessed pixels)
//   - reliable CGEvent input (real cursor, modifiers, double/right click, scroll wheel)
//
// Commands:
//   permcheck                       -> {accessibility, screenRecording}
//   displayinfo                     -> {width, height, scale}   (main display, logical points + backing scale)
//   frontapp                        -> {app, bundle, pid, window}
//   axdump [maxElements]            -> {app, window, elements:[{i,role,label,x,y,w,h,cx,cy,actionable}]}
//   click <x> <y> [count] [left|right]
//   move <x> <y>
//   drag <x1> <y1> <x2> <y2>
//   scroll <dx> <dy>                (line units; +dy scrolls up, -dy down)
//   key <combo>                     (e.g. "cmd+c", "cmd+shift+t", "return", "escape", "arrowdown")
//   type <text...>                  (unicode, no modifiers — for entering text)
//
// All coordinates are LOGICAL POINTS in the global top-left-origin space, which is what
// both AXPosition and CGEvent use — so axdump geometry maps 1:1 to click coordinates.

import Cocoa
import ApplicationServices

// MARK: - output

func emit(_ obj: [String: Any]) {
    var o = obj
    if o["ok"] == nil { o["ok"] = true }
    if let data = try? JSONSerialization.data(withJSONObject: o, options: []),
       let s = String(data: data, encoding: .utf8) {
        print(s)
    } else {
        print("{\"ok\":false,\"error\":\"json_encode_failed\"}")
    }
}

func fail(_ msg: String) -> Never {
    emit(["ok": false, "error": msg])
    exit(1)
}

// MARK: - AX helpers

func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var ref: CFTypeRef?
    return AXUIElementCopyAttributeValue(el, attr as CFString, &ref) == .success ? ref : nil
}

func axString(_ el: AXUIElement, _ attr: String) -> String? {
    guard let v = axCopy(el, attr) else { return nil }
    if CFGetTypeID(v) == CFStringGetTypeID() {
        let s = v as! CFString as String
        return s.isEmpty ? nil : s
    }
    if CFGetTypeID(v) == CFNumberGetTypeID() {
        return "\(v as! NSNumber)"
    }
    return nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axCopy(el, kAXPositionAttribute as String),
          let s = axCopy(el, kAXSizeAttribute as String),
          CFGetTypeID(p) == AXValueGetTypeID(),
          CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &point)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    return CGRect(origin: point, size: size)
}

func axChildren(_ el: AXUIElement) -> [AXUIElement] {
    guard let v = axCopy(el, kAXChildrenAttribute as String) else { return [] }
    return (v as? [AXUIElement]) ?? []
}

let ACTIONABLE: Set<String> = [
    "AXButton", "AXMenuButton", "AXPopUpButton", "AXMenuItem", "AXMenuBarItem",
    "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXComboBox",
    "AXLink", "AXSlider", "AXDisclosureTriangle", "AXTab", "AXSearchField",
    "AXStepper", "AXSegmentedControl", "AXToolbarButton", "AXCell", "AXRow",
]

// MARK: - CGEvent helpers

let src = CGEventSource(stateID: .hidSystemState)

func post(_ e: CGEvent?) {
    e?.post(tap: .cghidEventTap)
    usleep(14000)
}

func moveMouse(_ pt: CGPoint) {
    post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left))
}

func clickMouse(_ x: Double, _ y: Double, button: String, count: Int) {
    let pt = CGPoint(x: x, y: y)
    let isRight = button == "right"
    let down: CGEventType = isRight ? .rightMouseDown : .leftMouseDown
    let up: CGEventType = isRight ? .rightMouseUp : .leftMouseUp
    let btn: CGMouseButton = isRight ? .right : .left
    moveMouse(pt)
    for c in 1...max(1, count) {
        let d = CGEvent(mouseEventSource: src, mouseType: down, mouseCursorPosition: pt, mouseButton: btn)
        d?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
        post(d)
        let u = CGEvent(mouseEventSource: src, mouseType: up, mouseCursorPosition: pt, mouseButton: btn)
        u?.setIntegerValueField(.mouseEventClickState, value: Int64(c))
        post(u)
    }
}

func dragMouse(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) {
    let a = CGPoint(x: x1, y: y1)
    let b = CGPoint(x: x2, y: y2)
    moveMouse(a)
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDown, mouseCursorPosition: a, mouseButton: .left))
    let steps = 12
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t)
        post(CGEvent(mouseEventSource: src, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
    }
    post(CGEvent(mouseEventSource: src, mouseType: .leftMouseUp, mouseCursorPosition: b, mouseButton: .left))
}

func scrollWheel(_ dx: Int, _ dy: Int) {
    post(CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2,
                 wheel1: Int32(dy), wheel2: Int32(dx), wheel3: 0))
}

let KEYCODES: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45,
    "m": 46, ".": 47, "`": 50,
    "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53, "forwarddelete": 117,
    "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124,
    "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98,
    "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressCombo(_ combo: String) {
    var flags: CGEventFlags = []
    var keyName = ""
    for raw in combo.lowercased().split(separator: "+") {
        let tok = String(raw)
        switch tok {
        case "cmd", "command", "meta", "super": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "opt", "option", "alt": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        case "fn", "function": flags.insert(.maskSecondaryFn)
        default: keyName = tok
        }
    }
    guard let code = KEYCODES[keyName] else { fail("unknown key: \(keyName)") }
    let d = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
    d?.flags = flags
    post(d)
    let u = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
    u?.flags = flags
    post(u)
}

func typeText(_ text: String) {
    for ch in text {
        var utf16 = Array(String(ch).utf16)
        let d = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
        d?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        post(d)
        let u = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
        u?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: &utf16)
        post(u)
    }
}

// MARK: - commands

func cmdPermcheck() {
    let ax = AXIsProcessTrusted()
    let sr = CGPreflightScreenCaptureAccess()
    emit(["accessibility": ax, "screenRecording": sr])
}

func cmdDisplayInfo() {
    let id = CGMainDisplayID()
    let b = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    let pw = Double(mode?.pixelWidth ?? Int(b.width))
    let scale = b.width > 0 ? pw / Double(b.width) : 1.0
    emit(["width": Int(b.width), "height": Int(b.height), "scale": scale])
}

func frontApp() -> (NSRunningApplication?, AXUIElement?) {
    guard let app = NSWorkspace.shared.frontmostApplication else { return (nil, nil) }
    return (app, AXUIElementCreateApplication(app.processIdentifier))
}

func rootWindow(_ appEl: AXUIElement) -> AXUIElement {
    if let w = axCopy(appEl, kAXFocusedWindowAttribute as String), CFGetTypeID(w) == AXUIElementGetTypeID() {
        return (w as! AXUIElement)
    }
    if let w = axCopy(appEl, kAXMainWindowAttribute as String), CFGetTypeID(w) == AXUIElementGetTypeID() {
        return (w as! AXUIElement)
    }
    let wins = axChildren(appEl)
    return wins.first ?? appEl
}

func cmdFrontApp() {
    let (app, appEl) = frontApp()
    var win = ""
    if let appEl = appEl {
        win = axString(rootWindow(appEl), kAXTitleAttribute as String) ?? ""
    }
    emit([
        "app": app?.localizedName ?? "",
        "bundle": app?.bundleIdentifier ?? "",
        "pid": Int(app?.processIdentifier ?? 0),
        "window": win,
    ])
}

func cmdAxDump(_ maxEl: Int) {
    let (app, appEl) = frontApp()
    guard let appEl = appEl else { fail("no frontmost application") }
    let win = rootWindow(appEl)
    let windowTitle = axString(win, kAXTitleAttribute as String) ?? ""

    var elements: [[String: Any]] = []
    var index = 0

    func walk(_ el: AXUIElement, _ depth: Int) {
        if elements.count >= maxEl || depth > 16 { return }
        let role = axString(el, kAXRoleAttribute as String) ?? ""
        let label = axString(el, kAXTitleAttribute as String)
            ?? axString(el, kAXDescriptionAttribute as String)
            ?? axString(el, kAXValueAttribute as String)
            ?? axString(el, kAXHelpAttribute as String)
            ?? ""
        let actionable = ACTIONABLE.contains(role)
        if let f = axFrame(el), f.width >= 2, f.height >= 2, (actionable || !label.isEmpty) {
            elements.append([
                "i": index,
                "role": role,
                "label": String(label.prefix(120)),
                "x": Int(f.minX), "y": Int(f.minY),
                "w": Int(f.width), "h": Int(f.height),
                "cx": Int(f.midX), "cy": Int(f.midY),
                "actionable": actionable,
            ])
            index += 1
        }
        for c in axChildren(el) {
            walk(c, depth + 1)
            if elements.count >= maxEl { return }
        }
    }
    walk(win, 0)

    emit([
        "app": app?.localizedName ?? "",
        "window": windowTitle,
        "count": elements.count,
        "elements": elements,
    ])
}

// MARK: - dispatch

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("no command") }

func num(_ i: Int, _ dflt: Double = 0) -> Double {
    guard i < args.count, let v = Double(args[i]) else { return dflt }
    return v
}

switch cmd {
case "permcheck":
    cmdPermcheck()
case "displayinfo":
    cmdDisplayInfo()
case "frontapp":
    cmdFrontApp()
case "axdump":
    cmdAxDump(Int(num(1, 200)))
case "click":
    var clickCount = 1
    var clickButton = "left"
    for a in args.dropFirst(3) {
        if let n = Int(a) { clickCount = n } else if a == "left" || a == "right" { clickButton = a }
    }
    clickMouse(num(1), num(2), button: clickButton, count: clickCount)
    emit(["message": "clicked"])
case "move":
    moveMouse(CGPoint(x: num(1), y: num(2)))
    emit(["message": "moved"])
case "drag":
    dragMouse(num(1), num(2), num(3), num(4))
    emit(["message": "dragged"])
case "scroll":
    scrollWheel(Int(num(1)), Int(num(2)))
    emit(["message": "scrolled"])
case "key":
    guard args.count > 1 else { fail("key needs a combo") }
    pressCombo(args[1])
    emit(["message": "pressed \(args[1])"])
case "type":
    let text = args.dropFirst().joined(separator: " ")
    typeText(text)
    emit(["message": "typed \(text.count) chars"])
default:
    fail("unknown command: \(cmd)")
}
