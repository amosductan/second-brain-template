#!/usr/bin/env node
/**
 * Fill the app with a few weeks of a fictional person's notes, so you can see
 * what it looks like before recording anything. No model calls, no cost: the
 * notes arrive already filed.
 *
 *   npm run demo              # add the demo notes
 *   npm run demo -- --clear   # remove them (only them; your own notes stay)
 *
 * Every demo note carries the tag "demo", which is what --clear removes.
 */
import db, { newId, findCategoryByPath, createCategory, syncTaskItems } from '../server/db.js';

const DAY = 86400000;

const NOTES = [
  {
    days: 20, category: 'Work', source: 'upload',
    title: 'Weekly sync with Priya on the fall launch',
    summary: 'Launch date holds at October 14. Priya needs the pricing page copy by Friday, and we agreed to cut the referral feature from v1.',
    tags: ['meeting', 'priya', 'launch'],
    actions: ['Send Priya the pricing page copy by Friday', 'Tell design the referral feature is out of v1'],
    transcript: 'Okay so quick recap of the sync with Priya. The launch date is holding at October fourteenth, which is good. She needs the pricing page copy from me by Friday. And we went back and forth on referrals and honestly we agreed to cut it from version one, it is too much for the timeline.',
  },
  {
    days: 18, category: 'Ideas / Clipped', source: 'live', newCategory: { name: 'Clipped', parent: 'Ideas', description: 'Things read, watched or heard from someone else.' },
    title: 'Podcast: spaced repetition beats rereading',
    summary: 'From a learning-science podcast: testing yourself at growing intervals beats rereading by a wide margin. Worth trying for the Spanish practice.',
    tags: ['clipped', 'source:podcast', 'learning'],
    actions: [],
    transcript: 'Heard this on a podcast about learning science on the drive in. The point was that rereading feels productive but barely works, and testing yourself at growing intervals works way better. I should try that with the Spanish flashcards instead of just rereading the list.',
  },
  {
    days: 16, category: 'Personal / Health', source: 'live',
    title: 'Knee feels better with morning runs',
    summary: 'Switching runs to the morning, before the knee stiffens up, has made a real difference over two weeks. Keep the stretching routine.',
    tags: ['running', 'knee'],
    actions: ['Book the physio follow-up for early next month'],
    transcript: 'Two weeks of running in the morning instead of after work and the knee is honestly way better. I think it is because it has not stiffened up yet. Keep the stretching. And I should book that physio follow-up for early next month.',
  },
  {
    days: 14, category: 'Work', source: 'upload',
    title: '1:1 with Jordan: wants to own the analytics work',
    summary: 'Jordan asked to own the analytics rebuild. Good fit: they already know the data model. Pair them with Priya for the first month.',
    tags: ['meeting', '1on1', 'jordan', 'priya'],
    actions: ['Draft a scope doc for Jordan on the analytics rebuild', 'Set up a weekly check-in between Jordan and Priya'],
    transcript: 'One on one with Jordan today. They asked if they could own the analytics rebuild, which I think is a great fit, they know the data model better than anyone. I want to pair them with Priya for the first month so it does not become a solo island. I owe them a scope doc.',
  },
  {
    days: 12, category: 'Personal / Home', source: 'text',
    title: 'Gutters and the fence before winter',
    summary: 'Two home jobs to get done before the first freeze: clean the gutters and fix the leaning fence panel.',
    tags: ['home', 'schedule'],
    actions: ['Call a roofer about the gutters before November 1', 'Buy two fence brackets'],
    transcript: 'Before winter I need to get the gutters cleaned, probably call a roofer, before November first. And the fence panel by the garage is leaning, I think two brackets would fix it.',
  },
  {
    days: 10, category: 'Projects', source: 'live',
    title: 'Garden planner app idea',
    summary: 'An app that tells you what to plant this week based on your frost dates and what you already have in the ground. Start as a spreadsheet to test it.',
    tags: ['idea', 'garden', 'app'],
    actions: ['Build the frost-date spreadsheet version first'],
    transcript: 'Idea while I was out in the yard. An app that just tells you what to plant this week, based on your frost dates and what is already in the ground. I bet I can test it as a spreadsheet before building anything.',
  },
  {
    days: 8, category: 'Personal / Family', source: 'live',
    title: "Planning Mom's 70th for October 12",
    summary: 'Surprise dinner for Mom\'s 70th on October 12. Book the restaurant this week and ask everyone for one photo for the slideshow.',
    tags: ['family', 'birthday', 'schedule'],
    actions: ['Book the restaurant for October 12 this week', 'Ask the family for one photo each for the slideshow'],
    transcript: 'Mom turns seventy on October twelfth and we want to do a surprise dinner. I need to book the restaurant this week before it fills up. And ask everyone for one photo each for a slideshow, that would make her cry in a good way.',
  },
  {
    days: 6, category: 'Ideas', source: 'live',
    title: 'What if the team retro was async?',
    summary: 'Retros run long and the quiet people say nothing. Try a shared doc for a week, then a 20-minute call only on the top three items.',
    tags: ['team', 'retro', 'idea'],
    actions: ['Propose an async retro trial at Monday standup'],
    transcript: 'Thinking about our retros. They always run long and the quieter folks never say anything. What if we did it async, everyone writes in a doc for a week, then a twenty minute call just on the top three things. I will pitch it on Monday.',
  },
  {
    days: 4, category: 'Work', source: 'upload',
    title: 'Vendor demo: fast setup, weak exports',
    summary: 'The scheduling vendor set up in minutes, but exports are CSV only and missing the fields finance needs. Ask for their API docs before deciding.',
    tags: ['meeting', 'vendor'],
    actions: ['Ask the vendor for API docs', 'Check with finance which export fields they need'],
    transcript: 'Notes from the vendor demo. Setup was genuinely fast, a few minutes. But exports are CSV only and they do not include the cost center fields finance needs. Before we decide anything I want their API docs, and I should confirm with finance exactly which fields.',
  },
  {
    days: 2, category: 'Personal / Friends', source: 'live',
    title: 'Dinner with Alex and Kim: book recommendations',
    summary: 'Alex recommended a history of the spice trade and Kim a novel set in Lisbon. They are hosting a game night in two weeks.',
    tags: ['friends', 'books'],
    actions: ['Add both books to the reading list'],
    transcript: 'Great dinner with Alex and Kim. Alex said I have to read that history of the spice trade, and Kim recommended a novel set in Lisbon. They are hosting a game night in two weeks, I should bring something.',
  },
];

