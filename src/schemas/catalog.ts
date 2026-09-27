import { z } from 'zod';
import { CodeText, Identifier, MAX_CODE_CHARACTERS, ProblemVersion } from './progress';

const ProblemSchema = z.object({
  version: ProblemVersion,
  id: Identifier,
  title: z.string(),
  deckId: Identifier,
  deck: z.string(),
  language: z.string(),
  extension: z.string(),
  difficulty: z.string(),
  prompt: z.string(),
  starterCode: CodeText.refine(
    (code) => code.length <= MAX_CODE_CHARACTERS,
    'Starter code is too long for the editor.',
  ),
  referenceCode: z.string(),
  explanation: z.string().optional(),
  solutionAlternatives: z
    .array(
      z.object({
        title: z.string(),
        explanation: z.string(),
        code: z.string(),
        complexity: z.string().optional(),
      }),
    )
    .optional(),
  topic: z.string().optional(),
  requirements: z.array(z.string()).optional(),
  preview: z
    .object({
      caption: z.string(),
      html: z.string().optional(),
      css: z.string().optional(),
      setup: z.string().optional(),
      widths: z.array(z.number()).optional(),
      assets: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  examples: z
    .array(
      z.object({
        input: z.string(),
        output: z.string(),
        inputLabel: z.string().optional(),
        outputLabel: z.string().optional(),
      }),
    )
    .optional(),
  entryPoint: z.string().optional(),
});
export const CatalogSchema = z
  .object({
    decks: z.array(z.object({ id: Identifier, name: z.string().min(1) })).max(100),
    problems: z.array(ProblemSchema).max(1000),
  })
  .refine(({ decks, problems }) => {
    const ids = new Set(decks.map(({ id }) => id));
    return (
      ids.size === decks.length &&
      new Set(problems.map(({ id }) => id)).size === problems.length &&
      problems.every(({ deckId }) => ids.has(deckId))
    );
  }, 'Catalog IDs must be unique and belong to an existing deck.');

export type Problem = z.infer<typeof ProblemSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;
