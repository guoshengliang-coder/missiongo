interface TurnCommand {
  readonly kind: string;
  readonly status: string;
  readonly stopConfirmed?: boolean;
}

/** Foreground work only: a connected conversation or background task is not a turn. */
export function hasStoppableAgentTurn(session: {
  readonly status: string;
  readonly turnState?: { readonly turnActive?: boolean; readonly waitingForInput?: boolean } | undefined;
  readonly command?: TurnCommand | undefined;
  readonly stopCommand?: TurnCommand | undefined;
}): boolean {
  const pending = (command: TurnCommand | undefined) => command !== undefined
    && ["queued", "delivering", "delivery_unknown"].includes(command.status);
  if (pending(session.command) || pending(session.stopCommand)) return true;
  // An unconfirmed stop can be retried while source state remains unknown.
  if (session.status === "unavailable" && session.stopCommand?.status === "failed"
    && !session.stopCommand.stopConfirmed) return true;
  if (["failed", "suspended"].includes(session.status)) return false;
  if (session.turnState?.turnActive || session.turnState?.waitingForInput) return true;
  if (session.turnState?.turnActive === false) return false;
  // Legacy nodes report a running status without foreground instrumentation.
  return session.status === "active" || session.status === "stalled";
}
