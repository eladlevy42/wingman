import { Router } from "express";
import { ZodError } from "zod";
import {
  NotificationsSinceQuerySchema,
  RegisterPushTokenRequestSchema,
  UnregisterPushTokenRequestSchema,
  UserIdParamSchema,
} from "@wingman/shared";
import {
  getUserById,
  getUserState,
  getMatchPhoto,
  savePhoto,
  authenticateStudent,
  NotFoundError,
  InvalidCredentialsError,
} from "../services/user.service";
import { startMatchCycle } from "../services/orchestration.service";
import { getBlindDate, BlindDateNotFoundError } from "../services/blindDate.service";
import { deleteUser } from "../services/userDeletion.service";
import { notificationService } from "../services/notification.service";
import { pushTokenService } from "../services/pushToken.service";

export const usersRouter = Router();

// Notification poll (#357) — the real delivery channel: the web app fetches
// rows created after `since` (ISO datetime) and feeds them into its banner
// store. An invalid `since` is a 400 rather than silently returning the whole
// history.
usersRouter.get("/:id/notifications", async (req, res) => {
  try {
    const sinceParam = NotificationsSinceQuerySchema.parse(req.query.since);
    const since = sinceParam ? new Date(sinceParam) : undefined;
    const list = await notificationService.listNotifications(req.params.id, since);
    res.json(list);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid 'since' timestamp" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Push device registration (#477). Called by the mobile app once permission is
// granted, on every launch and after every login — the upsert makes repeats
// free. A malformed token is a 400 rather than a stored row that would fail
// silently at send time.
usersRouter.post("/:id/push-tokens", async (req, res) => {
  try {
    const { token, platform } = RegisterPushTokenRequestSchema.parse(req.body);
    const record = await pushTokenService.register(req.params.id, token, platform);
    res.status(201).json(record);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid push token registration" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Sign-out. Deletes by token alone, not by (user, token): the caller proves
// possession of the token, and a device signing out must stop receiving push
// regardless of which account the row currently points at — the upsert in
// register() may have re-pointed it since.
usersRouter.delete("/:id/push-tokens", async (req, res) => {
  try {
    const { token } = UnregisterPushTokenRequestSchema.parse(req.body);
    await pushTokenService.unregister(token);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid push token" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Manual find-match trigger (#185, async since #361): kicks the cycle off in
// the background and answers immediately — the old synchronous shape held the
// request open for minutes of real negotiations and timed out. The client
// follows progress via GET /:id/state and /api/match/orchestration-status.
// The existence check keeps a stale/bogus id an explicit 404 — the background
// cycle would otherwise no-op silently and the client would report an
// honest-looking "no match" for a user that doesn't exist.
usersRouter.post("/:id/trigger-match", async (req, res) => {
  try {
    await getUserById(req.params.id);
    res.status(202).json(startMatchCycle(req.params.id));
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

usersRouter.get("/:id/state", async (req, res) => {
  try {
    const state = await getUserState(req.params.id);
    res.json(state);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// The matched partner's photo, revealed on the Pitch page right before Yeah/Nah.
usersRouter.get("/:id/match-photo", async (req, res) => {
  try {
    const photo = await getMatchPhoto(req.params.id);
    res.json(photo);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

usersRouter.get("/:id/blind-date", async (req, res) => {
  try {
    const blindDate = await getBlindDate(req.params.id);
    res.json(blindDate);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (err instanceof BlindDateNotFoundError) {
      res.status(404).json({ error: "No assigned Blind Date found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// The Match Photo requested by Barney right after Phase 2 (#200, docs/adr/0016).
usersRouter.post("/:id/photo", async (req, res) => {
  try {
    await savePhoto(req.params.id, req.body);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// The "Verify Your University" step (#275): university email + student id +
// password, submitted right after sign-up. Thin handler — the service validates
// the input (Zod) and hashes the password.
usersRouter.post("/:id/authenticate", async (req, res) => {
  try {
    const user = await authenticateStudent(req.params.id, req.body);
    res.json(user);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

// Account erasure (#561, docs/adr/0040). Erases the user's own data and
// repoints the departing side of anything they share with someone else at the
// tombstone user, so deleting one account never erases the other participant's
// record of their own date. Gated on the account password: the deletion is
// irreversible and a user id is not a secret, so the path parameter alone must
// never be enough to erase somebody.
usersRouter.delete("/:id", async (req, res) => {
  try {
    await deleteUser(UserIdParamSchema.parse(req.params.id), req.body);
    res.status(204).end();
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: "Invalid account deletion request" });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (err instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "Incorrect password" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

usersRouter.get("/:id", async (req, res) => {
  try {
    const user = await getUserById(req.params.id);
    res.json(user);
  } catch (err) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});
