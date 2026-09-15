import { Hono } from "hono";

/**
 * SCIM 2.0 provisioning is not part of this build. The api-server still
 * mounts the app at `/scim/v2`, so it answers every request with a 404 —
 * the same "no such surface" a deployment without SCIM tokens presented.
 */
export const createScimApp = (): Hono => {
  const app = new Hono();
  app.all("*", (c) =>
    c.json(
      {
        error: {
          message: "Not available on this deployment",
          type: "invalid_request_error",
        },
      },
      404,
    ),
  );
  return app;
};
