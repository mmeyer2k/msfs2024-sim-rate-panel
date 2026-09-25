'use strict';

const test = require('node:test');
const assert = require('node:assert');

const APP_PATH = require.resolve('../html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.js');

/** Loads the app file fresh, so each test sees its own globals. */
function loadApp() {
  delete require.cache[APP_PATH];
  return require(APP_PATH);
}

/**
 * A ref matching the real SDK's NodeReference: `instance` is a getter that
 * throws when nothing has been assigned yet, not a plain nullable property.
 * `getOrDefault()` is the null-safe accessor, and it is what the EFB OS (and,
 * after change 5, this app) actually uses.
 */
function createFakeRef() {
  let value = null;
  return {
    get instance() {
      if (value === null) {
        throw new Error('Instance was null.');
      }
      return value;
    },
    set instance(next) {
      value = next;
    },
    getOrDefault: () => value
  };
}

/** A minimal DOM element stub, just enough surface for the view to drive. */
function createFakeElement() {
  const classes = new Set();
  return {
    textContent: '',
    classList: {
      toggle(name, on) {
        if (on) {
          classes.add(name);
        } else {
          classes.delete(name);
        }
        return on;
      },
      contains: (name) => classes.has(name)
    },
    listeners: [],
    addEventListener(event, handler) {
      this.listeners.push({ event: event, handler: handler });
    },
    removeEventListener(event, handler) {
      this.listeners = this.listeners.filter(
        (entry) => !(entry.event === event && entry.handler === handler)
      );
    }
  };
}

/** The smallest fake sim that the registration path touches. */
function installFakeGlobals() {
  const registered = [];
  const built = [];
  const cssLoaded = [];
  const triggered = [];
  const simVarCalls = [];

  class DisplayComponent {
    constructor(props) {
      this.props = props;
    }
  }

  global.msfssdk = {
    DisplayComponent: DisplayComponent,
    Subject: { create: (value) => ({ value: value, get: () => value, set: () => undefined }) },
    FSComponent: {
      createRef: () => createFakeRef(),
      buildComponent: (type, props, ...children) => {
        const node = { type: type, props: props || {}, children: children.flat() };
        built.push(node);
        // The real buildComponent assigns the freshly created DOM node to
        // props.ref.instance synchronously, but only for intrinsic (string)
        // tags - a component class like SimRateAppView has no element of its
        // own to hand back.
        if (typeof type === 'string' && props && props.ref) {
          props.ref.instance = createFakeElement();
        }
        return node;
      }
    }
  };
  global.window = {
    EFB_API: {
      use: (app) => { registered.push(app); },
      loadCss: (uri) => { cssLoaded.push(uri); return Promise.resolve(); }
    }
  };
  global.Coherent = { trigger: (...args) => { triggered.push(args); } };
  global.SimVar = {
    GetSimVarValue: () => 1,
    SetSimVarValue: (name) => {
      simVarCalls.push(name);
      return Promise.resolve();
    }
  };

  return {
    registered: registered,
    built: built,
    cssLoaded: cssLoaded,
    triggered: triggered,
    simVarCalls: simVarCalls
  };
}

function clearFakeGlobals() {
  delete global.msfssdk;
  delete global.window;
  delete global.Coherent;
  delete global.SimVar;
}

test('loading without the sim exports the logic and registers nothing', (t) => {
  clearFakeGlobals();
  const logic = loadApp();
  assert.strictEqual(typeof logic.createController, 'function');
  assert.strictEqual(typeof global.window, 'undefined');
});

test('loading inside the EFB registers exactly one app', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  loadApp();
  assert.strictEqual(fake.registered.length, 1);
});

test('the registered app advertises the right name, icon and version', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  loadApp();
  const app = new fake.registered[0]();
  assert.strictEqual(app.internalName, 'SimRateApp');
  assert.ok(!/\s/.test(app.internalName), 'internalName must not contain whitespace');
  assert.strictEqual(app.name, 'Sim Rate');
  assert.match(app.icon, /^coui:\/\/html_ui\/efb_ui\/efb_apps\/SimRateApp\/Assets\/Icons\/SimRate\.svg$/);
  assert.strictEqual(app.getVersion(), '1.0.0');
  assert.strictEqual(app.BootMode, 0);
  assert.strictEqual(app.SuspendMode, 0);
  assert.strictEqual(app.compatibleAircraftModels, undefined);
});

