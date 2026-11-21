import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct TurnActivityWidgets: WidgetBundle {
    var body: some Widget { TurnActivityWidget() }
}

/// The madani palette (the app's Madani look) and each bot colour as the app paints it.
private enum Palette {
    static let ground = Color(hex: 0x0C0B0E)
    static let raised = Color(hex: 0x2B2630)
    static let ink = Color(hex: 0xF4EFF6)
    static let secondary = Color(hex: 0xB9AFBD)
    static let accent = Color(hex: 0x765683)
    static let accentText = Color(hex: 0xC49BD2)
    static let success = Color(hex: 0x6FAD83)
    static let eyes = Color(hex: 0x121014)

    static func bot(_ name: String) -> Color {
        let colors: [String: UInt32] = [
            "green": 0x009957, "blue": 0x377FE6, "red": 0xD94B52, "orange": 0xE78531, "purple": 0x8057C8, "cyan": 0x0EA5C6,
            "pink": 0xD84F8B, "yellow": 0xD8A729, "teal": 0x01A492, "coral": 0xE5634E, "brown": 0xA06B39, "silver": 0xA8ADB4,
            "chrome": 0xB3BAC4,
        ]
        return Color(hex: colors[name] ?? 0x8057C8)
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255)
    }
}

/// The bot's own pixel body, drawn cell by cell from the app's still frame.
struct MascotView: View {
    let shape: String
    let color: String
    let size: CGFloat

