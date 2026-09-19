// The credits sheet: three decisions in order, and one press at the end.
//
// Deliberately textual for the structure claims. Every dialog in this app goes
// through ui/Modal.jsx, which `createPortal`s into `document.body` — and the
// render harness stubs the document as plain objects, so React refuses the
// portal with "Target container is not a DOM element" before any of this
// sheet's own markup exists. There is no rendered form to assert on here. The
// rule the redesign turns on IS rendered, as a pure function, and is tested as
// one below.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
// Registers the JSX loader hook this file needs to import a .jsx module at all.
const { importComponent } = require('./helpers/render.js');

const SHEET = path.join(__dirname, '..', 'src', 'dialogs', 'CreditsDialog.jsx');
const source = () => fs.readFileSync(SHEET, 'utf8');

test('the amount belongs to the one-off path, not to the whole sheet', () => {
  // The bug the reordering fixed: the amount picker used to sit ABOVE all four
  // rails, where it read as applying to the monthly plans and never did — a
  // plan's price is the plan's. It renders inside the `monthly ? … : …` else
  // arm now, so it cannot be on screen while a plan is being chosen.
  const body = source();
  const branch = body.slice(body.indexOf('{monthly ? ('));
  const plansArm = branch.slice(0, branch.indexOf(') : ('));
  const topUpArm = branch.slice(branch.indexOf(') : ('));
  assert.match(topUpArm, /<AmountPicker/);
  assert.doesNotMatch(plansArm, /<AmountPicker/);
  assert.match(plansArm, /<PlanCards/);
});

test('a rail that cannot be used stays on the list wearing its reason', () => {
  // Both wallet refusals are known before the press, and neither is repaired by
  // trying. A rail that VANISHES instead is indistinguishable from one that
  // never existed, so the row is disabled and carries the reason as its hint.
  const body = source();
  assert.match(body, /'no-app': t\('credits\.walletLocalOnly'\)/);
  assert.match(body, /'different-account': t\('credits\.walletOtherAccount'\)/);
  assert.match(body, /hint=\{walletReason \|\| t\('credits\.walletHint'\)\}/);
  assert.match(body, /off=\{walletOff\}/);
  // …and a rail that goes unusable AFTER it was chosen hands the choice back,
  // rather than leaving the footer press aimed at something that cannot work.
  assert.match(body, /if \(\(method === 'usdc' && usdcOff\) \|\| \(method === 'wallet' && walletOff\)\) setMethod\('card'\)/);
});

test('one press, and the footer always names where it ends', () => {
  // Four rails each with their own button became one CTA whose label is derived
  // from the choice. The honesty line is the promise that survived the rewrite:
  // nothing is charged in this sheet, whichever rail is showing.
  const body = source();
  assert.match(body, /const honesty = monthly \|\| method === 'card'/);
  for (const key of ['honestyCard', 'honestyCrypto', 'honestyWallet']) {
    assert.match(body, new RegExp(`credits\\.${key}`));
  }
  // The external-link icon is a claim that a new tab is about to open, so it is
  // carried by the rails that actually open one and by no others.
  assert.match(body, /icon=\{cta\.external \? 'external' : undefined\}/);
});

test('"Better rate" is claimed only when the printed rates back it up', async () => {
  await importComponent('src/dialogs/CreditsDialog.jsx', 'CreditsDialog');
  const { betterRateThanTopUp } = await import(pathToFileURL(SHEET).href);
  // 500.25 credits a dollar beats a top-up's 500 arithmetically and prints as
  // "500 per $1" — the badge would be arguing with the three numbers under it.
  assert.equal(betterRateThanTopUp([{ priceUsdMonthly: 19.99, monthlyCredits: 10000 }]), false);
  assert.equal(betterRateThanTopUp([{ priceUsdMonthly: 20, monthlyCredits: 12000 }]), true);
  // Nothing quoted claims nothing: no plans, and a plan the gateway sent
  // without a usable price.
  assert.equal(betterRateThanTopUp([]), false);
  assert.equal(betterRateThanTopUp([{ priceUsdMonthly: 0, monthlyCredits: 12000 }]), false);
  assert.equal(betterRateThanTopUp([{ monthlyCredits: 12000 }]), false);
});

test('the plan you have and the plan you are choosing are drawn apart', () => {
  // Reported: with one plan running, picking another lit BOTH cards in the
  // selected style, so the sheet showed two current plans. Selection is the
  // honey card and nothing else; the running plan is named by its badge.
  const body = source();
  const cards = body.slice(body.indexOf('function PlanCards'), body.indexOf('/* ---------------- the sheet'));
  assert.match(cards, /const on = picked === plan\.tier;/);
  assert.doesNotMatch(cards, /const on = active \|\| /);
  assert.match(cards, /\{active \? \(/);
});

test('changing a running plan is a switch, and buying a first one is not', () => {
  // "Subscribe to Pro" beside a card marked Active reads as buying a SECOND
  // plan. The label follows whether a plan is already running.
  const body = source();
  assert.match(body, /const running = current\?\.tier \|\| '';/);
  assert.match(body, /tf\(running \? 'credits\.switchTo' : 'credits\.subscribeTo', titled\(tier\)\)/);
});

test('each amount carries what it buys, rather than one figure for whichever is picked', () => {
  // Reported: the credit figure sat in the section's top-right corner and
  // described only the selected amount, so comparing the ladder meant selecting
  // each rung in turn. Every card answers for itself now.
  const body = source();
  const picker = body.slice(body.indexOf('function AmountPicker'), body.indexOf('/** One way to pay'));
  assert.match(picker, /creditsForUsd\(value\)/);
  assert.doesNotMatch(picker, /creditsForUsd\(amountUsd\)/);
});
