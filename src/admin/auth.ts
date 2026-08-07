import type { Request, Response, NextFunction } from "express";

/**
 * HTTP Basic Auth against a single admin user/password pair (env vars,
 * set as Vercel project env vars for the deployed API — separate from the
 * GitHub Actions secrets, which only apply to the CLI/batch workflows).
 * Single-user by design: this is a personal admin surface, not
 * multi-tenant, so a full auth system would be more machinery than the
 * problem needs.
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;

  if (!expectedUser || !expectedPass) {
    res.status(503).json({ error: "ADMIN_USERNAME/ADMIN_PASSWORD not configured on this server" });
    return;
  }

  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="admin"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [user, pass] = Buffer.from(header.slice(6), "base64").toString("utf8").split(":");
  if (user !== expectedUser || pass !== expectedPass) {
    res.set("WWW-Authenticate", 'Basic realm="admin"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}
