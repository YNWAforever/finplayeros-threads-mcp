import { z } from 'zod';

export const postStateSchema = z.enum(['draft', 'approved', 'scheduled', 'published', 'failed']);
export type PostState = z.infer<typeof postStateSchema>;

const textSchema = z.string().min(1, 'Draft text must not be empty.');
const linkSchema = z.url({ protocol: /^https?$/ });
const imageRefSchema = z.string().min(1).describe('Local PNG or JPEG path to upload to Vercel Blob at publish time.');

export const createDraftSchema = z.strictObject({
  text: textSchema,
  link: linkSchema.optional(),
  image_ref: imageRefSchema.optional(),
  source_note: z.string().optional(),
});

export const updateDraftSchema = z.strictObject({
  text: textSchema.optional(),
  link: linkSchema.nullable().optional(),
  image_ref: imageRefSchema.nullable().optional(),
  source_note: z.string().nullable().optional(),
}).refine((input) => input.text !== undefined || input.link !== undefined
  || input.image_ref !== undefined || input.source_note !== undefined, {
  message: 'Provide at least one field to update.',
});

export type CreateDraftInput = z.infer<typeof createDraftSchema>;
export type UpdateDraftInput = z.infer<typeof updateDraftSchema>;

const timestampSchema = z.iso.datetime();
const transitionSchema = z.strictObject({
  from: postStateSchema.nullable(),
  to: postStateSchema,
  at: timestampSchema,
  reason: z.string(),
});
export const queuePostSchema = z.strictObject({
  id: z.string().min(1),
  text: textSchema,
  link: linkSchema.optional(),
  image_ref: imageRefSchema.optional(),
  source_note: z.string().optional(),
  state: postStateSchema,
  created_at: timestampSchema,
  updated_at: timestampSchema,
  approved_at: timestampSchema.optional(),
  approved_by: z.string().optional(),
  publish_at: timestampSchema.optional(),
  published_at: timestampSchema.optional(),
  threads_media_id: z.string().trim().min(1).optional(),
  last_error: z.string().optional(),
  image_cleanup_error: z.string().optional(),
  history: z.array(transitionSchema).default([]),
}).superRefine((post, ctx) => {
  if (post.state === 'draft' && (post.approved_at || post.approved_by !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Draft posts cannot retain approval metadata.' });
  }
  if (post.state !== 'draft' && !post.approved_at) {
    ctx.addIssue({ code: 'custom', message: 'Non-draft posts require approved_at.' });
  }
  if (post.state === 'scheduled' && !post.publish_at) {
    ctx.addIssue({ code: 'custom', message: 'Scheduled posts require publish_at.' });
  }
  if (post.state === 'published' && (!post.threads_media_id || !post.published_at)) {
    ctx.addIssue({ code: 'custom', message: 'Published posts require media ID proof and published_at.' });
  }
});

export type QueuePost = z.infer<typeof queuePostSchema>;

/** No timers or writes: an external executor can inspect which posts are due. */
export function dueScheduled(posts: readonly QueuePost[], now: Date): QueuePost[] {
  return posts
    .filter((post) => post.state === 'scheduled' && post.publish_at !== undefined
      && Date.parse(post.publish_at) <= now.getTime())
    .map((post) => structuredClone(post));
}
