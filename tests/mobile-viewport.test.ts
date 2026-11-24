import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldUseMobileShell } from '../artifacts/praticosys/src/lib/mobileViewport';

test('shouldUseMobileShell enables mobile shell for narrow viewports (< 768px)', () => {
  assert.equal(
    shouldUseMobileShell({
      innerWidth: 390,
      isCoarsePointer: true,
      hasNoHover: true,
      anyPointerFine: false,
      maxTouchPoints: 5,
      screenMinSide: 390,
    }),
    true
  );

  assert.equal(
    shouldUseMobileShell({
      innerWidth: 640,
      isCoarsePointer: false,
      hasNoHover: false,
      anyPointerFine: true,
      maxTouchPoints: 0,
      screenMinSide: 1080,
    }),
    true
  );
});

test('shouldUseMobileShell keeps mobile collapsible shell on touch phones even in 980px desktop-site mode', () => {
  assert.equal(
    shouldUseMobileShell({
      innerWidth: 980,
      isCoarsePointer: true,
      hasNoHover: true,
      anyPointerFine: false,
      maxTouchPoints: 5,
      screenMinSide: 360,
    }),
    true
  );

  // Even if screen.width is spoofed to 980 by mobile browser Desktop mode
  assert.equal(
    shouldUseMobileShell({
      innerWidth: 980,
      isCoarsePointer: true,
      hasNoHover: true,
      anyPointerFine: false,
      maxTouchPoints: 5,
      screenMinSide: 980,
    }),
    true
  );
});

test('shouldUseMobileShell keeps desktop layout on PCs and touchscreen laptops (>= 768px)', () => {
  assert.equal(
    shouldUseMobileShell({
      innerWidth: 1440,
      isCoarsePointer: false,
      hasNoHover: false,
      anyPointerFine: true,
      maxTouchPoints: 0,
      screenMinSide: 900,
    }),
    false
  );

  assert.equal(
    shouldUseMobileShell({
      innerWidth: 980,
      isCoarsePointer: false,
      hasNoHover: false,
      anyPointerFine: true,
      maxTouchPoints: 10, // touchscreen Windows laptop with trackpad/mouse
      screenMinSide: 768,
    }),
    false
  );
});
