import { keyLabel } from "../input/KeyboardMouseInput.js";
import { CONTROLS as BINDINGS } from "./level-config.js";

/** Alle Spieltexte an einer Stelle - bewusst auf Englisch, wie im Controller Game. */

const key = (action) => keyLabel(BINDINGS.actions[action][0]);
const E = key("action");
const SPACE = key("jump");
const X = key("explore");
const INFO = key("info");
const RESET = key("reset");

export const TITLE = {
  name: "Sensor Hunt",
  subtitle: "XENSIV\u2122 Mouse",
};

/**
 * Steuerung zeilenweise - wird als Tabelle im Banner gerendert.
 * `gamepad` ist die Notfall-Belegung fuer einen Controller (GAMEPAD_CONTROLS).
 */
export const CONTROLS = [
  { key: "W A S D", gamepad: "Left stick", action: "Move" },
  { key: "Mouse", gamepad: "Right stick", action: "Look around (click into the game first, or drag)" },
  { key: SPACE, gamepad: "F", action: "Jump" },
  { key: E, gamepad: "T", action: "Switch sides on IC9 / confirm" },
  { key: "Left \u00b7 Right click", gamepad: "L1 \u00b7 R1", action: "Mark a mouse button sensor" },
  {
    key: "Mouse wheel",
    gamepad: "L2 \u00b7 R2 \u00b7 L3/R3",
    action: "Mark a wheel sensor (scroll or click it)",
  },
  { key: INFO, gamepad: "D-Pad \u2193", action: "Open this info screen again" },
  {
    key: `${key("resetLeft")} + ${key("resetRight")} \u00b7 ${RESET}`,
    gamepad: "D-Pad \u2190 + \u2192",
    action: "Back to the intro",
  },
  { key: "Esc", action: "Release the mouse" },
];

export const BRIEFING = {
  title: "Sensor Hunt",
  body: [
    "This is the PCB of the XENSIV mouse. You have been shrunk down to the size of a component.",
    "Six magnetic sensors are mounted on this board. Find all six and mark them.",
    "Every sensor reads exactly one control of the mouse - left click, right click or the wheel. That is the input you have to use to mark it.",
    "Hold a mouse button down or turn the wheel and its sensors blink yellow - anywhere on the side you are currently standing on. That is how you track the right one down. Once marked, a sensor stops reacting.",
    "Four sensors sit on the front: two at the front corners under the mouse buttons, two hidden under the mouse wheel. Walk up to the wheel holder and it turns see-through.",
    `Hint: the other two are on the BACK of the PCB. Jump onto the big IC9 chip in the middle of the board and press ${E} to switch sides.`,
    "Every sensor is labelled in the silkscreen - look for the IC number next to the small chips.",
    "Stand next to a sensor to learn which XENSIV\u2122 part it is.",
    "Watch your step - if you walk over the edge or into one of the slots or drill holes, you fall off the board and the run is over.",
    "The clock runs while you play. Your five fastest runs are kept.",
  ],
  controls: CONTROLS,
  tabs: {
    info: { label: "Mission", key: key("tabInfo") },
    controls: { label: "Controls", key: key("tabControls") },
  },
  footer: `Press ${E} to close this screen \u00b7 press ${INFO} to open it again`,
  tone: "neutral",
};

/** Fusszeile des allerersten Briefings - nur dort laesst sich die Jagd ueberspringen. */
export const BRIEFING_START_FOOTER = `Press ${E} to start the hunt \u00b7 press ${X} to just explore the board`;

/**
 * Kurzfassung fuer den Start: nur das Wichtigste, hervorgehoben mit **...**.
 * Der ausfuehrliche Text (BRIEFING) erscheint, wenn man den Infobildschirm
 * im Spiel selbst wieder oeffnet.
 */
export const BRIEFING_START = {
  ...BRIEFING,
  body: [
    "You have been shrunk down onto the PCB of the XENSIV\u2122 mouse. **Find and mark all 6 magnetic sensors.**",
    "**Mark each sensor with the input it reads** - left click, right click or the mouse wheel. Hold or turn it and its sensors **blink yellow**.",
    `**4 sensors are on the front** (2 under the wheel), **2 on the BACK.** Jump onto **IC9 and press ${E}** to switch sides.`,
    "**Don't fall off the board** - the clock is running!",
    `Full mission details: press ${INFO} during the hunt.`,
  ],
  footer: BRIEFING_START_FOOTER,
};