function clear() {
  const rows = db.prepare("SELECT id FROM notes WHERE tags LIKE '%\"demo\"%'").all();
  const del = db.prepare('DELETE FROM notes WHERE id = ?');
  for (const r of rows) del.run(r.id);
  // A demo category is removed only if nothing else was filed in it since.
  db.prepare(`DELETE FROM categories WHERE created_by = 'demo'
    AND id NOT IN (SELECT category_id FROM notes WHERE category_id IS NOT NULL)
    AND id NOT IN (SELECT parent_id FROM categories WHERE parent_id IS NOT NULL)`).run();
  return rows.length;
}

if (process.argv.includes('--clear')) {
  console.log(`removed ${clear()} demo note(s)`);
  process.exit(0);
}

const removed = clear(); // re-running replaces the demo set instead of doubling it
const ins = db.prepare(`
  INSERT INTO notes (id, created_at, updated_at, source, status, transcript, title, summary, category_id, tags, action_items)
  VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?)
`);
for (const n of NOTES) {
  if (n.newCategory) {
    const exists = findCategoryByPath(`${n.newCategory.parent} / ${n.newCategory.name}`);
    if (!exists) {
      createCategory({ name: n.newCategory.name, parentPath: n.newCategory.parent, description: n.newCategory.description, createdBy: 'demo' });
    }
  }
  const cat = findCategoryByPath(n.category);
  const at = new Date(Date.now() - n.days * DAY - Math.floor(Math.random() * 6) * 3600000).toISOString();
  const id = newId();
  ins.run(id, at, at, n.source, n.transcript, n.title, n.summary, cat ? cat.id : null,
    JSON.stringify([...n.tags, 'demo']), JSON.stringify(n.actions));
  syncTaskItems(id, n.actions);
}
// A couple of items already in motion, so the Tasks tab shows every state.
db.prepare("UPDATE task_items SET state = 'done', note = 'sent Thursday' WHERE text LIKE 'Send Priya%'").run();
db.prepare("UPDATE task_items SET state = 'working' WHERE text LIKE 'Draft a scope doc%'").run();

console.log(`added ${NOTES.length} demo note(s)${removed ? ` (replaced ${removed})` : ''}. Remove them with: npm run demo -- --clear`);
