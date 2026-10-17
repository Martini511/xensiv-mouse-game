/**
 * ============================================================================
 *  Notfall-Steuerung per Gamepad (Gamepad API)
 * ============================================================================
 *
 * Gegenstueck zur Tastatur-/Maus-Notfallsteuerung im Controller Game: Das
 * Maus-Spiel wird mit Maus und Tastatur gespielt, ein Controller funktioniert
 * aber jederzeit parallel. KeyboardMouseInput mischt die Werte von hier ein.
 *
 * Wie im Controller Game:
 * - Kein Event-basiertes Update: Achsen und Tasten werden einmal pro Frame
 *   frisch ueber navigator.getGamepads() abgefragt (Chromium liefert
 *   eingefrorene Snapshots).
 * - Ein Controller taucht oft erst auf, nachdem einmal eine Taste gedrueckt
 *   wurde - "kein Controller" ist also ein normaler Startzustand.
 * - Standard-Mapping, Sticks mit radialer Deadzone, Tasten benannt statt
 *   ueber Indizes. Die Beschriftung folgt dem XENSIV Game Controller
 *   (A = F, Y = T, X = I, B = X).
 * - Geraetefilter: Die Gamepad API meldet auch Geraete, die keine richtigen
 *   Controller sind. Angenommen wird - wie in der Controller-Dashboard-
 *   Website - nur ein Geraet mit genau REQUIRED_BUTTONS Tasten und
 *   REQUIRED_AXES Achsen.
 */

const AXIS_LEFT_X = 0;
const AXIS_LEFT_Y = 1;
const AXIS_RIGHT_X = 2;
const AXIS_RIGHT_Y = 3;

/** Button-Indizes des Standard-Mappings. */
export const BUTTON_INDEX = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  SELECT: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
};

/** Beschriftung auf dem XENSIV Game Controller - weicht bei A, B, X, Y ab. */
export const BUTTON_LABELS = {
  A: "F",
  B: "X",
  X: "I",
  Y: "T",
  L1: "L1",
  R1: "R1",
  L2: "L2",
  R2: "R2",
  L3: "L3",
  R3: "R3",
  SELECT: "Select",
  START: "Start",
  DPAD_UP: "D-Pad \u2191",
  DPAD_DOWN: "D-Pad \u2193",
  DPAD_LEFT: "D-Pad \u2190",
  DPAD_RIGHT: "D-Pad \u2192",
};

/** L2 und R2 sind analoge Trigger und gelten ab diesem Wert als gedrueckt. */
const ANALOG_BUTTONS = new Set(["L2", "R2"]);
const TRIGGER_THRESHOLD = 0.5;

const BUTTON_NAMES = Object.keys(BUTTON_INDEX);

/** Geraeteprofil des XENSIV-Controllers - andere Geraete werden ignoriert. */
const REQUIRED_BUTTONS = 16;
const REQUIRED_AXES = 4;

const isSupportedGamepad = (pad) =>
  pad.buttons.length === REQUIRED_BUTTONS && pad.axes.length === REQUIRED_AXES;

export class GamepadManager {
  /** @param {{deadzone?: number}} options */
  constructor(options = {}) {
    this.deadzone = options.deadzone ?? 0.18;
    /** Index des aktuell genutzten Gamepads, null = keins. */
    this.activeIndex = null;

    this.state = {
      connected: false,
      id: null,
      /** Linker Stick: Bewegung. x: rechts positiv, y: unten positiv. */
      leftStick: { x: 0, y: 0 },
      /** Rechter Stick: Kamera. */
      rightStick: { x: 0, y: 0 },
      /** Alle Tasten nach Namen, jeweils mit pressed / justPressed / value. */
      buttons: Object.fromEntries(BUTTON_NAMES.map((name) => [name, createButtonState()])),
      /** Wurde der Controller in diesem Frame bedient (Stick ausgelenkt, Taste gehalten)? */
      used: false,
    };

    this._onConnected = this._onConnected.bind(this);
    this._onDisconnected = this._onDisconnected.bind(this);
  }

  start() {
    window.addEventListener("gamepadconnected", this._onConnected);
    window.addEventListener("gamepaddisconnected", this._onDisconnected);
    // Nach einem Reload feuert kein Event mehr - einmalig selbst nachsehen.
    this._pickFirstAvailableGamepad();
  }

