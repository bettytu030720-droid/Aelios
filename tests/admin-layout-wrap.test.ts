import assert from "node:assert/strict";
import { test } from "node:test";
import { ADMIN_HTML } from "../src/api/admin/ui";

test("admin panels and responsive grids constrain horizontal width on mobile", () => {
  assert.match(ADMIN_HTML, /\.panel\s*\{[^}]*min-width:\s*0;/);
  assert.match(ADMIN_HTML, /\.wrap-anywhere\s*\{\s*overflow-wrap:\s*anywhere;\s*\}/);
  assert.match(ADMIN_HTML, /\.journal\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(ADMIN_HTML, /class="grid grid-cols-1 gap-5 lg:grid-cols-\[minmax\(0,1fr\)_340px\] lg:items-start"/);
  assert.match(ADMIN_HTML, /class="grid grid-cols-1 gap-5 lg:grid-cols-\[minmax\(0,1fr\)_360px\] lg:items-start"/);
  assert.match(ADMIN_HTML, /class="grid grid-cols-1 gap-6 lg:grid-cols-\[180px_minmax\(0,1fr\)\] lg:items-start"/);
});

test("home chat messages and side cards break long unbroken tokens inside the panel", () => {
  assert.match(
    ADMIN_HTML,
    /<p class="mt-1 whitespace-pre-wrap wrap-anywhere text-sm leading-7" :class="more \? '' : 'line-clamp-6'" x-text="message\.content"><\/p>/
  );
  assert.match(
    ADMIN_HTML,
    /<span class="min-w-0 flex-1 wrap-anywhere text-sm leading-6" x-text="item\.content"><\/span>/
  );
  assert.match(
    ADMIN_HTML,
    /<p class="line-clamp-5 wrap-anywhere text-sm leading-7" style="color: var\(--t2\)" x-text="home\.diary\.summary"><\/p>/
  );
});
