/** Canonical identity is shared by admission, authorization and owner release. */
export function normalizeExecutionAccount(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
