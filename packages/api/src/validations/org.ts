import { z } from "zod";

export const renameOrganizationSchema = z.object({
  name: z.string().trim().min(1).max(255),
});
