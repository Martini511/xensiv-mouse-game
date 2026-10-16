/**
 * ============================================================================
 *  Tastatur- und Maussteuerung
 * ============================================================================
 *
 * - Tasten werden ueber `event.code` abgefragt, also nach ihrer Position auf
 *   der Tastatur. WASD liegt damit auf QWERTZ und QWERTY gleich.
 * - Maustasten heissen "Mouse0" (links), "Mouse1" (Rad-Klick), "Mouse2"
 *   (rechts), Drehen am Mausrad heisst "Wheel". Sie lassen sich genauso wie
 *   Tasten an Aktionen binden.
 * - Gedrueckte Tasten werden zwischen zwei Frames gepuffert: auch ein Tipp,
 *   der kuerzer als ein Frame ist, kommt als `justPressed` an.
 * - Umsehen per Maus braucht Pointer Lock (Klick ins Spiel, Esc gibt die Maus
 *   wieder frei). Der Klick, der die Maus einfaengt, zaehlt nicht als Aktion -
 *   sonst wuerde er z.B. gleich einen Sensor markieren. Verweigert der Browser
 *   den Pointer Lock (z.B. eingebettete Browser-Views), dreht Ziehen mit
 *   gedrueckter linker Maustaste, und Klicks zaehlen sofort.
 *
 * update() liefert einmal pro Frame:
 *   move   : { x, y }  x = rechts (+1) / links (-1), y = vor (+1) / zurueck (-1)
 *   look   : { x, y }  Mausbewegung in Pixeln seit dem letzten Frame
 *   stick  : { x, y }  rechter Controller-Stick (-1..1) - dreht die Kamera
 *   wheel  : Mausrad-Raster seit dem letzten Frame (+ = zu sich hin / nach unten)
 *   actions: { [name]: { pressed, justPressed } } je Eintrag in `bindings.actions`
 *   lastDevice: "keyboard" | "gamepad" - womit zuletzt gespielt wurde
 *
 * Notfall-Steuerung: Ist ein GamepadManager angeschlossen, werden seine Werte
 * hier eingemischt - Sticks addiert, Tasten verodert. Maus/Tastatur und
 * Controller funktionieren gleichzeitig.
 */

