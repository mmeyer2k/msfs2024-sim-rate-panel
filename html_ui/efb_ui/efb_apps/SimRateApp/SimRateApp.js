/**
 * Sim Rate Panel - an EFB app for Microsoft Flight Simulator 2024.
 *
 * Loaded two ways, which is why it is a classic script with no imports:
 *   - by the sim, as html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.js
 *   - by node --test, via require(), which stops at the EFB guard below
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ ladder

  const LADDER = [0.25, 0.5, 1, 2, 4, 8, 16, 32];
  const DEFAULT_INDEX = 2; // 1x
  const WAIT_BUDGET_MS = 250;
  const MAX_STALLS = 2;
  // The longest legitimate walk is 0.25x <-> 128x, nine rungs, and the sim can
  // report rates outside our ladder. Twelve leaves margin for that without ever
  // letting a request fire forever.
  const MAX_STEPS = 12;

  /**
   * Snaps a reported sim rate to the nearest ladder index.
   * Distance is measured on a log scale: the ladder doubles, so 3 belongs to
   * 4x, not to 2x, even though subtraction says otherwise.
   * @returns {number} ladder index, or -1 when there is no usable rate
   */
  function nearestIndex(rate) {
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
      return -1;
    }
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < LADDER.length; i++) {
      const distance = Math.abs(Math.log(rate) - Math.log(LADDER[i]));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }
    return best;
  }

  /** Formats a rate for display, e.g. 0.25x, 1x, 16x, or an em dash. */
  function formatRate(rate) {
    if (typeof rate !== 'number' || !isFinite(rate) || rate <= 0) {
      return '\u2014';
    }
    return String(Math.round(rate * 100) / 100) + '\u00d7';
  }

  // ----------------------------------------------------------------- reducer

  /** The idle/reset state shape, with a status of the caller's choosing. */
  function resetState(status) {
    return {
      targetIndex: null,
      lastObserved: null,
      waitedMs: 0,
      stalls: 0,
      steps: 0,
      status: status
    };
  }

  /** @returns {object} a fresh, idle reducer state */
  function createState() {
    return resetState('idle');
  }

  /** Aims the reducer at a ladder index. Off-ladder indices are ignored. */
  function requestRate(state, targetIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= LADDER.length) {
      return state;
    }
    return {
      targetIndex: targetIndex,
      lastObserved: null,
      waitedMs: 0,
      stalls: 0,
      steps: 0,
      status: 'adjusting'
    };
  }

  /**
   * Decides the next key event, if any.
   *
   * Only ever emits one step at a time and then waits for the sim rate to
   * actually move, because the SimVar lags the key event by a frame or more -
   * firing every frame would sail past the target. Two expired waits in a row
   * mean the sim is refusing the change (it does that while paused, and it
   * caps the rate in multiplayer), so the request is dropped rather than
   * retried forever.
   */
  function advance(state, currentRate, elapsedMs) {
    if (state.targetIndex === null) {
      return { state: state, action: null, status: state.status };
    }

    const index = nearestIndex(currentRate);
    const target = LADDER[state.targetIndex];

    // Settle on the rate itself, not the snapped index: nearestIndex snaps, so
    // an index match can be true for a rate that is not actually the target
    // (64x snaps to the same index as 32x; 3x already snaps to 4x). Settling on
    // the index would make the preset a silent no-op in those cases.
    if (index === -1 || Math.abs(currentRate - target) <= 1e-6 * target) {
      return { state: resetState('idle'), action: null, status: 'idle' };
    }

    let stalls = state.stalls;
    if (state.lastObserved !== null && currentRate === state.lastObserved) {
      const waited = state.waitedMs + elapsedMs;
      if (waited < WAIT_BUDGET_MS) {
        return {
          state: {
            targetIndex: state.targetIndex,
            lastObserved: state.lastObserved,
            waitedMs: waited,
            stalls: stalls,
            steps: state.steps,
            status: 'adjusting'
          },
          action: null,
          status: 'adjusting'
        };
      }
      stalls = stalls + 1;
      if (stalls >= MAX_STALLS) {
        return { state: resetState('refused'), action: null, status: 'refused' };
      }
    } else {
      stalls = 0;
    }

    // Hard per-request budget: any change-without-progress (float jitter, a
    // rung between ours, a competing add-on, a held keybind) resets stalls to
    // 0 above, which would otherwise let this fire one key event per frame
    // indefinitely.
    if (state.steps >= MAX_STEPS) {
      return { state: resetState('refused'), action: null, status: 'refused' };
    }

    return {
      state: {
        targetIndex: state.targetIndex,
        lastObserved: currentRate,
        waitedMs: 0,
        stalls: stalls,
        steps: state.steps + 1,
        status: 'adjusting'
      },
      // Direction also comes from the rate, not the snapped index, for the
      // same reason the settle check above does: at 3x heading for 4x,
      // nearestIndex(3) is already 4, so comparing indices says "go down".
      action: currentRate < target ? 'INCR' : 'DECR',
      status: 'adjusting'
    };
  }

  // -------------------------------------------------------------- controller

  /**
   * Drives the reducer against a sim.
   * @param {{ getRate: function(): number, fireEvent: function(string): void }} deps
   */
  function createController(deps) {
    let state = createState();

    return {
      /** Aims at a ladder index; the next tick starts moving. */
      request: function (targetIndex) {
        state = requestRate(state, targetIndex);
      },

      /** Drops any in-flight request; the next tick starts clean. */
      cancel: function () {
        state = createState();
      },

      /**
       * Reads the sim, emits at most one key event, and reports what to draw.
       * @returns {{ rate: number, index: number, status: string }}
       */
      tick: function (elapsedMs) {
        const rate = deps.getRate();
        const result = advance(state, rate, elapsedMs);
        state = result.state;
        if (result.action === 'INCR') {
          deps.fireEvent('K:SIM_RATE_INCR');
        } else if (result.action === 'DECR') {
          deps.fireEvent('K:SIM_RATE_DECR');
        }
        return { rate: rate, index: nearestIndex(rate), status: result.status };
      }
    };
  }

  const SimRateLogic = {
    LADDER: LADDER,
    DEFAULT_INDEX: DEFAULT_INDEX,
    WAIT_BUDGET_MS: WAIT_BUDGET_MS,
    MAX_STALLS: MAX_STALLS,
    nearestIndex: nearestIndex,
    formatRate: formatRate,
    createState: createState,
    requestRate: requestRate,
    advance: advance,
    createController: createController
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = SimRateLogic;
  }

  // ---------------------------------------------------------- EFB integration

  // Under node --test there is no EFB and no SDK; the exports above are all
  // that is wanted. Returning quietly is deliberate - a throw here would be
  // caught by Container.use, which drops the script and the app disappears.
  if (typeof window === 'undefined' || !window.EFB_API || typeof msfssdk === 'undefined') {
    return;
  }

  const FSComponent = msfssdk.FSComponent;
  const APP_ROOT = 'coui://html_ui/efb_ui/efb_apps/SimRateApp/';
  const APP_CSS = APP_ROOT + 'SimRateApp.css';
  const APP_ICON = APP_ROOT + 'Assets/Icons/SimRate.svg';
  const EFB_API_VERSION = '1.0.3';

  const STATUS_TEXT = {
    idle: '',
    adjusting: 'Adjusting\u2026',
    refused: 'Sim refused the change \u2014 paused or multiplayer limit'
  };

  class SimRateAppView extends msfssdk.DisplayComponent {
    constructor(props) {
      super(props);
      this.readoutRef = FSComponent.createRef();
      this.statusRef = FSComponent.createRef();
      this.resetRef = FSComponent.createRef();
      this.buttonRefs = LADDER.map(function () { return FSComponent.createRef(); });
      this.listeners = [];
      this.lastTime = null;
      this.shownRate = null;
      this.shownIndex = null;
      this.shownStatus = null;
      this.controller = createController({
        getRate: function () { return SimVar.GetSimVarValue('E:SIMULATION RATE', 'number'); },
        fireEvent: function (name) {
          const result = SimVar.SetSimVarValue(name, 'number', 0);
          if (result && typeof result.catch === 'function') {
            result.catch(function () { return undefined; });
          }
        }
      });
    }

    render() {
      const self = this;
      return FSComponent.buildComponent('div', { class: 'sim-rate-app' },
        FSComponent.buildComponent('div', { class: 'sim-rate-readout' },
          FSComponent.buildComponent('div', { class: 'sim-rate-value', ref: this.readoutRef }, '\u2014'),
          FSComponent.buildComponent('div', { class: 'sim-rate-caption' }, 'current sim rate')
        ),
        FSComponent.buildComponent('div', { class: 'sim-rate-status', ref: this.statusRef }, ''),
        FSComponent.buildComponent('div', { class: 'sim-rate-grid' },
          LADDER.map(function (rate, index) {
            return FSComponent.buildComponent('div', {
              class: 'sim-rate-preset',
              ref: self.buttonRefs[index]
            }, formatRate(rate));
          })
        ),
        FSComponent.buildComponent('div', { class: 'sim-rate-reset', ref: this.resetRef }, 'Reset to 1\u00d7')
      );
    }

    onAfterRender() {
      const self = this;
      this.buttonRefs.forEach(function (ref, index) {
        self.listen(ref.getOrDefault(), function () { self.controller.request(index); });
      });
      this.listen(this.resetRef.getOrDefault(), function () {
        self.controller.request(DEFAULT_INDEX);
      });
    }

    /** Registers a click handler and remembers it so destroy() can undo it. */
    listen(element, handler) {
      if (!element) {
        return;
      }
      element.addEventListener('click', handler);
      this.listeners.push({ element: element, handler: handler });
    }

    onUpdate(time) {
      // onResume resets lastTime when the app is switched away from and back,
      // but not when the EFB view itself is merely stowed and re-shown while
      // this app stays current - clamp so a stale lastTime cannot produce one
      // arbitrarily huge delta that burns a stall and fires a step immediately.
      const elapsed = this.lastTime === null ? 0 : Math.min(Math.max(0, time - this.lastTime), 1000);
      this.lastTime = time;
      this.draw(this.controller.tick(elapsed));
    }

    /** Writes to the DOM only where something actually changed. */
    draw(snapshot) {
      if (!Object.is(snapshot.rate, this.shownRate)) {
        this.shownRate = snapshot.rate;
        const readout = this.readoutRef.getOrDefault();
        if (readout) {
          readout.textContent = formatRate(snapshot.rate);
        }
      }
      if (snapshot.index !== this.shownIndex) {
        this.shownIndex = snapshot.index;
        this.buttonRefs.forEach(function (ref, index) {
          const button = ref.getOrDefault();
          if (button) {
            button.classList.toggle('active', index === snapshot.index);
          }
        });
      }
      if (snapshot.status !== this.shownStatus) {
        this.shownStatus = snapshot.status;
        const status = this.statusRef.getOrDefault();
        if (status) {
          status.textContent = STATUS_TEXT[snapshot.status] || '';
        }
      }
    }

    onOpen() { /* nothing to set up beyond the constructor */ }

    onClose() { /* nothing to tear down until destroy() */ }

    onResume() {
      // The clock kept running while the app was away; do not bill that
      // elapsed time to the wait budget.
      this.lastTime = null;
    }

    onPause() {
      // The EFB stops ticking us here. Drop any half-finished walk rather than
      // resuming it minutes later when the user reopens the tablet.
      this.controller.cancel();
    }

    /** The EFB routes gamepad input here; this panel is pointer-only. */
    routeGamepadInteractionEvent() { }

    /** The EFB routes deep links here; this panel has a single view. */
    handlePageKeyAction() { }

    destroy() {
      this.listeners.forEach(function (entry) {
        entry.element.removeEventListener('click', entry.handler);
      });
      this.listeners = [];
      if (super.destroy) {
        super.destroy();
      }
    }
  }

  class SimRateApp {
    constructor() {
      this.available = msfssdk.Subject.create(true);
      this.BootMode = 0;    // AppBootMode.COLD
      this.SuspendMode = 0; // AppSuspendMode.SLEEP
      this.options = {};
      this._favoriteIndex = -1;
      this._isInstalled = false;
      this._isReady = false;
    }

    // internalName is hardcoded rather than taken from constructor.name so a
    // future minifier cannot rename the app out from under the EFB.
    get internalName() { return 'SimRateApp'; }
    get name() { return 'Sim Rate'; }
    get icon() { return APP_ICON; }
    get compatibleAircraftModels() { return undefined; }
    get isReady() { return this._isReady; }
    get favoriteIndex() { return this._favoriteIndex; }
    set favoriteIndex(index) { this._favoriteIndex = index; }
    get unitsSettingsManager() { return this._unitsSettingsManager; }
    get efbSettingsManager() { return this._efbSettingsManager; }
    get notificationManager() { return this._notificationManager; }
    get onboardingManager() { return this._onboardingManager; }

    getVersion() { return '1.0.0'; }
    getIsSearchable() { return true; }
    getIsFavoritable() { return true; }

    install() {
      // loadCss rejects if the sheet is already present, which is benign - but it
      // also rejects on a genuine load failure, and an unstyled panel with no
      // diagnostic is the hardest kind of problem to chase in the sim. Log, then
      // resolve: a missing stylesheet should never stop the app installing.
      return window.EFB_API.loadCss(APP_CSS).catch(function (error) {
        console.warn('SimRateApp: loadCss failed for ' + APP_CSS, error);
        return undefined;
      });
    }

    _install(props) {
      if (this._isInstalled) {
        return Promise.reject('App already installed.');
      }
      this._isInstalled = true;
      this.bus = props.bus;
      this._unitsSettingsManager = props.unitsSettingManager;
      this._efbSettingsManager = props.efbSettingsManager;
      this._notificationManager = props.notificationManager;
      this._onboardingManager = props.onboardingManager;
      this._favoriteIndex = props.favoriteIndex === undefined ? -1 : props.favoriteIndex;
      this.options = props.options || {};

      const self = this;
      return Promise.resolve(this.install(props)).then(function () {
        self._isReady = true;
        Coherent.trigger(
          'EFB_APP_INSTALLED',
          self.name,
          self.internalName,
          EFB_API_VERSION,
          self.getVersion()
        );
      });
    }

    render() {
      return FSComponent.buildComponent(SimRateAppView, { bus: this.bus });
    }
  }

  window.EFB_API.use(SimRateApp);
})();
