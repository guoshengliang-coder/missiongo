import XCTest
@testable import MissionGoNodeCore

final class AgentSessionAnswerTraceTests: XCTestCase {
    private func card(_ id: String, questions: [AgentSessionQuestion]) -> AgentSessionMessage {
        AgentSessionMessage(sourceId: id, role: "agent", text: "Choose", questions: questions)
    }

    private func reply(_ id: String, _ text: String) -> AgentSessionMessage {
        AgentSessionMessage(sourceId: id, role: "user", text: text)
    }

    func testRestoresSingleChoiceDespiteInterveningAgentProgress() {
        let messages = AgentSessionAnswerTrace.markingAnswered([
            card("q1", questions: [AgentSessionQuestion(title: "Approve?", options: ["Approve", "Wait"])]),
            AgentSessionMessage(sourceId: "progress", role: "agent", text: "Still waiting."),
            reply("a1", "Approve"),
        ])
        XCTAssertEqual(messages[0].questions?.first?.answered, "Approve")
        XCTAssertEqual(messages[1].questions, nil)
    }

    func testRestoresLabelledMultipleChoicesWithRepeatedOptionWords() {
        let messages = AgentSessionAnswerTrace.markingAnswered([
            card("q1", questions: [
                AgentSessionQuestion(header: "Scope", title: "Choose scope", options: ["Full", "None"]),
                AgentSessionQuestion(header: "Tests", title: "Run tests", options: ["Full", "None"]),
            ]),
            reply("a1", "Scope: Full\nTests: None"),
        ])
        XCTAssertEqual(messages[0].questions?.map(\.answered), ["Full", "None"])
    }

    func testDoesNotGuessFromUnrelatedOrAmbiguousReplies() {
        let question = AgentSessionQuestion(title: "Approve?", options: ["Approve", "Wait"])
        let messages = AgentSessionAnswerTrace.markingAnswered([
            card("q1", questions: [question]),
            reply("a1", "Please explain first"),
            reply("a2", "Approve"),
            card("q2", questions: [question]),
            reply("a3", "Wait"),
        ])
        XCTAssertNil(messages[0].questions?.first?.answered)
        XCTAssertEqual(messages[3].questions?.first?.answered, "Wait")

        let ambiguous = AgentSessionAnswerTrace.markingAnswered([
            card("q3", questions: [question, question]),
            reply("a4", "Approve?：Approve"),
        ])
        XCTAssertEqual(ambiguous[0].questions?.compactMap(\.answered), [])
    }

    func testKeepsExistingAnswerAndSupportsListedMultiSelection() {
        let messages = AgentSessionAnswerTrace.markingAnswered([
            card("q1", questions: [
                AgentSessionQuestion(title: "Pick", options: ["A", "B"], multiSelect: true),
            ]),
            reply("a1", "A、B"),
        ])
        XCTAssertEqual(messages[0].questions?.first?.answered, "A、B")
        XCTAssertEqual(AgentSessionAnswerTrace.markingAnswered(messages), messages)
    }
}