export const VICTORY = {
  title: "All sensors found",
  body: [
    "You located and marked all six magnetic sensors of the mouse.",
    "These are the sensors that turn button clicks and wheel movement into measurable magnetic field changes.",
  ],
  footer: `Press ${E} to play again \u00b7 press ${X} to explore the board`,
  tone: "win",
};

export const EXPLORE = {
  title: "Explore mode",
  body: [
    "Take your time - there is no clock in this mode.",
    "Every Infineon part on the board is framed. Walk onto a frame to learn which part it is.",
    `Some of them sit on the BACK of the PCB - jump onto IC9 and press ${E} to switch sides.`,
    "Falling off is harmless here: you are simply put back on the board.",
  ],
  footer: `Press ${E} to start exploring \u00b7 press ${INFO} for the menu`,
  tone: "win",
};

/** Menue im Erkundungsmodus, wenn vorher keine Jagd gewonnen wurde. */
export const EXPLORE_MENU = {
  title: "Explore mode",
  body: ["Ready for the real thing? Start the sensor hunt - or keep looking around."],
  footer: `Press ${E} to start the hunt \u00b7 press ${X} to keep exploring`,
  tone: "neutral",
};

export const FAILURE = {
  title: "You fell off the board",
  body: ["There is nothing to stand on beyond the PCB edge. The run is over."],
  footer: `Press ${E} to restart`,
  tone: "fail",
};

export const RESET_CONFIRM = {
  title: "Back to the intro?",
  body: ["Your current run and everything you have discovered will be reset."],
  footer: `Press ${E} to go back to the intro \u00b7 press ${SPACE} to cancel`,
  tone: "fail",
};

/**
 * Info-Box der Schiebeschalter - erscheint, sobald die Figur am Schalter
 * steht. `positions` je Beschriftung der Hebelstellung (siehe SLIDE_SWITCHES
 * in level-config.js); die aktuelle Stellung wird hervorgehoben.
 */
export const SWITCH_INFO = {
  S3: {
    title: "Power switch",
    description: "Selects where the mouse gets its power from.",
    positions: {
      LiPo: "Runs on the LiPo battery.",
      "+5V": "Runs on +5V from USB - LED6 lights up.",
    },
    game: [
      "Switch to +5V and the mouse wheel assembly on the front disappears - IC6 and IC14 underneath are then easy to reach.",
      "Stand on the switch and walk against the lever to slide it.",
    ],
  },
};

/** Produktinfos je Sensorgruppe - Schluessel wie `info` in SENSORS / COMPONENTS. */
export const COMPONENT_INFO = {
  buttonTop: {
    title: "Mouse buttons (front)",
    used: { name: "XENSIV\u2122 TLI49901", type: "Linear Hall sensor" },
    alternatives: [],
  },
  buttonBottom: {
    title: "Mouse buttons (back)",
    used: { name: "XENSIV\u2122 TLI49012-E0001", type: "Hall angle sensor" },
    alternatives: [],
  },
  wheelIC6: {
    title: "Mouse wheel",
    used: { name: "XENSIV\u2122 TLV55624-1O", type: "TMR-based magnetic switch" },
    alternatives: [],
  },
  wheelIC14: {
    title: "Mouse wheel",
    used: { name: "XENSIV\u2122 TLE493D-W2B6", type: "Magnetic 3D Hall sensor" },
    alternatives: [],
  },
  tmr2d: {
    title: "2D magnetic sensing",
    used: { name: "XENSIV\u2122 TLV552D", type: "2D x/y TMR sensor" },
    alternatives: [],
  },
  usb: {
    title: "USB interface",
    used: { name: "CY7C65211-24LTXI", type: "USB-C controller" },
    alternatives: [],
  },
  ldo: {
    title: "Power supply",
    used: { name: "TLE42744GS V33", type: "3.3V LDO Voltage Regulator" },
    alternatives: [],
  },
  psoc: {
    title: "Main controller",
    used: { name: "CYBLE-416045-02", type: "PSoC\u2122 6 BLE/WiFi Module" },
    alternatives: [],
  },
};
