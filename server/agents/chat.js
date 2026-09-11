import { config } from '../config.js';
import { runTools, llmAvailable } from '../llm.js';
import { searchNotes, listNotes, getNote, categoryTreeText, findCategoryByPath, stats } from '../db.js';

export function chatAvailable() {
  return llmAvailable();
}

function noteBrief(n) {
  return {
    id: n.id,
    created_at: n.created_at,
    title: n.title,
    summary: n.summary,
    category: n.category_path,
    tags: n.tags,
  };
}

// Provider-neutral tool definitions: llm.js turns these into Anthropic tools or
// OpenAI-style functions.
const TOOLS = [
  {
    name: 'search_notes',
    description:
      'Full-text search across all of the author\'s notes (transcripts, titles, summaries). ' +
      'Use this whenever the user asks about anything they may have said or recorded. ' +
      'Returns brief matches; use get_note to read a full transcript.',
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms (keywords work best; not full sentences).' },
        limit: { type: 'integer', description: 'Max results, default 8.' },
      },
      required: ['query'],
    },
    run: async ({ query, limit }) => {
      const results = searchNotes(String(query || ''), { limit: Math.min(limit || 8, 25) });
      return JSON.stringify(results.map(noteBrief));
    },
  },
  {
    name: 'get_note',
    description: 'Fetch one note in full, including its complete transcript.',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The note id.' } },
      required: ['id'],
    },
    run: async ({ id }) => {
      const n = getNote(id);
      if (!n) return 'Note not found.';
      return JSON.stringify({ ...noteBrief(n), action_items: n.action_items, transcript: n.transcript });
    },
  },
  {
    name: 'list_recent_notes',
    description: 'List the most recent notes, optionally filtered to one category path (e.g. "Personal / Health").',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max notes, default 15.' },
        category_path: { type: 'string', description: 'Optional full category path to filter by.' },
      },
      required: [],
    },
    run: async ({ limit, category_path }) => {
      let categoryId = null;
      if (category_path) {
        const cat = findCategoryByPath(category_path);
        if (!cat) return `No category named "${category_path}". Categories:\n${categoryTreeText()}`;
        categoryId = cat.id;
      }
      const notes = listNotes({ category: categoryId, limit: Math.min(limit || 15, 50) });
      return JSON.stringify(notes.map(noteBrief));
    },
  },
];

/**
 * Chat over the second brain. `history` is an array of {role, content} turns
 * from the client (strings); returns the assistant's reply text.
 */
export async function chat(history) {
  const s = stats();

  const system = [
    'You are the conversational interface to the author\'s "second brain": a personal repository of their voice notes, transcribed and categorized.',
    `It currently holds ${s.total_notes} notes across these categories:`,
    categoryTreeText(),
    '',
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    '',
    'Ground your answers in the author\'s actual notes: search before answering questions about what they said, thought, or planned.',
    'Quote or reference specific notes (with their dates) when relevant. If the notes don\'t cover something, say so plainly.',
    'You are talking to the author themself. Be direct, useful, and conversational.',
  ].join('\n');

  const messages = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  return runTools({
    purpose: 'chat',
    model: config.llm.chatModel,
    system,
    messages,
    tools: TOOLS,
    maxIterations: 12,
  });
}
