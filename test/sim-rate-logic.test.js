'use strict';

const test = require('node:test');
const assert = require('node:assert');

const logic = require('../html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.js');

test('LADDER is the eight approved rates in order', () => {
  assert.deepStrictEqual(logic.LADDER, [0.25, 0.5, 1, 2, 4, 8, 16, 32]);
  assert.strictEqual(logic.DEFAULT_INDEX, 2);
});

test('nearestIndex maps exact ladder rates to their own index', () => {
  assert.strictEqual(logic.nearestIndex(0.25), 0);
  assert.strictEqual(logic.nearestIndex(1), 2);
  assert.strictEqual(logic.nearestIndex(32), 7);
});

test('nearestIndex clamps rates outside the ladder to its ends', () => {
  assert.strictEqual(logic.nearestIndex(0.05), 0);
  assert.strictEqual(logic.nearestIndex(128), 7);
});

test('nearestIndex snaps between rungs by ratio, not by subtraction', () => {
  // 0.75 is equidistant from 0.5 and 1 by subtraction; by ratio 1x is nearer.
  assert.strictEqual(logic.nearestIndex(0.75), 2);
  // 3 sits between 2 and 4; by ratio 4x is nearer.
  assert.strictEqual(logic.nearestIndex(3), 4);
});

test('nearestIndex reports -1 when there is no usable rate', () => {
  assert.strictEqual(logic.nearestIndex(0), -1);
  assert.strictEqual(logic.nearestIndex(-2), -1);
  assert.strictEqual(logic.nearestIndex(NaN), -1);
  assert.strictEqual(logic.nearestIndex(Infinity), -1);
  assert.strictEqual(logic.nearestIndex(undefined), -1);
});

test('formatRate renders the multiplication sign and trims noise', () => {
  assert.strictEqual(logic.formatRate(0.25), '0.25×');
  assert.strictEqual(logic.formatRate(0.5), '0.5×');
  assert.strictEqual(logic.formatRate(1), '1×');
  assert.strictEqual(logic.formatRate(16), '16×');
  assert.strictEqual(logic.formatRate(1.0001), '1×');
});

test('formatRate renders an em dash when there is no usable rate', () => {
  assert.strictEqual(logic.formatRate(NaN), '—');
  assert.strictEqual(logic.formatRate(0), '—');
});

test('an idle state asks for nothing', () => {
  const result = logic.advance(logic.createState(), 1, 16);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.state.targetIndex, null);
});

test('requestRate ignores an index off the ladder', () => {
  const state = logic.createState();
  assert.strictEqual(logic.requestRate(state, -1), state);
  assert.strictEqual(logic.requestRate(state, 8), state);
});

test('requesting the rate already running finishes without an event', () => {
  const state = logic.requestRate(logic.createState(), 2); // 1x
  const result = logic.advance(state, 1, 16);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.state.targetIndex, null);
});

test('a request above the current rate fires INCR, below fires DECR', () => {
  const up = logic.advance(logic.requestRate(logic.createState(), 4), 1, 16);
  assert.strictEqual(up.action, 'INCR');
  assert.strictEqual(up.status, 'adjusting');

  const down = logic.advance(logic.requestRate(logic.createState(), 1), 4, 16);
  assert.strictEqual(down.action, 'DECR');
});

test('after firing, it waits for the sim instead of firing again', () => {
  let state = logic.requestRate(logic.createState(), 4); // 4x
  let result = logic.advance(state, 1, 16);
  assert.strictEqual(result.action, 'INCR');

  // Rate has not moved yet and the budget has not run out: stay quiet.
  result = logic.advance(result.state, 1, 100);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'adjusting');

  // The sim reacted: step again toward the target.
  result = logic.advance(result.state, 2, 16);
  assert.strictEqual(result.action, 'INCR');

  // Target reached.
  result = logic.advance(result.state, 4, 16);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.state.targetIndex, null);
});

test('a stalled sim gets one retry, then the request is abandoned', () => {
  let state = logic.requestRate(logic.createState(), 5); // 8x
  let result = logic.advance(state, 1, 16);
  assert.strictEqual(result.action, 'INCR');

  // First budget expires with no movement -> one retry.
  result = logic.advance(result.state, 1, logic.WAIT_BUDGET_MS);
  assert.strictEqual(result.action, 'INCR');
  assert.strictEqual(result.status, 'adjusting');

  // Second budget expires with no movement -> give up and report it.
  result = logic.advance(result.state, 1, logic.WAIT_BUDGET_MS);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'refused');
  assert.strictEqual(result.state.targetIndex, null);
});

test('a refusal stays on screen until the next request', () => {
  let state = logic.requestRate(logic.createState(), 5);
  let result = logic.advance(state, 1, 16);
  result = logic.advance(result.state, 1, logic.WAIT_BUDGET_MS);
  result = logic.advance(result.state, 1, logic.WAIT_BUDGET_MS);
  assert.strictEqual(result.status, 'refused');

  result = logic.advance(result.state, 1, 16);
  assert.strictEqual(result.status, 'refused');

  const retry = logic.advance(logic.requestRate(result.state, 3), 1, 16);
  assert.strictEqual(retry.status, 'adjusting');
});

