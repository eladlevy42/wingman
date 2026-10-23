import type { NextFunction, Request, Response } from "express";

export function jsonBodyErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  const isBodyParserSyntaxError =
    err instanceof SyntaxError &&
    (("type" in err && err.type === "entity.parse.failed") || ("body" in err && "status" in err));

  if (isBodyParserSyntaxError) {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  next(err);
}
