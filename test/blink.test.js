// Blink SOS detector: 3 deliberate blinks trigger; natural quick blinks and slow drowsiness do not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBlinkDetector } from '../public/js/blink.js';

// Simulate a 30 fps EAR stream: open ≈0.30, closed ≈0.08.
function run(det, plan) {
  const events = []; let t = 0;
  for (const [state, ms] of plan) {
    for (let k = 0; k < ms; k += 33) { const ear = state === 'open' ? 0.30 + Math.sin(t / 97) * 0.01 : 0.08; const ev = det.feed(ear, t); if (ev) events.push([ev, t]); t += 33; }
  }
  return events;
}
const open = (ms) => ['open', ms];
const shut = (ms) => ['closed', ms];

test('three deliberate (≈400 ms) blinks within 6 s trigger once', () => {
  const ev = run(createBlinkDetector(), [open(2000), shut(400), open(600), shut(400), open(600), shut(450), open(1000)]);
  assert.deepEqual(ev.map((e) => e[0]), ['blink', 'blink', 'trigger']);
});

test('natural quick blinks (~100 ms) never trigger', () => {
  const plan = [open(2000)];
  for (let i = 0; i < 12; i++) plan.push(shut(100), open(500));
  assert.deepEqual(run(createBlinkDetector(), plan), []);
});

test('blinks spread over more than 6 s do not add up; eyes closed for long (sleepy) do not count', () => {
  assert.ok(!run(createBlinkDetector(), [open(2000), shut(400), open(4000), shut(400), open(4000), shut(400), open(500)]).some((e) => e[0] === 'trigger'));
  assert.deepEqual(run(createBlinkDetector(), [open(2000), shut(3000), open(800), shut(3000), open(800), shut(3000), open(800)]), []);
});

test('cool-down prevents a second trigger right after the first', () => {
  const plan = [open(2000)];
  for (let i = 0; i < 6; i++) plan.push(shut(400), open(500));
  assert.equal(run(createBlinkDetector(), plan).filter((e) => e[0] === 'trigger').length, 1);
});

test('face lost (no landmarks) resets a half-finished blink', () => {
  const d = createBlinkDetector();
  run(d, [open(2000)]);
  d.feed(0.08, 10000); d.feed(NaN, 10300); assert.equal(d.feed(0.3, 10500), null);
});

// Voice SOS words (shared by Android, iPhone, browser and voice commands)
import { sosWords, heardSosWord, ownSosWords } from '../public/js/i18n.js';
test('voice SOS words: only her own words (default "bachao", in every script); whole-word match for Latin', () => {
  const def = sosWords('te', []);
  for (const said of ['bachao', 'please bachao me', 'బచావో', 'बचाओ', 'বাঁচাও', 'بچاؤ']) assert.ok(heardSosWord(said, def), said);
  for (const said of ['help', 'help me', 'beti bachao app is open'.replace('bachao', 'b'), 'kapadandi', 'hello there']) assert.ok(!heardSosWord(said, def), said);
  const own = sosWords('te', ['Pineapple', 'blue umbrella']);
  for (const said of ['pineapple', 'I see a blue umbrella']) assert.ok(heardSosWord(said, own), said);
  for (const said of ['bachao', 'the apples are fresh', 'help']) assert.ok(!heardSosWord(said, own), said);
  assert.deepEqual(ownSosWords([]), ['bachao']);
  assert.deepEqual(ownSosWords(['ab', ' mango ']), ['mango']);
});