test('movement resets the stall count', () => {
  let state = logic.requestRate(logic.createState(), 5); // 8x
  let result = logic.advance(state, 1, 16);
  result = logic.advance(result.state, 1, logic.WAIT_BUDGET_MS); // stall 1, retry
  result = logic.advance(result.state, 2, 16);                   // it moved
  assert.strictEqual(result.state.stalls, 0);
  result = logic.advance(result.state, 2, logic.WAIT_BUDGET_MS); // stall 1 again
  assert.strictEqual(result.action, 'INCR');
  assert.strictEqual(result.status, 'adjusting');
});

test('losing the rate entirely abandons the request quietly', () => {
  const state = logic.requestRate(logic.createState(), 4);
  const result = logic.advance(state, NaN, 16);
  assert.strictEqual(result.action, null);
  assert.strictEqual(result.status, 'idle');
  assert.strictEqual(result.state.targetIndex, null);
});

test('advance does not mutate the state it is given', () => {
  const state = logic.requestRate(logic.createState(), 4);
  const snapshot = JSON.stringify(state);
  logic.advance(state, 1, 16);
  assert.strictEqual(JSON.stringify(state), snapshot);
});

/**
 * A stand-in for the sim: key events move the rate along the ladder, but the
 * reported rate only catches up on the following tick, like the real SimVar.
 */
function fakeSim(startRate, options) {
  const opts = options || {};
  let reported = startRate;
  let pending = startRate;
  return {
    events: [],
    getRate() {
      const value = reported;
      reported = pending;
      return value;
    },
    fireEvent(name) {
      this.events.push(name);
      if (opts.ignoreEvents) {
        return;
      }
      const index = logic.nearestIndex(pending);
      const next = name === 'K:SIM_RATE_INCR' ? index + 1 : index - 1;
      const clampIndex = opts.maxIndex === undefined ? logic.LADDER.length - 1 : opts.maxIndex;
      pending = logic.LADDER[Math.max(0, Math.min(clampIndex, next))];
    }
  };
}

function run(controller, sim, ticks) {
  let last = null;
  for (let i = 0; i < ticks; i++) {
    last = controller.tick(16);
  }
  return last;
}

test('the controller walks the sim to the requested rate', () => {
  const sim = fakeSim(1);
  const controller = logic.createController(sim);
  controller.request(5); // 8x
  const snapshot = run(controller, sim, 12);
  assert.strictEqual(snapshot.rate, 8);
  assert.strictEqual(snapshot.index, 5);
  assert.strictEqual(snapshot.status, 'idle');
  assert.deepStrictEqual(sim.events, [
    'K:SIM_RATE_INCR', 'K:SIM_RATE_INCR', 'K:SIM_RATE_INCR'
  ]);
});

test('the controller walks downward too', () => {
  const sim = fakeSim(16);
  const controller = logic.createController(sim);
  controller.request(2); // 1x
  const snapshot = run(controller, sim, 16);
  assert.strictEqual(snapshot.rate, 1);
  assert.deepStrictEqual(sim.events, [
    'K:SIM_RATE_DECR', 'K:SIM_RATE_DECR', 'K:SIM_RATE_DECR', 'K:SIM_RATE_DECR'
  ]);
});

test('the controller stops at the sim cap and reports the refusal', () => {
  const sim = fakeSim(1, { maxIndex: 3 }); // sim will not go above 2x
  const controller = logic.createController(sim);
  controller.request(7); // 32x
  let snapshot = null;
  for (let i = 0; i < 200; i++) {
    snapshot = controller.tick(16);
  }
  assert.strictEqual(snapshot.rate, 2);
  assert.strictEqual(snapshot.status, 'refused');
});

test('the controller fires nothing when the sim ignores everything', () => {
  const sim = fakeSim(1, { ignoreEvents: true });
  const controller = logic.createController(sim);
  controller.request(5);
  let snapshot = null;
  for (let i = 0; i < 100; i++) {
    snapshot = controller.tick(16);
  }
  assert.strictEqual(snapshot.status, 'refused');
  assert.strictEqual(sim.events.length, logic.MAX_STALLS);
});

test('the controller reports rate changes it did not cause', () => {
  const sim = fakeSim(1);
  const controller = logic.createController(sim);
  assert.strictEqual(controller.tick(16).rate, 1);

  sim.fireEvent('K:SIM_RATE_INCR'); // stands in for a keybind press
  sim.events.length = 0;
  controller.tick(16);
  const snapshot = controller.tick(16);
  assert.strictEqual(snapshot.rate, 2);
  assert.strictEqual(snapshot.index, 3);
  assert.deepStrictEqual(sim.events, []);
});
