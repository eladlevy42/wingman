import { Router } from "express";
import { ZodError } from "zod";
import {
  registerUser,
  loginUser,
  NotFoundError,
  InvalidCredentialsError,
} from "../services/user.service";

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  try {
    const user = await registerUser(req.body);
    res.status(201).json(user);
  } catch (err) {
    if (err instanceof ZodError) {
      res.status(400).json({ error: err.errors });
      return;
    }
    if ((err as NodeJS.ErrnoException).code === "P2002") {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const user = await loginUser(req.body);
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
    if (err instanceof InvalidCredentialsError) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }
    res.status(500).json({ error: "Internal server error" });
  }
});
