import {
  answeredOptionSelected,
  questionAnswerText,
  questionAnswerValue,
  questionAnswerValues,
  toggleQuestionOption,
  visibleQuestions,
} from "./agent-session-view";
import { permissionPresentation } from "./permission-presentation";
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
 * fresh ask (AND-227). A `withdrawn` one is not drawn at all — the ask went
 * away without an answer, so there is nothing for a person to settle and no
 * card to show (AND-239).
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
  const shown = visibleQuestions(questions);
  const count = shown.length;
  const write = (question: AgentSessionQuestion, value: string) =>
    onChange(questionAnswerText(reply, question, value, count));

  return (
    <>
      {shown.map((question, index) => {
        const permission = permissionPresentation(question);
        const label = question.key ?? question.header ?? question.title;
        const settled = question.answered !== undefined;
        const disabled = !canReply || settled;
        const chosen = questionAnswerValue(reply, question, count);
        const options = question.kind === "boolean"
          ? [t("agentSessionAnswerYes"), t("agentSessionAnswerNo")]
          : question.options;
        const chosenValues = question.multiSelect ? questionAnswerValues(reply, question, count) : [chosen];
        const isSelected = (option: string) => settled
          ? answeredOptionSelected(question, option)
          : chosenValues.includes(option);
        const draftSelected = !settled && options?.some(isSelected);
        const typed = question.kind === "text" || question.kind === "number";
        const custom = question.custom === true && question.options !== undefined && question.options.length > 0;
        return (
          <div key={`${label}-${index}`} className={["agent-session-question", permission && "agent-session-permission", settled && "answered"].filter(Boolean).join(" ")}>
            {question.header && <small>{question.header}</small>}
            <strong>{permission ? question.title.replace(/请求使用 (Edit|Write|MultiEdit|NotebookEdit)$/, "请求修改文件") : question.title}</strong>
            {question.answered !== undefined && <small className="agent-session-question-answered">{t("agentSessionQuestionAnswered")}</small>}
            {permission && question.detail?.split("\n").filter(line => !(question.options ?? []).some(option =>
              permission.has(option) && line.startsWith(option + "："))).map((line, lineIndex) =>
                <p key={lineIndex} className="agent-session-question-detail">{line}</p>)}
            {question.detail && (permission ? <details className="agent-session-question-detail">
              <summary>技术详情</summary><p>{question.detail}</p>
            </details> : <p className="agent-session-question-detail">{question.detail}</p>)}
            {question.kind === "boolean" ? (
              <div className="agent-session-options">
                {options?.map((option) => {
                  const selected = isSelected(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      disabled={disabled}
                      className={selected ? "selected" : ""}
                      aria-pressed={selected}
                      onClick={() => write(question, option)}
                    >{option}</button>
                  );
                })}
              </div>
            ) : (
              <>
                {question.options && (
                  <div className="agent-session-options">
                    {question.options.map((option) => {
                      const selected = isSelected(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          disabled={disabled}
                          className={selected ? "selected" : ""}
                          aria-pressed={selected}
                          onClick={() => {
                            onChange(question.multiSelect
                              ? toggleQuestionOption(reply, question, option, count)
                              : questionAnswerText(reply, question, option, count));
                          }}
                        >{permission ? <span>{permission.get(option)?.label ?? option}</span> : option}
                          {permission?.get(option)?.detail && <small>{permission.get(option)!.detail}</small>}
                        </button>
                      );
                    })}
                  </div>
                )}
                {(typed || custom) && (
                  <input
                    className="agent-session-question-input"
                    type={question.kind === "number" ? "number" : "text"}
                    value={settled ? (question.answered ?? "") : chosen}
                    placeholder={question.placeholder ?? (custom ? t("agentSessionAnswerCustom") : undefined)}
                    disabled={disabled}
                    onChange={(event) => write(question, event.target.value)}
                  />
                )}
              </>
            )}
            {/* Keep selection feedback after the controls so it cannot push a tapped option below the composer. */}
            {draftSelected && <small className="agent-session-question-draft" role="status">{t("agentSessionQuestionDraftSelected")}</small>}
          </div>
        );
      })}
    </>
  );
}