/** Das Mausrad hat kein "losgelassen" - so lange gilt es nach einem Ruck als gehalten. */
const WHEEL_HOLD_MS = 250;

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export class KeyboardMouseInput {
  /**
   * @param {HTMLElement} element Zeichenflaeche - ein Klick darauf faengt die Maus
   * @param {{ move: object, actions: object }} bindings Tastencodes (siehe level-config.js)
   * @param {{ gamepad?: import("./GamepadManager.js").GamepadManager, gamepadBindings?: object }} [options]
   *   Notfall-Steuerung per Controller und ihre Belegung (GAMEPAD_CONTROLS).
   */
  constructor(element, bindings, options = {}) {
    this.element = element;
    this.bindings = bindings;
    this.gamepad = options.gamepad ?? null;
    this.gamepadBindings = options.gamepadBindings ?? null;

    this._held = new Set();
    this._tapped = new Set();
    this._lookX = 0;
    this._lookY = 0;
    this._dragging = false;
    this._wheelUntil = 0;
    this._wheelSteps = 0;
    /** Wurde seit dem letzten Frame Tastatur oder Maus benutzt? */
    this._activity = false;
    this._lastUpdate = 0;
    /** Wird false, sobald der Browser Pointer Lock verweigert (z.B. in eingebetteten Views). */
    this.lockAvailable = typeof element.requestPointerLock === "function";

    this.state = {
      move: { x: 0, y: 0 },
      look: { x: 0, y: 0 },
      stick: { x: 0, y: 0 },
      wheel: 0,
      actions: Object.fromEntries(
        Object.keys(bindings.actions).map((name) => [name, { pressed: false, justPressed: false }])
      ),
      pointerLocked: false,
      lockAvailable: this.lockAvailable,
      lastDevice: "keyboard",
      gamepadConnected: false,
      keys: [],
    };

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onMouseDown = this._onMouseDown.bind(this);
    this._onMouseUp = this._onMouseUp.bind(this);
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onWheel = this._onWheel.bind(this);
    this._onContextMenu = (event) => event.preventDefault();
    this._onLockChange = this._onLockChange.bind(this);
    this._onLockError = () => {
      this.lockAvailable = false;
    };
    this._reset = this._reset.bind(this);
  }

  start() {
    window.addEventListener("keydown", this._onKeyDown);
    window.addEventListener("keyup", this._onKeyUp);
    window.addEventListener("blur", this._reset);
    window.addEventListener("mousedown", this._onMouseDown);
    window.addEventListener("mouseup", this._onMouseUp);
    window.addEventListener("mousemove", this._onMouseMove);
    window.addEventListener("wheel", this._onWheel, { passive: false });
    window.addEventListener("contextmenu", this._onContextMenu);
    document.addEventListener("pointerlockchange", this._onLockChange);
    document.addEventListener("pointerlockerror", this._onLockError);
    this.gamepad?.start();
  }

  stop() {
    window.removeEventListener("keydown", this._onKeyDown);
    window.removeEventListener("keyup", this._onKeyUp);
    window.removeEventListener("blur", this._reset);
    window.removeEventListener("mousedown", this._onMouseDown);
    window.removeEventListener("mouseup", this._onMouseUp);
    window.removeEventListener("mousemove", this._onMouseMove);
    window.removeEventListener("wheel", this._onWheel);
    window.removeEventListener("contextmenu", this._onContextMenu);
    document.removeEventListener("pointerlockchange", this._onLockChange);
    document.removeEventListener("pointerlockerror", this._onLockError);
    if (this.pointerLocked) document.exitPointerLock();
    this.gamepad?.stop();
    this._reset();
  }

  get pointerLocked() {
    return document.pointerLockElement === this.element;
  }

  /** Einmal pro Frame aus der Game-Loop aufrufen. */
  update() {
    const s = this.state;
    const { move, actions } = this.bindings;

    if (performance.now() > this._wheelUntil) this._held.delete("Wheel");

    s.move.x = this._axis(move.right, move.left);
    s.move.y = this._axis(move.forward, move.backward);

    s.look.x = this._lookX;
    s.look.y = this._lookY;
    s.wheel = this._wheelSteps;
    this._wheelSteps = 0;
    this._lookX = 0;
    this._lookY = 0;

    for (const [name, codes] of Object.entries(actions)) {
      const state = s.actions[name];
      state.pressed = codes.some((code) => this._held.has(code));
      state.justPressed = codes.some((code) => this._tapped.has(code));
    }
    this._tapped.clear();

    s.stick.x = 0;
    s.stick.y = 0;
    const gamepadUsed = this._mergeGamepad();

    // Womit zuletzt gespielt wurde - steuert Hinweisbox und Tastennamen.
    if (this._activity) s.lastDevice = "keyboard";
    else if (gamepadUsed) s.lastDevice = "gamepad";
    this._activity = false;

    s.pointerLocked = this.pointerLocked;
    s.lockAvailable = this.lockAvailable;
    s.keys = [...this._held];
    return s;
  }

  /**
   * Mischt den Controller ein: Sticks addieren, Tasten verodern, Trigger drehen
   * das Mausrad. Gibt zurueck, ob der Controller in diesem Frame bedient wurde.
   */
  _mergeGamepad() {
    const now = performance.now();
    const deltaTime = this._lastUpdate ? clamp((now - this._lastUpdate) / 1000, 0, 0.1) : 0;
    this._lastUpdate = now;

    const s = this.state;
    const bindings = this.gamepadBindings;
    if (!this.gamepad || !bindings) return false;

    const pad = this.gamepad.update();
    s.gamepadConnected = pad.connected;
    if (!pad.connected) return false;

    // Stick-Y ist invertiert: oben = -1, hier aber vor = +1.
    s.move.x += pad.leftStick.x;
    s.move.y -= pad.leftStick.y;
    s.stick.x = pad.rightStick.x;
    s.stick.y = pad.rightStick.y;

    for (const [name, buttons] of Object.entries(bindings.actions)) {
      const state = s.actions[name];
      if (!state) continue;
      for (const button of buttons) {
        const padButton = pad.buttons[button];
        state.pressed ||= padButton.pressed;
        state.justPressed ||= padButton.justPressed;
      }
    }

    // Mausrad: R2 dreht zu sich hin (wie nach unten scrollen), L2 weg.
    const { up, down, stepsPerSecond } = bindings.wheelScroll;
    const deadzone = bindings.wheelTriggerDeadzone ?? 0;
    const trigger = (name) => {
      const value = pad.buttons[name].value;
      return value > deadzone ? (value - deadzone) / (1 - deadzone) : 0;
    };
    s.wheel += (trigger(down) - trigger(up)) * stepsPerSecond * deltaTime;

    return pad.used;
  }

  _axis(positive, negative) {
    const has = (codes) => codes.some((code) => this._held.has(code));
    return (has(positive) ? 1 : 0) - (has(negative) ? 1 : 0);
  }

  _press(code) {
    if (!this._held.has(code)) this._tapped.add(code);
    this._held.add(code);
    this._activity = true;
  }

  _onKeyDown(event) {
    if (!this._isBound(event.code)) return;
    // Leertaste, Tab & Co. sollen weder scrollen noch den Fokus verschieben.
    event.preventDefault();
    if (event.repeat) return;
    this._press(event.code);
  }

  _onKeyUp(event) {
    this._held.delete(event.code);
  }

  _onMouseDown(event) {
    if (event.target !== this.element && !this.pointerLocked) return;
    this._activity = true;
    // Mittlere Taste: sonst startet der Browser das Auto-Scrollen.
    if (event.button === 1) event.preventDefault();
    if (!this.pointerLocked && event.button === 0) this._dragging = true;

    if (!this.pointerLocked && this.lockAvailable) {
      // Dieser Klick faengt nur die Maus ein. Lehnt der Browser ab (eingebettete
      // Views, direkt nach Esc ...), zaehlen Klicks ab dann direkt.
      this.element.requestPointerLock()?.catch?.(this._onLockError);
      return;
    }

    this._press(`Mouse${event.button}`);
  }

  _onMouseUp(event) {
    this._held.delete(`Mouse${event.button}`);
    if (event.button === 0) this._dragging = false;
  }

  _onMouseMove(event) {
    if (!this.pointerLocked && !this._dragging) return;
    this._lookX += event.movementX;
    this._lookY += event.movementY;
    if (event.movementX || event.movementY) this._activity = true;
  }

  _onWheel(event) {
    if (event.target !== this.element && !this.pointerLocked) return;
    event.preventDefault();
    this._press("Wheel");
    this._wheelUntil = performance.now() + WHEEL_HOLD_MS;
    this._wheelSteps += wheelSteps(event);
  }

  _onLockChange() {
    this._dragging = false;
  }

  /** Fenster verliert den Fokus: keyup kommt dann nie an - sonst laeuft die Figur weiter. */
  _reset() {
    this._held.clear();
    this._tapped.clear();
    this._lookX = 0;
    this._lookY = 0;
    this._dragging = false;
    this._wheelUntil = 0;
    this._wheelSteps = 0;
  }

  _isBound(code) {
    const { move, actions } = this.bindings;
    return [...Object.values(move), ...Object.values(actions)].some((codes) => codes.includes(code));
  }
}

const LABELS = {
  Mouse0: "Left click",
  Mouse1: "Wheel click",
  Mouse2: "Right click",
  Wheel: "Mouse wheel",
  ArrowUp: "\u2191",
  ArrowDown: "\u2193",
  ArrowLeft: "\u2190",
  ArrowRight: "\u2192",
};

/** Anzeigename eines Tastencodes: "KeyE" -> "E", "Mouse0" -> "Left click". */
export function keyLabel(code) {
  return LABELS[code] ?? code.replace(/^Key/, "").replace(/^Digit/, "");
}

/**
 * Wheel-Event in Raster des Mausrads umrechnen. Browser melden je nach Geraet
 * Pixel (meist ~100 je Raster), Zeilen (~3) oder Seiten.
 */
function wheelSteps(event) {
  const scale =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 1 / 3 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? 1 : 1 / 100;
  return event.deltaY * scale;
}
