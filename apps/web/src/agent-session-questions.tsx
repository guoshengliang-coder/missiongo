import {
  questionAnswerText,
  questionAnswerValue,
  questionAnswerValues,
  toggleQuestionOption,
} from "./agent-session-view";
import { useI18n } from "./i18n";
import type { AgentSessionQuestion } from "./types";

/**
 * The one place a session's questions are drawn, so Claude Code, Codex and
 * OpenCode all offer the same controls in the console and the item panel. A
 * key-less question keeps the older button-only behaviour; a keyed OpenCode
 * form field can also be free text, a number or a yes/no choice.
 */
export function AgentSessionQuestions({
  questions,
  reply,
  canReply,
  onChange,
}: {
  questions: readonly AgentSessionQuestion[];
  reply: string;
  canReply: boolean;
  onChange: (next: string) => void;
}) {
  const { t } = useI18n();
  const count = questions.length;
  const write = (question: AgentSessionQuestion, value: string) =>
    onChange(questionAnswerText(reply, question, value, count));

  return (
    <>
      {questions.map((question, index) => {
        const label = question.key ?? question.header ?? question.title;
        const disabled = !canReply;
        const chosen = questionAnswerValue(reply, question);
        return (
          <div key={`${label}-${index}`} className="agent-session-question">
            {question.header && <small>{question.header}</small>}
            <strong>{question.title}</strong>
            {question.kind === "boolean" ? (
              <div className="agent-session-options">
                {[t("agentSessionAnswerYes"), t("agentSessionAnswerNo")].map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={disabled}
                    className={chosen === option ? "selected" : ""}
                    onClick={() => write(question, option)}
                  >{option}</button>
                ))}
              </div>
            ) : question.kind === "text" || question.kind === "number" ? (
              <input
                className="agent-session-question-input"
                type={question.kind === "number" ? "number" : "text"}
                value={chosen}
                placeholder={question.placeholder}
                disabled={disabled}
                onChange={(event) => write(question, event.target.value)}
              />
            ) : question.options ? (
              <div className="agent-session-options">
                {question.options.map((option) => {
                  const selected = question.multiSelect
                    ? questionAnswerValues(reply, question).includes(option)
                    : chosen === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      className={selected ? "selected" : ""}
                      onClick={() => onChange(question.multiSelect
                        ? toggleQuestionOption(reply, question, option, count)
                        : questionAnswerText(reply, question, option, count))}
                    >{option}</button>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
