import { ConvexError } from "convex/values";

export const RECONCILIATION_CONFIG_ERROR = "Reconciliation requires the enabled execution mode and verified account configuration";
export interface ReconciliationDiagnostic { status: string; message: string; exitCode: 0 | 1 | 2 }
/** Only fixed diagnostic text leaves this boundary: no backend payload, stack, token or account. */
export function reconciliationDiagnostic(error: unknown): ReconciliationDiagnostic {
  if (error instanceof ConvexError && error.data && typeof error.data === "object" && "code" in error.data) {
    if (error.data.code === "NO_FENCED_ORDER") return { status: "not-needed", message: "No fenced order to reconcile.", exitCode: 0 };
    if (error.data.code === "MANUAL_AUDIT_REQUIRED") return { status: "manual-audit-required",
      message: "Manual audit required; any existing order fence is retained. Do not resend automatically.", exitCode: 2 };
  }
  if (error instanceof Error) {
    if (error.message === RECONCILIATION_CONFIG_ERROR) return { status: "not-configured",
      message: "Reconciliation is disabled or account configuration is incomplete. Keep the mode OFF until activation requirements are complete.", exitCode: 2 };
    if (["Reconciliation broker read unavailable", "Reconciliation broker read refused"].includes(error.message))
      return { status: "broker-read-failed", message: "Broker read failed; any existing order fence is retained.", exitCode: 1 };
    if (["Invalid reconciliation broker response", "Invalid reconciliation pending response", "Invalid reconciliation history response"].includes(error.message))
      return { status: "invalid-broker-response", message: "Invalid broker response; any existing order fence is retained.", exitCode: 1 };
  }
  return { status: "failed", message: "Reconciliation incomplete; any existing order fence is retained. Inspect authenticated evidence and broker records before recovery.", exitCode: 1 };
}
