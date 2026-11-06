import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const LinkSchema = z.object({
  linkId: z.string(),
  agentId: z.string(),
  /** The full invitation, including the key and secret in the fragment. */
  url: z.string(),
  allowPrompts: z.boolean(),
  /** Whether guests see code changes (diffs). */
  includeCode: z.boolean(),
  guests: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export type Link = z.infer<typeof LinkSchema>;

export const createLinkRpc = defineRpc({
  name: "collab.link.create",
  input: z.object({
    agentId: z.string().min(1),
    allowPrompts: z.boolean(),
    includeCode: z.boolean(),
  }),
  output: LinkSchema,
});

export const listLinksRpc = defineRpc({
  name: "collab.link.list",
  input: z.object({ agentId: z.string().optional() }),
  output: z.object({ links: z.array(LinkSchema) }),
});

export const stopLinkRpc = defineRpc({
  name: "collab.link.stop",
  input: z.object({ linkId: z.string().min(1) }),
  output: z.object({ stopped: z.boolean() }),
});