test('_install loads the stylesheet and announces itself', async (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  loadApp();
  const app = new fake.registered[0]();
  await app._install({ bus: {}, options: {} });
  assert.deepStrictEqual(fake.cssLoaded, [
    'coui://html_ui/efb_ui/efb_apps/SimRateApp/SimRateApp.css'
  ]);
  assert.strictEqual(fake.triggered[0][0], 'EFB_APP_INSTALLED');
  assert.strictEqual(app.isReady, true);
});

test('_install refuses to run twice', async (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  loadApp();
  const app = new fake.registered[0]();
  await app._install({ bus: {}, options: {} });
  await assert.rejects(() => app._install({ bus: {}, options: {} }));
});

test('the view renders a readout, eight presets and a reset', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  const logic = loadApp();
  const app = new fake.registered[0]();
  const appNode = app.render();

  const View = appNode.type;
  const view = new View({});
  const tree = view.render();

  const flatten = (node, out) => {
    out.push(node);
    (node.children || []).forEach((child) => {
      if (child && child.props) {
        flatten(child, out);
      }
    });
    return out;
  };
  const nodes = flatten(tree, []);
  const classOf = (node) => (node.props && node.props.class) || '';

  assert.strictEqual(classOf(tree), 'sim-rate-app');
  assert.strictEqual(nodes.filter((n) => classOf(n) === 'sim-rate-preset').length, 8);
  assert.strictEqual(nodes.filter((n) => classOf(n) === 'sim-rate-reset').length, 1);
  assert.strictEqual(nodes.filter((n) => classOf(n) === 'sim-rate-value').length, 1);
  assert.strictEqual(nodes.filter((n) => classOf(n) === 'sim-rate-status').length, 1);

  const presetLabels = nodes
    .filter((n) => classOf(n) === 'sim-rate-preset')
    .map((n) => n.children[0]);
  assert.deepStrictEqual(presetLabels, logic.LADDER.map(logic.formatRate));
});

/** Builds a view with its refs populated, the way the sim would before use. */
function buildView(fake) {
  loadApp();
  const app = new fake.registered[0]();
  const View = app.render().type;
  const view = new View({});
  view.render();
  return view;
}

test('clicking a preset aims the controller, observable on the next tick', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  const view = buildView(fake);
  view.onAfterRender();

  const button = view.buttonRefs[5].getOrDefault(); // 8x
  const click = button.listeners.find((entry) => entry.event === 'click');
  assert.ok(click, 'no click listener was registered on preset index 5');
  click.handler();

  // The default fake SimVar reports 1x, below the 8x the click aimed at, so
  // the very next tick should step up.
  view.onUpdate(16);
  assert.deepStrictEqual(fake.simVarCalls, ['K:SIM_RATE_INCR']);
});

test('the update loop writes the readout and active preset, and dedupes NaN', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  const view = buildView(fake);

  let rate = 4; // exactly 4x
  global.SimVar.GetSimVarValue = () => rate;

  view.onUpdate(16);
  assert.strictEqual(view.readoutRef.getOrDefault().textContent, '4×');
  view.buttonRefs.forEach((ref, index) => {
    assert.strictEqual(ref.getOrDefault().classList.contains('active'), index === 4);
  });

  rate = NaN;
  view.onUpdate(32);
  const readout = view.readoutRef.getOrDefault();
  assert.strictEqual(readout.textContent, '—');

  // Mark the DOM so a re-write on the following identical tick would show up.
  readout.textContent = 'sentinel';
  view.onUpdate(48);
  assert.strictEqual(readout.textContent, 'sentinel', 'draw() rewrote an unchanged NaN rate');
});

test('destroy() unhooks its listeners and tolerates never having rendered', (t) => {
  const fake = installFakeGlobals();
  t.after(clearFakeGlobals);
  const view = buildView(fake);
  view.onAfterRender();

  const button = view.buttonRefs[0].getOrDefault();
  const reset = view.resetRef.getOrDefault();
  assert.strictEqual(button.listeners.length, 1);
  assert.strictEqual(reset.listeners.length, 1);

  view.destroy();
  assert.strictEqual(button.listeners.length, 0);
  assert.strictEqual(reset.listeners.length, 0);

  const App = fake.registered[0];
  const bareView = new (new App().render().type)({});
  assert.doesNotThrow(() => bareView.destroy());
});
