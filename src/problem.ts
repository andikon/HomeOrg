import { z } from "zod";

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
});

export function problemBody(
  status: number,
  slug: string,
  title: string,
  detail: string,
  errors?: Record<string, string[]>,
): z.infer<typeof problemSchema> {
  return {
    type: `/api/v1/problems/${slug}`,
    title,
    status,
    detail,
    ...(errors ? { errors } : {}),
  };
}
