import { test, expect } from 'bun:test';
const { render } = require('./md.js');

test('escapes HTML before rendering', () => {
  expect(render('<img src=x onerror=alert(1)> **hi**')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <strong>hi</strong></p>');
});

test('lists, headings, links, tweet refs', () => {
  const html = render('## To do\n- [ ] Fix titles [[tweet:1002]]\n- see https://hono.dev.\n\n1. one\n2. [two](https://a.com/x)');
  expect(html).toBe('<h4>To do</h4><ul><li>☐ Fix titles <span data-tweet="1002"></span></li><li>see <a href="https://hono.dev" target="_blank" rel="noopener">https://hono.dev</a>.</li></ul><ol><li>one</li><li><a href="https://a.com/x" target="_blank" rel="noopener">two</a></li></ol>');
});

test('rejects non-http links', () => {
  expect(render('[x](javascript:alert(1))')).toBe('<p>[x](javascript:alert(1))</p>');
});
