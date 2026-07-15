import assert from 'node:assert/strict';
import { cursorDisplayScale, scaledCursorGeometry } from '../novnc/cursor-scale.mjs';

assert.equal(cursorDisplayScale(3456, 2234, 1728, 1117), 0.5);
assert.equal(cursorDisplayScale(3456, 2234, 864, 558.5), 0.25);
assert.equal(cursorDisplayScale(0, 0, 0, 0), 1);

assert.deepEqual(scaledCursorGeometry(32, 48, 7, 11, 0.5), {
  width: 16,
  height: 24,
  hotX: 4,
  hotY: 6,
});
assert.deepEqual(scaledCursorGeometry(1, 1, 0, 0, 0.1), {
  width: 1,
  height: 1,
  hotX: 0,
  hotY: 0,
});

console.log('agent-chrome cursor scaling test passed');
