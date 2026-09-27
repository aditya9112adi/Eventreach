import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';

/**
 * The footer is rendered once, by the shared layout. These guard the two
 * things that are easy to break later: the exact wording, and the "once"
 * part — a second copy added to an individual page would show up twice on
 * that page only, which is the kind of thing nobody notices for months.
 */

const FOOTER = 'frontend/src/components/ui/AppFooter.tsx';
const LAYOUT = 'frontend/src/layouts/DashboardLayout.tsx';

test('the footer carries the exact required text', () => {
  const source = fs.readFileSync(FOOTER, 'utf-8');
  assert.ok(source.includes('© 2026, Event Reach'), 'the copyright text must be exact');
  assert.ok(source.includes('Powered by SmartestStack'), 'the organization text must be exact');
});

test('it sits on one row on desktop and stacks on a phone', () => {
  const source = fs.readFileSync(FOOTER, 'utf-8');
  assert.ok(source.includes('flex-col'), 'the two texts stack on a small screen');
  assert.ok(source.includes('sm:flex-row'), 'and share a row from the sm breakpoint up');
  assert.ok(source.includes('sm:justify-between'), 'left text left, right text right');
});

test('it is part of the page flow, not pinned over the content', () => {
  // Comments are stripped first: the file explains *why* it is not fixed, and
  // that prose must not fail the very check it describes.
  const code = fs
    .readFileSync(FOOTER, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/\b(fixed|sticky|absolute)\b/.test(code), 'a pinned footer would cover long pages');
});

test('the shared layout renders it exactly once', () => {
  const layout = fs.readFileSync(LAYOUT, 'utf-8');
  const rendered = layout.match(/<AppFooter\s*\/>/g) ?? [];
  assert.equal(rendered.length, 1, 'exactly one <AppFooter /> in the shared layout');
  assert.ok(layout.includes("import { AppFooter }"), 'imported rather than redefined');
});

test('no page adds its own copy on top of the shared one', () => {
  const pages = 'frontend/src/pages';
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.tsx') && fs.readFileSync(full, 'utf-8').includes('<AppFooter')) {
        offenders.push(full);
      }
    }
  };
  walk(pages);
  assert.deepEqual(offenders, [], 'the footer belongs to the layout, not to individual pages');
});
