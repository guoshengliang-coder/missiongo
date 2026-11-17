/** Never forward native stderr: PowerShell may include credentials and paths.
 * Only fixed diagnostic labels are allowed in a user-visible failure. */
export function windowsFailure(stderr: string, code?: string, status?: number | null): string {
  const known = ["ParserError", "MethodException", "ParameterBindingException", "UnauthorizedAccessException", "CommandNotFoundException", "ArgumentException", "InvalidOperationException"] as const;
  const category = known.find(value => stderr.includes(value)) ?? "unclassified";
  const launch = ["ENOENT", "EACCES", "EPERM", "ETIMEDOUT", "ENOBUFS"].includes(code ?? "") ? code : undefined;
  return launch ?? `${Number.isSafeInteger(status) ? `exit ${status}` : "no exit status"}; ${category}`;
}
