// Seeds a small, fixed set of audit rows for the /dev/audit E2E (#555).
//
// The page reads two tables joined by correlationId, and neither has a write
// path a browser can reach — telemetry writes AuditEvent but nothing writes
// AgentCall except an actual agent call, which an E2E cannot afford to make.
// So the rows are planted here, and the spec runs this first rather than
// mocking the API: the correlationId join and the cost totals are the whole
// point of the page, and a mocked response would prove neither.
//
// Idempotent — it clears this user's rows before writing, so re-running it
// leaves exactly the same data. Scoped to one fake user id, so it can never
// touch a real one.
import { prisma } from "../src/index";

export const AUDIT_EVIDENCE_USER = "11111111-1111-4111-8111-111111111111";
const MATCH_ID = "22222222-2222-4222-8222-222222222222";

// Fixed timestamps so the screenshots are stable run to run.
const at = (hour: number) => new Date(Date.UTC(2026, 8, 9, hour, 0, 0));

const CORRELATION = {
  interview: "3a1f0c8e-0000-4000-8000-000000000001",
  state: "3a1f0c8e-0000-4000-8000-000000000002",
  pitch: "3a1f0c8e-0000-4000-8000-000000000003",
  sweep: "3a1f0c8e-0000-4000-8000-000000000004",
};

export async function seedAuditEvidence(): Promise<void> {
  await prisma.auditEvent.deleteMany({ where: { userId: AUDIT_EVIDENCE_USER } });
  await prisma.agentCall.deleteMany({ where: { userId: AUDIT_EVIDENCE_USER } });

  await prisma.auditEvent.createMany({
    data: [
      {
        type: "INTERVIEW_TURN",
        userId: AUDIT_EVIDENCE_USER,
        correlationId: CORRELATION.interview,
        payload: JSON.stringify({ mode: "interview_self", latencyMs: 1240, answerLength: 62 }),
        createdAt: at(10),
      },
      {
        type: "MATCHING_STATE_CHANGED",
        userId: AUDIT_EVIDENCE_USER,
        correlationId: CORRELATION.state,
        payload: JSON.stringify({ from: "IDLE", to: "WAITING", trigger: "phase2_completed" }),
        createdAt: at(11),
      },
      {
        type: "PITCH_DECIDED",
        userId: AUDIT_EVIDENCE_USER,
        correlationId: CORRELATION.pitch,
        payload: JSON.stringify({ matchId: MATCH_ID, decision: "yeah" }),
        createdAt: at(12),
      },
    ],
  });

  await prisma.agentCall.createMany({
    data: [
      {
        correlationId: CORRELATION.interview,
        userId: AUDIT_EVIDENCE_USER,
        actor: "interview_helper",
        purpose: "interview_soft_turn",
        model: "claude-haiku-4-5",
        costUsd: 0.0012,
        durationMs: 1180,
        toolNames: "[]",
        retryCount: 0,
        outcome: "ok",
        createdAt: at(10),
      },
      {
        correlationId: CORRELATION.pitch,
        userId: AUDIT_EVIDENCE_USER,
        actor: "barney",
        purpose: "pitch_turn",
        model: "claude-sonnet-5",
        costUsd: 0.0431,
        durationMs: 4820,
        toolNames: '["saveDecision"]',
        retryCount: 1,
        outcome: "ok",
        createdAt: at(12),
      },
      // No event shares this correlationId: a sweep's call, caused by the clock
      // rather than by anything the user did. The page shows these separately.
      {
        correlationId: CORRELATION.sweep,
        userId: AUDIT_EVIDENCE_USER,
        actor: "negotiation",
        purpose: "negotiation_turn",
        model: "claude-sonnet-5",
        costUsd: 0.1902,
        durationMs: 9110,
        toolNames: "[]",
        retryCount: 0,
        outcome: "failed",
        errorMessage: "Error: rate_limit",
        createdAt: at(13),
      },
    ],
  });
}

seedAuditEvidence()
  .then(() => console.log(`Seeded audit evidence rows for ${AUDIT_EVIDENCE_USER}`))
  .catch((error: unknown) => {
    console.error("seedAuditEvidence failed:", error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
