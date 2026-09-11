import fsp from 'node:fs/promises';
import { config } from '../config.js';
import { completeJSON, llmAvailable } from '../llm.js';
import {
  categoryTreeText, findCategoryByPath, createCategory,
  addAgentMemory, getAgentMemory, updateNote,
} from '../db.js';

export function categorizerAvailable() {
  return llmAvailable();
}

// Strict-mode JSON schema: every property required, nullable fields spelled as
// anyOf-with-null, no extra keys. That shape is accepted by Anthropic's
// structured outputs and by OpenAI-style strict json_schema alike.
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'A short, specific title for this note (max ~10 words).' },
    summary: { type: 'string', description: 'A 1-3 sentence summary of the note in the author\'s voice.' },
    category_path: {
      type: 'string',
      description: 'The full path of the chosen EXISTING category, e.g. "Personal / Health". If proposing a new category, the path it will have once created.',
    },
    new_category: {
      anyOf: [
        {
          type: 'object',
          properties: {
            name: { type: 'string' },
            parent_path: {
              anyOf: [{ type: 'string' }, { type: 'null' }],
              description: 'Full path of the existing parent category, or null for a new top-level category.',
            },
            description: { type: 'string', description: 'One sentence describing what belongs in this category.' },
          },
          required: ['name', 'parent_path', 'description'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
      description: 'Only set when no existing category fits well. Prefer existing categories.',
    },
    tags: { type: 'array', items: { type: 'string' }, description: '2-6 lowercase topic tags.' },
    action_items: { type: 'array', items: { type: 'string' }, description: 'Concrete to-dos the author stated or clearly implied. Empty if none.' },
    memory_note: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'Optional: one short lesson about how this author categorizes things, to improve future categorization (e.g. recurring project names, people, themes). Null if nothing new was learned.',
    },
  },
  required: ['title', 'summary', 'category_path', 'new_category', 'tags', 'action_items', 'memory_note'],
  additionalProperties: false,
};

// Filing rules every install gets. Tags like these are what make a pile of
// notes answerable later ("what did I clip about X?", "every 1:1 with Sam").
const BASE_CONVENTIONS = [
  '- Recordings of meetings or calls: add tag "meeting". A one-on-one (author + one other person) also gets "1on1". Tag the lowercase first names of the people discussed.',
  '- If the note is about something the author read, watched, or heard from an external source (article, newsletter, podcast, video, someone else\'s post), file it under "Ideas / Clipped" (propose that subcategory if it does not exist yet), add tag "clipped" plus a "source:<origin>" tag, and name the source in the summary. These are NOT the author\'s own ideas, and that provenance should stay visible later.',
  '- Anything with a date or time commitment (appointments, deadlines, events): add tag "schedule" and put the date in the action item.',
];

// The owner's own rules, from DATA_DIR/conventions.md. Read on every note, so
// an edit takes effect on the next one with no restart. A missing file is the
// normal case, not an error.
async function ownConventions() {
  try {
    const text = await fsp.readFile(config.conventionsFile, 'utf8');
    return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
      .map((l) => (l.startsWith('-') ? l : `- ${l}`));
  } catch {
    return [];
  }
}

/**
 * Runs the categorizer on a note's transcript and saves the result: title,
 * summary, category (creating a new one if proposed), tags, action items. The
 * taxonomy and the agent's memory come from the database, so each note is
 * filed with everything the previous ones taught it.
 */
export async function categorizeNote(note) {
  const memory = getAgentMemory('categorizer', 30);
  const memoryText = memory.length
    ? memory.map((m) => `- ${m.content}`).join('\n')
    : '(no memory yet: this is early in the system\'s life)';
  const own = await ownConventions();

  const system = [
    'You are the categorizer agent inside a personal "second brain" system.',
    'The author records voice notes (transcribed to text) and you organize them so knowledge compounds over time.',
    '',
    'Current category taxonomy (name: description):',
    categoryTreeText(),
    '',
    'Things you have learned about this author from past notes:',
    memoryText,
    '',
    'Rules:',
    '- Prefer an existing category. Propose a new one only when nothing fits well, and keep the taxonomy small and meaningful.',
    '- New subcategories are better than new top-level categories.',
    '- Transcripts are spoken language: expect filler words, transcription errors, and rambling. Infer the real intent.',
    '- The summary should preserve the author\'s key points, not generic filler.',
    '',
    ...BASE_CONVENTIONS,
    ...(own.length ? ['', 'The author\'s own filing rules (these win over the ones above):', ...own] : []),
  ].join('\n');

  const result = await completeJSON({
    purpose: 'categorize',
    noteId: note.id,
    model: config.llm.categorizerModel,
    effort: 'medium',
    system,
    user: `Categorize this note (recorded ${note.created_at}, source: ${note.source}):\n\n<transcript>\n${note.transcript}\n</transcript>`,
    schema: OUTPUT_SCHEMA,
  });

  // Resolve the category, creating it if the agent proposed a new one.
  let category = null;
  if (result.new_category) {
    category = createCategory({
      name: result.new_category.name,
      parentPath: result.new_category.parent_path,
      description: result.new_category.description,
      createdBy: 'agent',
    });
  }
  if (!category && result.category_path) category = findCategoryByPath(result.category_path);
  if (!category) category = findCategoryByPath('Ideas');

  if (result.memory_note) addAgentMemory('categorizer', result.memory_note);

  return updateNote(note.id, {
    title: result.title,
    summary: result.summary,
    category_id: category ? category.id : null,
    tags: result.tags || [],
    action_items: result.action_items || [],
  });
}
