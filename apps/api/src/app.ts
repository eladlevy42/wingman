import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.routes";
import { usersRouter } from "./routes/users";
import { barneyRouter } from "./routes/barney.routes";
import { evalRouter } from "./routes/eval.routes";
import { matchRouter } from "./routes/match.routes";
import { matchAttemptRouter } from "./routes/matchAttempt.routes";
import { telemetryRouter } from "./routes/telemetry.routes";
import { auditRouter } from "./routes/audit.routes";
import { jsonBodyErrorHandler } from "./middleware/errorHandler";
import { correlationId } from "./middleware/correlationId";

export const app = express();

// The web client's Vite dev server, plus Expo's web target (the mobile app run
// in a browser, used by the apps/mobile Playwright full run, #564). Native
// builds send no Origin header, so CORS never applies to them.
app.use(cors({ origin: ["http://localhost:5173", "http://localhost:8081"] }));
// One correlation id per request, ahead of anything that can record an audit
// event — it links a user action to every agent call it causes (docs/adr/0038).
app.use(correlationId);
// Default express.json() limit (100kb) is too small for the base64 Match
// Photo upload (#200) — PhotoUploadInputSchema caps the encoded photo at ~7MB.
app.use(express.json({ limit: "8mb" }));
app.use(jsonBodyErrorHandler);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);
app.use("/api/barney", barneyRouter);
app.use("/api/eval", evalRouter);
app.use("/api/match", matchRouter);
app.use("/api/match-attempts", matchAttemptRouter);
app.use("/api/telemetry", telemetryRouter);
app.use("/api/audit", auditRouter);
