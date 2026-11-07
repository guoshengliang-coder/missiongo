/** Execution records are operational data, never conversation text. Do not inspect text:
 * people and agents may legitimately send JSON, commands and logs as messages. */
export function isConversationMessage(message: { readonly phase?: string | null | undefined }): boolean {
  return message.phase !== "execution";
}
