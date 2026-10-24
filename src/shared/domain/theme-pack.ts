import { z } from 'zod';
import { EntityIdSchema, ModIdSchema, SchemaVersionSchema } from './common';
import { parseDocument, parseJsonDocument } from '../validation/json';

const semverLikeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/, 'Expected a version such as 1.7.3.');

export const ThemePackModSchema = z
  .strictObject({
    modId: ModIdSchema,
    name: z.string().min(1).max(200),
    pageUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => value.startsWith('https://'), 'Theme pack links must use HTTPS.'),
    testedVersion: semverLikeSchema,
    required: z.boolean().default(true),
    notes: z.array(z.string().min(1).max(1000)).max(50).default([]),
  })
  .superRefine((mod, context) => {
    let url: URL;
    try {
      url = new URL(mod.pageUrl);
    } catch {
      return;
    }

    if (url.hostname !== 'windhawk.net' || url.pathname !== `/mods/${mod.modId}`) {
      context.addIssue({
        code: 'custom',
        path: ['pageUrl'],
        message: `Expected https://windhawk.net/mods/${mod.modId}.`,
      });
    }
  });

export const ThemePackSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    id: EntityIdSchema,
    name: z.string().min(1).max(200),
    description: z.string().max(2000).default(''),
    version: semverLikeSchema,
    testedAppVersion: semverLikeSchema,
    mods: z.array(ThemePackModSchema).min(1).max(1000),
    profiles: z.array(EntityIdSchema).min(1).max(100),
    notes: z.array(z.string().min(1).max(2000)).max(100).default([]),
  })
  .superRefine((pack, context) => {
    const modIds = new Set<string>();
    for (const [index, mod] of pack.mods.entries()) {
      if (modIds.has(mod.modId)) {
        context.addIssue({
          code: 'custom',
          path: ['mods', index, 'modId'],
          message: `Duplicate theme pack mod "${mod.modId}".`,
        });
      }
      modIds.add(mod.modId);
    }
  });

export type ThemePack = z.infer<typeof ThemePackSchema>;
export type ThemePackMod = z.infer<typeof ThemePackModSchema>;

export function parseThemePack(input: unknown): ThemePack {
  return parseDocument(ThemePackSchema, input, 'Theme pack', 'themePack');
}

export function parseThemePackJson(text: string): ThemePack {
  return parseJsonDocument(ThemePackSchema, text, 'Theme pack', 'themePack');
}
