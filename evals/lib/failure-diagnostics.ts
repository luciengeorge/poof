interface Event {
  type: string;
  data: unknown;
}

/** Export only fixed lifecycle labels and counts, never event payloads or identifiers. */
export function failureDiagnostics(events: readonly Event[]) {
  const counts = { callsRequested: 0, callsSettled: 0, modelsRequested: 0,
    modelsStarted: 0, modelsRetried: 0, modelsSettled: 0, childrenOpened: 0 };
  const calls = new Map<string, string>();
  const models = new Set<string>();
  for (const event of events) {
    const data = event.data as { callId?: string; runId?: string; capability?: { kind: string } };
    switch (event.type) {
      case "call.requested":
        counts.callsRequested++;
        if (data.callId) calls.set(data.callId, data.capability?.kind ?? "unknown");
        break;
      case "call.settled":
        counts.callsSettled++;
        if (data.callId) calls.delete(data.callId);
        break;
      case "model.requested":
        counts.modelsRequested++;
        if (data.runId) models.add(data.runId);
        break;
      case "model.started": counts.modelsStarted++; break;
      case "model.retried": counts.modelsRetried++; break;
      case "model.settled":
        counts.modelsSettled++;
        if (data.runId) models.delete(data.runId);
        break;
      case "child.opened": counts.childrenOpened++; break;
    }
  }
  return { ...counts, pendingTools: [...calls.values()].filter(k => k === "tool").length,
    pendingAgents: [...calls.values()].filter(k => k === "agent").length,
    pendingOtherCalls: [...calls.values()].filter(k => k !== "tool" && k !== "agent").length,
    pendingModels: models.size };
}

/** Eve's completed-session snapshots omit a turn that aborts mid-stream. Read the public
 * live-turn buffer instead. This wrapper neither changes cancellation nor consumes a second
 * stream, and rethrows the original failure so no assertion/timeout can become a pass. */
export async function diagnoseTurn<T>(live: { readonly events: readonly Event[]; result(): Promise<T> }): Promise<T> {
  try {
    return await live.result();
  } catch (error) {
    console.error("[eval-failure-lifecycle] in-flight turn", JSON.stringify(failureDiagnostics(live.events)));
    throw error;
  }
}
