import { useEffect, useState } from 'react';

export interface MobileViewportSignals {
  innerWidth: number;
  isCoarsePointer: boolean;
  hasNoHover: boolean;
  anyPointerFine: boolean;
  maxTouchPoints: number;
  screenMinSide?: number;
}

/**
 * Determines whether the application shell should render in mobile collapsible
 * drawer mode instead of the pinned desktop sidebar.
 *
 * Beyond standard `< 768px` viewports, this also detects touch-only phones when
 * a mobile browser opens with a desktop-style virtual viewport (~980px, e.g.
 * Chrome "Para computador" / Desktop site), while keeping desktop PCs and
 * touchscreen laptops (which have a fine pointer / hover) in desktop mode.
 */
export function shouldUseMobileShell(signals: MobileViewportSignals): boolean {
  if (signals.innerWidth < 768) {
    return true;
  }

  const isTouchOnlyPhoneHardware =
    signals.maxTouchPoints > 0 &&
    !signals.anyPointerFine &&
    (signals.isCoarsePointer || signals.hasNoHover);

  if (isTouchOnlyPhoneHardware && signals.innerWidth <= 1280) {
    return true;
  }

  if (
    typeof signals.screenMinSide === 'number' &&
    signals.screenMinSide > 0 &&
    signals.screenMinSide < 640 &&
    signals.maxTouchPoints > 0 &&
    !signals.anyPointerFine
  ) {
    return true;
  }

  return false;
}

export function readMobileViewportSignals(): MobileViewportSignals {
  if (typeof window === 'undefined') {
    return {
      innerWidth: 1024,
      isCoarsePointer: false,
      hasNoHover: false,
      anyPointerFine: true,
      maxTouchPoints: 0,
      screenMinSide: 1024,
    };
  }

  const mq = typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : null;
  const screenWidth = typeof window.screen?.width === 'number' ? window.screen.width : 0;
  const screenHeight = typeof window.screen?.height === 'number' ? window.screen.height : 0;
  const screenMinSide =
    screenWidth > 0 && screenHeight > 0 ? Math.min(screenWidth, screenHeight) : undefined;

  return {
    innerWidth: window.innerWidth,
    isCoarsePointer: mq ? mq('(pointer: coarse)').matches : false,
    hasNoHover: mq ? mq('(hover: none)').matches : false,
    anyPointerFine: mq ? mq('(any-pointer: fine)').matches : false,
    maxTouchPoints: typeof navigator !== 'undefined' ? (navigator.maxTouchPoints ?? 0) : 0,
    screenMinSide,
  };
}

export function useIsMobileShell(): boolean {
  const [isMobileShell, setIsMobileShell] = useState<boolean>(() =>
    shouldUseMobileShell(readMobileViewportSignals())
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const update = () => {
      setIsMobileShell(shouldUseMobileShell(readMobileViewportSignals()));
    };

    update();
    window.addEventListener('resize', update);

    const queries =
      typeof window.matchMedia === 'function'
        ? [
            window.matchMedia('(pointer: coarse)'),
            window.matchMedia('(hover: none)'),
            window.matchMedia('(any-pointer: fine)'),
          ]
        : [];

    for (const q of queries) {
      if (typeof q.addEventListener === 'function') {
        q.addEventListener('change', update);
      }
    }

    return () => {
      window.removeEventListener('resize', update);
      for (const q of queries) {
        if (typeof q.removeEventListener === 'function') {
          q.removeEventListener('change', update);
        }
      }
    };
  }, []);

  return isMobileShell;
}