    var body: some View {
        let code = MascotBodies.codes[shape] ?? MascotBodies.codes["kit"] ?? ""
        let parts = code.split(separator: ":", maxSplits: 1)
        let grid = Int(parts.first ?? "") ?? 0
        let cells = Array(parts.last ?? "")
        Canvas { context, canvas in
            guard grid > 0, cells.count == grid * grid else { return }
            let cell = min(canvas.width, canvas.height) / CGFloat(grid)
            for index in cells.indices where cells[index] != "0" {
                let rect = CGRect(x: CGFloat(index % grid) * cell, y: CGFloat(index / grid) * cell, width: cell + 0.3, height: cell + 0.3)
                context.fill(Path(rect), with: .color(cells[index] == "2" ? Palette.eyes : Palette.bot(color)))
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private extension MadaniTurnAttributes.ContentState {
    var needsYou: Bool { phase == "needs-you" }

    /// the compact island's word
    var shortWord: String {
        switch phase {
        case "needs-you": return "Needs you"
        case "done": return "Done"
        case "stopped": return "Stopped"
        default:
            switch step {
            case "web": return "Searching"
            case "read", "fetch": return "Reading"
            case "write": return "Writing"
            case "edit": return "Editing"
            case "command": return "Running"
            case "search": return "Looking"
            case "tool": return "Working"
            default: return "Thinking"
            }
        }
    }

    /// the expanded island's and the lock screen's line
    var longWord: String {
        switch phase {
        case "needs-you": return ask?.kind == "approve" ? "Wants your approval" : "Has a question for you"
        case "done": return "Done"
        case "stopped": return "Didn't finish"
        default:
            switch step {
            case "web": return "Searching the web"
            case "read": return "Reading a file"
            case "fetch": return "Reading a page"
            case "write": return "Writing a file"
            case "edit": return "Editing a file"
            case "command": return "Running a command"
            case "search": return "Searching"
            case "tool": return "Working"
            default: return "Thinking"
            }
        }
    }

    var stepLine: String? { steps > 0 ? (steps == 1 ? "1 step" : "\(steps) steps") : nil }
}

private func chatURL(_ attributes: MadaniTurnAttributes) -> URL? {
    var parts = URLComponents()
    parts.scheme = "madanibot"
    parts.host = "open"
    parts.queryItems = [URLQueryItem(name: "bot", value: attributes.botId)]
        + (attributes.groupId.map { [URLQueryItem(name: "group", value: $0)] } ?? [])
        + [URLQueryItem(name: "thread", value: attributes.threadId)]
    return parts.url
}

/// Approve runs the intent (Face ID, then the app opens and approves); Answer opens the question.
struct AskButton: View {
    let attributes: MadaniTurnAttributes
    let ask: MadaniTurnAttributes.Ask

    var body: some View {
        if ask.kind == "approve" {
            Button(intent: ApproveAskIntent(requestId: ask.requestId, threadId: attributes.threadId, botId: attributes.botId, groupId: attributes.groupId)) {
                label("Approve", symbol: "checkmark")
            }
            .buttonStyle(.plain)
        } else if let url = chatURL(attributes) {
            Link(destination: url) { label("Answer", symbol: "text.bubble") }
        }
    }

    private func label(_ title: String, symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(Palette.accent, in: Capsule())
    }
}

/// Ends this thread's activity now. The glyph stays small; the tap area reaches 44pt without growing the layout.
struct CloseButton: View {
    let attributes: MadaniTurnAttributes

    var body: some View {
        Button(intent: CloseTurnActivityIntent(threadId: attributes.threadId)) {
            Image(systemName: "xmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(Palette.secondary)
                .frame(width: 26, height: 26)
                .background(Palette.raised, in: Circle())
                .padding(9)
                .contentShape(Rectangle())
                .padding(-9)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Close")
    }
}

struct Elapsed: View {
    let state: MadaniTurnAttributes.ContentState

    var body: some View {
        Group {
            if state.ended {
                Image(systemName: state.phase == "done" ? "checkmark.circle.fill" : "xmark.circle.fill")
                    .foregroundStyle(state.phase == "done" ? Palette.success : Palette.secondary)
                    .accessibilityLabel(state.phase == "done" ? "Done" : "Didn't finish")
            } else {
                Text(timerInterval: state.started...Date.distantFuture, countsDown: false)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
            }
        }
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(Palette.secondary)
    }
}

struct TurnLockScreen: View {
    let attributes: MadaniTurnAttributes
    let state: MadaniTurnAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                MascotView(shape: attributes.body, color: attributes.color, size: 40)
                VStack(alignment: .leading, spacing: 2) {
                    Text(attributes.botName).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                    Text(detail).font(.system(size: 14)).foregroundStyle(state.needsYou ? Palette.accentText : Palette.secondary).lineLimit(2)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Elapsed(state: state).frame(maxWidth: 64, alignment: .trailing)
                    if let steps = state.stepLine, !state.ended { Text(steps).font(.system(size: 12)).foregroundStyle(Palette.secondary) }
                }
                CloseButton(attributes: attributes)
            }
            if state.needsYou, let ask = state.ask { AskButton(attributes: attributes, ask: ask) }
        }
        .padding(16)
    }

    private var detail: String {
        if state.phase == "done", let line = state.doneLine { return line }
        return state.longWord
    }
}

struct TurnActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MadaniTurnAttributes.self) { context in
            TurnLockScreen(attributes: context.attributes, state: context.state)
                .activityBackgroundTint(Palette.ground)
                .activitySystemActionForegroundColor(Palette.ink)
                .widgetURL(chatURL(context.attributes))
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    MascotView(shape: context.attributes.body, color: context.attributes.color, size: 36).padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 10) {
                        Elapsed(state: state).frame(maxWidth: 64, alignment: .trailing)
                        CloseButton(attributes: context.attributes)
                    }
                    .padding(.trailing, 4)
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(spacing: 2) {
                        Text(context.attributes.botName).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                        Text(state.phase == "done" ? (state.doneLine ?? "Done") : state.longWord)
                            .font(.system(size: 13)).foregroundStyle(state.needsYou ? Palette.accentText : Palette.secondary).lineLimit(2)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if state.needsYou, let ask = state.ask {
                        AskButton(attributes: context.attributes, ask: ask).padding(.top, 4)
                    } else if let steps = state.stepLine, !state.ended {
                        Text(steps).font(.system(size: 12)).foregroundStyle(Palette.secondary)
                    }
                }
            } compactLeading: {
                MascotView(shape: context.attributes.body, color: context.attributes.color, size: 20)
            } compactTrailing: {
                Text(state.shortWord)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(state.needsYou ? Palette.accentText : Palette.ink)
                    .lineLimit(1)
                    .frame(maxWidth: 76)
            } minimal: {
                MascotView(shape: context.attributes.body, color: context.attributes.color, size: 18)
            }
            .widgetURL(chatURL(context.attributes))
            .keylineTint(Palette.bot(context.attributes.color))
        }
    }
}
