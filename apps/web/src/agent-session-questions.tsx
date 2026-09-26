import {
  answeredOptionSelected,
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
 *
 * A question may carry a longer `detail` under its short `title` — OpenCode's
 * question tool keeps the real ask in the form field's description — and a
 * field marked `custom` also takes an answer the person types.
 *
 * A question marked `answered` is settled history: the controls disable and
 * the chosen option stays highlighted, so scrolling back no longer reads as a
 * fresh ask (AND-227).
 */
export function AgentSessionQuestions({
  questions,
  reply,
  canReply,
  onChange,
  onPick,
}: {
  questions: readonly AgentSessionQuestion[];
  reply: string;
  canReply: boolean;
  onChange: (next: string) => void;
  /** Called when a listed option is picked: the reply box below has the new
   * text, and a small viewport may not show it — the caller scrolls so the
   * pick has a visible effect (AND-218). */
  onPick?: () => void;
}) {
  const { t } = useI18n();
  const count = questions.length;
  const write = (question: AgentSessionQuestion, value: string) =>
    onChange(questionAnswerText(reply, question, value, count));

  return (
    <>
      {questions.map((question, index) => {
        const label = question.key ?? question.header ?? question.title;
        const settled = question.answered !== undefined;
        const disabled = !canReply || settled;
        const chosen = questionAnswerValue(reply, question);
        const typed = question.kind === "text" || question.kind === "number";
        const custom = question.custom === true && question.options !== undefined && question.options.length > 0;
        return (
          <div key={`${label}-${index}`} className={`agent-session-question ${settled ? "answered" : ""}`.trim()}>
            {question.header && <small>{question.header}</small>}
            <strong>{question.title}</strong>
            {settled && <small className="agent-session-question-answered">{t("agentSessionQuestionAnswered")}</small>}
            {question.detail && <p className="agent-session-question-detail">{question.detail}</p>}
            {question.kind === "boolean" ? (
              <div className="agent-session-options">
                {[t("agentSessionAnswerYes"), t("agentSessionAnswerNo")].map((option) => {
                  const selected = settled
                    ? answeredOptionSelected(question, option)
                    : chosen === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      className={selected ? "selected" : ""}
                      onClick={() => { write(question, option); onPick?.(); }}
                    >{option}</button>
                  );
                })}
              </div>
            ) : (
              <>
                {question.options && (
                  <div className="agent-session-options">
                    {question.options.map((option) => {
                      const selected = settled
                        ? answeredOptionSelected(question, option)
                        : question.multiSelect
                          ? questionAnswerValues(reply, question).includes(option)
                          : chosen === option;
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={disabled}
                          className={selected ? "selected" : ""}
                          onClick={() => {
                            onChange(question.multiSelect
                              ? toggleQuestionOption(reply, question, option, count)
                              : questionAnswerText(reply, question, option, count));
                            onPick?.();
                          }}
                        >{option}</button>
                      );
                    })}
                  </div>
                )}
                {(typed || custom) && (
                  <input
                    className="agent-session-question-input"
                    type={question.kind === "number" ? "number" : "text"}
                    value={settled ? question.answered : chosen}
                    placeholder={question.placeholder ?? (custom ? t("agentSessionAnswerCustom") : undefined)}
                    disabled={disabled}
                    onChange={(event) => write(question, event.target.value)}
                  />
                )}
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
