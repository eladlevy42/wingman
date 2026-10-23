import {
  isClientAuditEventType,
  parseAuditPayload,
  type TelemetryBatch,
  type TelemetryResponse,
} from "@wingman/shared";
import { recordEvent, type AuditSubject } from "./audit.service";

/**
 * Writes one AuditEvent per valid entry in a client telemetry batch (#554).
 *
 * The batch shape is already validated by the route; what happens here is
 * per-entry validation, and the rule is deliberately different at the two
 * levels. A malformed BATCH is the client's fault and gets a 400. A malformed
 * ENTRY is dropped on its own, because a client shipping one bad event should
 * not cost the other 49 in the same flush — a version skew between an old app
 * build and a newer server is the ordinary case, not an attack.
 *
 * Two gates apply to every entry:
 *
 * 1. The type must be one a client is allowed to send. SCREEN_VIEWED and
 *    CTA_TAPPED are; USER_REGISTERED and MATCHING_STATE_CHANGED are not, and a
 *    client claiming one is forging a state transition the server never made.
 * 2. The payload must parse against that type's schema — the same gate every
 *    server-side event goes through (docs/adr/0038).
 */
export async function recordTelemetryBatch(batch: TelemetryBatch): Promise<TelemetryResponse> {
  // The route guarantees exactly one of the two is set (TelemetryBatchSchema
  // refuses the pair, which would be the anon-to-user stitch ADR-0038 rejects).
  const subject: AuditSubject =
    batch.userId != null
      ? { userId: batch.userId }
      : { anonSessionId: batch.anonSessionId as string };

  let accepted = 0;
  let dropped = 0;

  for (const event of batch.events) {
    if (!isClientAuditEventType(event.type)) {
      console.warn(`telemetry: dropped event — "${event.type}" is not client-emittable`);
      dropped += 1;
      continue;
    }
    const parsed = parseAuditPayload(event.type, event.payload);
    if (!parsed.success) {
      console.warn(`telemetry: dropped ${event.type} — payload failed its schema`);
      dropped += 1;
      continue;
    }
    // recordEvent re-parses and never throws; the check above is what lets us
    // report an accurate accepted/dropped split rather than guessing.
    await recordEvent(event.type, parsed.data as never, subject);
    accepted += 1;
  }

  return { accepted, dropped };
}
