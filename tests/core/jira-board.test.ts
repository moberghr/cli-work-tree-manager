import { describe, expect, it } from 'vitest';
import { columnOrder } from '../../src/core/jira-board.js';
import { adfText } from '../../src/core/jira.js';

describe('columnOrder (the Jira board)', () => {
  it('to do before in progress before review, whatever order the issues came in', () => {
    expect(columnOrder([
      { status: 'Review', category: 'indeterminate' },
      { status: 'New', category: 'new' },
      { status: 'In Progress', category: 'indeterminate' },
    ])).toEqual(['New', 'In Progress', 'Review']);
  });

  it('testing after review; done last; unknown names keep their order', () => {
    expect(columnOrder([
      { status: 'Done', category: 'done' },
      { status: 'QA', category: 'indeterminate' },
      { status: 'Code Review', category: 'indeterminate' },
      { status: 'Blocked', category: 'indeterminate' },
      { status: 'To Do', category: 'new' },
    ])).toEqual(['To Do', 'Code Review', 'QA', 'Blocked', 'Done']);
  });

  it('without categories (an older acli), by name', () => {
    expect(columnOrder([{ status: 'Review' }, { status: 'To Do' }, { status: 'In Progress' }])).toEqual(['To Do', 'In Progress', 'Review']);
  });
});

describe('adfText (Jira descriptions)', () => {
  it('paragraphs, headings and list items on their own lines; cut to a length', () => {
    const doc = { type: 'doc', content: [
      { type: 'heading', content: [{ type: 'text', text: 'What is it?' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Stored cards ' }, { type: 'text', text: 'for staff.' }] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'list them' }] }] }] },
    ] };
    expect(adfText(doc)).toBe('What is it?\nStored cards for staff.\nlist them');
    expect(adfText(doc, 10)).toBe('What is it…');
    expect(adfText(null)).toBe('');
  });
});
