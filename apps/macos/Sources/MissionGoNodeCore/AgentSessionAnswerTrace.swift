import Foundation

/// Restore a choice only when a visible user reply identifies a listed option.
/// Both Codex's thread reads and Claude's saved transcript contain the original
/// question and reply, including conversations that predate answered cards.
public enum AgentSessionAnswerTrace {
    public static func markingAnswered(_ messages: [AgentSessionMessage]) -> [AgentSessionMessage] {
        var result = messages
        var latestQuestionIndex: Int?

        for index in result.indices {
            let message = result[index]
            if message.role == "agent", message.questions?.isEmpty == false {
                latestQuestionIndex = index
                continue
            }
            guard message.role == "user", let questionIndex = latestQuestionIndex,
                  let questions = result[questionIndex].questions else { continue }
            // Only the first visible reply after a card can answer it. A later
            // unrelated message that happens to equal an option is not proof.
            latestQuestionIndex = nil

            let answers = answers(in: message.text, for: questions)
            guard !answers.isEmpty else { continue }
            let card = result[questionIndex]
            let updated = questions.enumerated().map { offset, question in
                guard question.answered == nil, let answer = answers[offset] else { return question }
                return AgentSessionQuestion(
                    header: question.header, title: question.title, detail: question.detail,
                    options: question.options, multiSelect: question.multiSelect, key: question.key,
                    kind: question.kind, placeholder: question.placeholder, custom: question.custom,
                    answered: answer
                )
            }
            result[questionIndex] = AgentSessionMessage(
                sourceId: card.sourceId, turnId: card.turnId, role: card.role,
                phase: card.phase, text: card.text, occurredAt: card.occurredAt,
                questions: updated
            )
        }
        return result
    }

    private static func answers(in rawReply: String, for questions: [AgentSessionQuestion]) -> [Int: String] {
        let reply = rawReply.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reply.isEmpty else { return [:] }
        if questions.count == 1, questions[0].key == nil,
           let answer = listedAnswer(reply, for: questions[0]) {
            return [0: answer]
        }

        var answers: [Int: String] = [:]
        let lines = reply.split(separator: "\n", omittingEmptySubsequences: true)
        for line in lines {
            let value = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let matches = questions.enumerated().compactMap { index, question -> (Int, String)? in
                let label = question.key ?? question.header ?? question.title
                guard value.hasPrefix("\(label): ") || value.hasPrefix("\(label)：") else { return nil }
                let answer = value.dropFirst(label.count + (value.hasPrefix("\(label): ") ? 2 : 1))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                guard let listed = listedAnswer(answer, for: question) else { return nil }
                return (index, listed)
            }
            // A duplicate label could select several cards. Leave it unsettled.
            if matches.count == 1 { answers[matches[0].0] = matches[0].1 }
        }
        return answers
    }

    private static func listedAnswer(_ answer: String, for question: AgentSessionQuestion) -> String? {
        guard let options = question.options, !options.isEmpty else { return nil }
        if options.contains(answer) { return answer }
        guard question.multiSelect == true else { return nil }
        let selected = answer.split(separator: "、").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        return !selected.isEmpty && selected.allSatisfy(options.contains) ? answer : nil
    }
}