  stop() {
    window.removeEventListener("gamepadconnected", this._onConnected);
    window.removeEventListener("gamepaddisconnected", this._onDisconnected);
  }

  /** Einmal pro Frame aufrufen (Polling). */
  update() {
    const gamepad = this._getActiveGamepad();
    const s = this.state;

    s.connected = Boolean(gamepad);
    s.id = gamepad?.id ?? null;
    applyRadialDeadzone(
      s.leftStick,
      gamepad?.axes[AXIS_LEFT_X] ?? 0,
      gamepad?.axes[AXIS_LEFT_Y] ?? 0,
      this.deadzone
    );
    applyRadialDeadzone(
      s.rightStick,
      gamepad?.axes[AXIS_RIGHT_X] ?? 0,
      gamepad?.axes[AXIS_RIGHT_Y] ?? 0,
      this.deadzone
    );

    let used = Boolean(s.leftStick.x || s.leftStick.y || s.rightStick.x || s.rightStick.y);
    for (const name of BUTTON_NAMES) {
      const pressed = updateButtonState(
        s.buttons[name],
        gamepad?.buttons[BUTTON_INDEX[name]],
        ANALOG_BUTTONS.has(name) ? TRIGGER_THRESHOLD : 0
      );
      if (pressed) used = true;
    }
    s.used = used;
    return s;
  }

  _onConnected(event) {
    const { index, id, mapping, axes, buttons } = event.gamepad;
    const supported = isSupportedGamepad(event.gamepad);
    console.log(
      `[Gamepad] ${supported ? "verbunden" : "ignoriert (kein unterstuetzter Controller)"} - ` +
        `Index ${index}: "${id}" ` +
        `(mapping: ${mapping || "unbekannt"}, ${axes.length} Achsen, ${buttons.length} Buttons)`
    );
    if (supported && this.activeIndex === null) this.activeIndex = index;
  }

  _onDisconnected(event) {
    const { index, id } = event.gamepad;
    console.log(`[Gamepad] getrennt - Index ${index}: "${id}"`);
    if (this.activeIndex === index) {
      this.activeIndex = null;
      // Evtl. haengt noch ein zweiter Controller am System.
      this._pickFirstAvailableGamepad();
    }
  }

  _pickFirstAvailableGamepad() {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of pads) {
      if (pad && pad.connected && isSupportedGamepad(pad)) {
        this.activeIndex = pad.index;
        return;
      }
    }
  }

  /** Immer frisch abfragen - gespeicherte Gamepad-Objekte sind eingefrorene Snapshots. */
  _getActiveGamepad() {
    if (!navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    if (this.activeIndex === null) this._pickFirstAvailableGamepad();
    if (this.activeIndex === null) return null;
    const pad = pads[this.activeIndex];
    // Unter dem Index kann inzwischen ein anderes Geraet haengen.
    if (!pad || !pad.connected || !isSupportedGamepad(pad)) {
      this.activeIndex = null;
      return null;
    }
    return pad;
  }
}

const createButtonState = () => ({
  /** true, solange der Button gehalten wird. */
  pressed: false,
  /** true nur in dem Frame, in dem der Button gedrueckt wurde. */
  justPressed: false,
  /** Analogwert 0..1 (relevant bei den Triggern). */
  value: 0,
});

/**
 * Digitale Buttons melden `pressed` selbst, Trigger liefern zusaetzlich einen
 * Analogwert - deshalb wird beides ausgewertet.
 */
function updateButtonState(target, button, threshold) {
  const value = button?.value ?? 0;
  const pressed = Boolean(button?.pressed) || value > threshold;
  target.justPressed = pressed && !target.pressed;
  target.pressed = pressed;
  target.value = value;
  return pressed;
}

/**
 * Radiale Deadzone: unterhalb des Schwellwerts wird der komplette Vektor auf 0
 * gesetzt, darueber linear auf 0..1 zurueckskaliert.
 */
function applyRadialDeadzone(out, x, y, deadzone) {
  const magnitude = Math.hypot(x, y);
  if (magnitude < deadzone) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  const scaled = (magnitude - deadzone) / (1 - deadzone);
  const normalized = Math.min(scaled, 1) / magnitude;
  out.x = x * normalized;
  out.y = y * normalized;
  return out;
}
