import * as THREE from "three";

/**
 * ============================================================================
 *  Level-Konfiguration (XENSIV-Maus)
 * ============================================================================
 *
 * ALLE Werte hier stehen in MODELL-KOORDINATEN, also exakt so, wie sie in der
 * Konsolen-Analyse (siehe model-loader.js -> analyzeHierarchy) ausgegeben
 * werden:
 *
 *   - Einheit: Millimeter
 *   - Achsen:  CAD-Konvention, Z = oben (das GLB ist Z-up)
 *              X = Platinen-Breite, Y = Platinen-Laenge, Z = Hoehe
 *
 * Messwerte der XENSIV_Mouse.glb:
 *   Platinensubstrat : x 2.10 .. 47.11 | y 4.55 .. 102.41 | z 0.00 .. 1.55
 *   Oberseiten-Kupfer: z = 1.60      Unterseiten-Kupfer: z = -0.05
 *   Bauteile Oberseite : z bis +7.2 (die Steckverbinder P1/P2 bei y 25.6 .. 33.6)
 *   Bauteile Unterseite: z bis -5.6
 *   USB-Buchse an der Kante: y 96 .. 103, ragt durch beide Seiten
 */

/**
 * Weltunits pro Modell-Unit. Das GLB liegt in Metern vor; bei 400 ist die
 * Platine 18 x 39 Units gross - gleicher Massstab wie im Controller Game.
 */
export const SCALE_FACTOR = 400;

/** Millimeter -> Weltunits. */
const MM = SCALE_FACTOR / 1000;

/** Millimeter -> Weltunits, auch ausserhalb dieses Moduls nutzbar. */
export const WORLD_PER_MM = MM;

/**
 * Die Platine liegt im CAD nicht im Ursprung. Sie wird auf diese Mitte
 * verschoben, damit Kamera, Licht und das Kippen fuer die Unterseite um die
 * Platinenmitte arbeiten.
 */
export const BOARD_CENTER_MM = { x: 24.605, y: 53.48 };

/** Ab welcher Hoehe ueber der Laufflaeche ein Bauteil blockiert (mm). */
export const OBSTACLE_HEIGHT_MM = 2.2;

/**
 * Lichte Hoehe des Charakters in Weltunits (0.6 = 1.5 mm). Bauteile, die
 * komplett darueber schweben, blockieren nicht.
 */
export const CHARACTER_HEIGHT = 0.6;

/** CAD-Modell ist Z-up, Three.js ist Y-up: -90 Grad um X. */
export const MODEL_ROTATION_X = -Math.PI / 2;

/**
 * Rechnet CAD-Koordinaten (mm, Z-up) in Weltkoordinaten (Units, Y-up) um.
 *
 *   side "top"    : world = ( x', z, -y') * MM
 *   side "bottom" : world = (-x', -z, -y') * MM   (180 Grad um Z gekippt)
 *
 * x' und y' sind relativ zu BOARD_CENTER_MM.
 */
export function modelMmToWorld(xMm, yMm, zMm, side = "top", target = new THREE.Vector3()) {
  const x = xMm - BOARD_CENTER_MM.x;
  const y = yMm - BOARD_CENTER_MM.y;
  return side === "bottom"
    ? target.set(-x * MM, -zMm * MM, -y * MM)
    : target.set(x * MM, zMm * MM, -y * MM);
}

/** Rotation der Platine um die Welt-Z-Achse je Seite. */
export const SIDE_FLIP_Z = { top: 0, bottom: Math.PI };

/** Platinen-Referenzhoehen in mm. */
export const BOARD = {
  topSurfaceZ: 1.6,
  bottomSurfaceZ: -0.05,
  /** Trennebene zwischen Ober- und Unterseite (Mitte des Substrats). */
  midZ: 0.775,
};

/** Begehbare Ebenen - `walkZ` ist die Hoehe (mm), auf der der Charakter steht. */
export const LEVELS = {
  top: { walkZ: BOARD.topSurfaceZ },
  bottom: { walkZ: BOARD.bottomSurfaceZ },
};

/**
 * Maximale Hoehe ueber der Laufflaeche (mm), die noch als begehbarer
 * Untergrund gilt. Die Steckverbinder P1/P2 (5.6 mm), das Dach der
 * Mausrad-Halterung (8.05 mm) und die Achse darin (9.24 mm) zaehlen dazu,
 * das Mausrad selbst (bis 20 mm) nicht.
 */
export const MAX_GROUND_HEIGHT_MM = 10;

/** Faellt der Charakter unter diese Tiefe (Weltunits), wird er zurueckgesetzt. */
export const FALL_DEATH_Y = -25;

/** Wie weit die Figur unter ihre Laufebene sacken darf, bevor sie verloren ist. */
export const FALL_COMMIT_MM = 2;

/**
 * Startposition in CAD-XY (mm): auf der USB-C-Buchse vorne an der Platine.
 * Die Buchse ist mittig eingelassen (Mid-Mount) und schliesst oben bei
 * 1.54 mm ab - fast buendig mit der Platine, ihre Oberseite ist begehbar
 * (x 18.7 .. 30.3, y 96.9 .. 103.2).
 */
export const SPAWN_MM = { x: 24.6, y: 100 };

/**
 * Blickrichtung beim Start (Grad, Kamera-Yaw): 180 = Kamera vorne vor der
 * Buchse, die Figur schaut in die Platine hinein - sonst blickte man ueber
 * die Vorderkante ins Leere.
 */
export const SPAWN_CAMERA_YAW_DEG = 180;

/**
 * Seitenwechsel auf IC9 - wie die Kontrollflaeche im Controller Game.
 *
 * `top` / `bottom` : Mittelpunkt der Triggerzone bzw. Zielposition in CAD-XY.
 * `radiusMm`       : Radius der Triggerzone (XY-Abstand, Hoehe wird ignoriert).
 *
 * IC9 ist 14 x 11 mm gross (x 17.75 .. 31.75, y 52.25 .. 63.25) und fuer die
 * Figur eine Wand. Mit 4.5 mm Radius liegt die Zone daher komplett auf der
 * Oberseite des Chips - von der Platine aus kommt man nicht hinein.
 * Auf der Unterseite liegt die Zone direkt gegenueber auf freier Flaeche.
 */
export const PORTAL = {
  radiusMm: 4.5,
  top: { x: 24.75, y: 57.75 },
  bottom: { x: 24.75, y: 57.75 },
  /** Dauer des Fade-to-Black in Millisekunden (Hin- und Rueckblende). */
  fadeDurationMs: 400,
};

/**
 * Tastenbelegung (KeyboardEvent.code, also nach Tastenposition - gilt auf
 * QWERTZ wie QWERTY). Maustasten heissen Mouse0 (links), Mouse1 (Rad-Klick)
 * und Mouse2 (rechts), Drehen am Rad heisst Wheel. Umsehen geht mit der Maus.
 *
 * Die Aktionen entsprechen den Controller-Tasten im Controller Game:
 *   action  = T (Seitenwechsel, Bildschirme bestaetigen)
 *   jump    = F (Sprung, Abbrechen)
 *   explore = I, info = D-Pad unten
 *   resetLeft + resetRight = D-Pad links + rechts gleichzeitig (zurueck zum
 *   Intro, mit Rueckfrage); reset = Rueckschritt als Einzeltaste dafuer
 *   tabInfo / tabControls = D-Pad hoch / runter im Infobildschirm
 */
export const CONTROLS = {
  move: {
    forward: ["KeyW"],
    backward: ["KeyS"],
    left: ["KeyA"],
    right: ["KeyD"],
  },
  actions: {
    action: ["KeyE"],
    jump: ["Space"],
    explore: ["KeyX"],
    info: ["Tab"],
    reset: ["Backspace"],
    resetLeft: ["ArrowLeft"],
    resetRight: ["ArrowRight"],
    tabInfo: ["ArrowUp"],
    tabControls: ["ArrowDown"],
    // Eingaben, die die Sensoren der Maus abtasten
    leftClick: ["Mouse0"],
    rightClick: ["Mouse2"],
    wheel: ["Wheel", "Mouse1"],
    // Nur der Klick aufs Mausrad - drueckt das Rad im Spiel nach unten.
    wheelClick: ["Mouse1"],
  },
};

/** Maus-Empfindlichkeit: Drehung in Radiant pro Pixel Mausbewegung. */
export const MOUSE_SENSITIVITY = 0.0025;

/**
 * Notfall-Steuerung per Controller (Gegenstueck zur Tastatur-Notfallsteuerung
 * im Controller Game). Laeuft immer parallel zu Maus und Tastatur.
 *
 * Linker Stick laeuft, rechter Stick dreht die Kamera. Die Aktionen nutzen
 * dieselben Namen wie CONTROLS.actions, die Tasten die Namen aus
 * GamepadManager.js (Beschriftung des XENSIV Game Controllers: A = F,
 * Y = T, X = I). Die Mausbedienung liegt auf Schultern und Triggern:
 *   L1 / R1 = linke / rechte Maustaste
 *   L2 / R2 = Mausrad hoch / runter (analog - je tiefer, desto schneller)
 *   L3 / R3 = Klick aufs Mausrad (Stick druecken)
 */
export const GAMEPAD_CONTROLS = {
  actions: {
    action: ["Y"],
    jump: ["A"],
    explore: ["X"],
    info: ["DPAD_DOWN"],
    reset: [],
    resetLeft: ["DPAD_LEFT"],
    resetRight: ["DPAD_RIGHT"],
    tabInfo: ["DPAD_UP"],
    tabControls: ["DPAD_DOWN"],
    leftClick: ["L1"],
    rightClick: ["R1"],
    wheel: ["L2", "R2", "L3", "R3"],
    wheelClick: ["L3", "R3"],
  },
  /** Trigger, die das Mausrad drehen, und Raster pro Sekunde bei Vollausschlag. */
  wheelScroll: { up: "L2", down: "R2", stepsPerSecond: 8 },
  /** Ab diesem Triggerwert dreht das Rad - unterhalb ruht der Finger nur darauf. */
  wheelTriggerDeadzone: 0.1,
  /** Kamera-Drehung mit dem rechten Stick in Radiant pro Sekunde bei Vollausschlag. */
  cameraSpeed: 2.6,
  deadzone: 0.18,
};

export const OPPOSITE_SIDE = { top: "bottom", bottom: "top" };

/**
 * Spielziel: die sechs Magnetsensoren der Maus. Vier sitzen auf der
 * Oberseite, zwei auf der Unterseite. Koordinaten = Bauteilmitte aus der GLB
 * (CAD-XY in mm).
 *
 * `input`    : Aktion aus CONTROLS.actions, die der Sensor in der echten Maus
 *              abtastet - genau die markiert ihn.
 * `markerMm` : Kantenlaenge des Markierungsrahmens. IC6 und IC14 liegen nur
 *              2.5 mm auseinander, ihre Rahmen sind deshalb kleiner.
 * `radiusMm` : optional - eigene Markier-Reichweite statt SENSOR_RADIUS_MM.
 */
export const SENSORS = [
  // Oberseite: vorne auf den beiden Tastenzungen ...
  { id: "IC7", side: "top", input: "leftClick", info: "buttonTop", x: 5.6, y: 93.7, markerMm: 3.4 },
  { id: "IC8", side: "top", input: "rightClick", info: "buttonTop", x: 43.6, y: 93.7, markerMm: 3.4 },
  // ... und direkt hinter dem Ausschnitt fuer das Mausrad - unter dessen
  // Halterung bzw. Radkranz. Erreichbar nur von vor der Halterung, IC6
  // deshalb mit etwas mehr Reichweite.
  { id: "IC6", side: "top", input: "wheel", info: "wheelIC6", x: 24.73, y: 73.9, markerMm: 1.8, radiusMm: 6 },
  { id: "IC14", side: "top", input: "wheel", info: "wheelIC14", x: 24.7, y: 71.4, markerMm: 3.0 },
  // Unterseite: unter den Tastenzungen
  { id: "IC4", side: "bottom", input: "leftClick", info: "buttonBottom", x: 44.1, y: 67.1, markerMm: 3.6 },
  { id: "IC13", side: "bottom", input: "rightClick", info: "buttonBottom", x: 5.1, y: 67.1, markerMm: 3.6 },
];

/** Anzeigename der Sensor-Eingaben in HUD und Info-Box. */
export const INPUT_LABELS = {
  leftClick: "Left click",
  rightClick: "Right click",
  wheel: "Mouse wheel",
};

/** Wie nah man rankommen muss, um markieren zu koennen (mm). */
export const SENSOR_RADIUS_MM = 5;

/**
 * Die beiden Taster auf der Unterseite (Siebdruck "XRES" und "PROG").
 * Springt oder steht der Chip auf der Kappe, wird sie eingedrueckt.
 * Koordinaten = Mitte des Tasters in CAD-XY (mm).
 */
export const PUSH_BUTTONS = [
  { id: "S1", label: "XRES", side: "bottom", x: 29.6, y: 28.6 },
  { id: "S2", label: "PROG", side: "bottom", x: 19.6, y: 28.6 },
];

/**
 * Hub der Tasterkappe (mm). Echte Taster haben ~0.25 mm - etwas mehr, damit
 * man es im Spiel sieht. Die Kappe ragt 0.95 mm ueber das Gehaeuse.
 */
export const PUSH_BUTTON_TRAVEL_MM = 0.6;

/**
 * Erkennung der Kappe im Modell. Bei der Maus sind Gehaeuse und Kappe ein
 * einziges Mesh (2.53 mm hoch): alle Dreiecke, die ueber `gap` mm hinaus
 * ragen, sind Kappe. Der Gehaeusedeckel liegt bei 1.59 mm, die vier
 * Abstandshalter an den Ecken reichen bis 1.9 mm und bleiben stehen - die
 * ovale Kappe ragt bis 2.53 mm. `top`: so weit muss das Mesh mindestens
 * herausragen, damit es ueberhaupt als Taster gilt.
 */
export const PUSH_BUTTON_CAP_MM = { gap: 2.0, top: 2.2 };

/**
 * Schiebeschalter auf der Unterseite (S3, Siebdruck "LiPo" / "+5V").
 * Steht der Chip auf dem Schaltergehaeuse und laeuft gegen den Hebel, rutscht
 * der Hebel ans andere Ende des Schlitzes und bleibt dort.
 *
 * `x`, `y`    : Mitte des Schalters in CAD-XY (mm) - daran wird das Mesh erkannt.
 * `leverMm`   : Alles, was weiter als das ueber die Platine ragt, ist Hebel
 *               (Abdeckung endet bei 3.55 mm, Hebel ragt bis 5.55 mm).
 * `slotMm`    : Schlitz in CAD-x (mm), in dem der Hebel laeuft.
 * `labels`    : Beschriftung der Hebelstellung am linken (min) bzw. rechten
 *               (max) Schlitzende in CAD-x.
 * `infoRadiusMm`: So nah (XY-Abstand zur Schaltermitte, mm) muss die Figur
 *               kommen, damit die Info-Box zum Schalter erscheint (Texte:
 *               SWITCH_INFO in mission-texts.js).
 */
export const SLIDE_SWITCHES = [
  {
    id: "S3",
    side: "bottom",
    x: 10.6,
    y: 50.6,
    leverMm: 3.6,
    slotMm: { min: 8.69, max: 12.55 },
    labels: { min: "+5V", max: "LiPo" },
    infoRadiusMm: 7,
  },
];

/** Wie schnell der Hebel durch den Schlitz rutscht (mm/s). */
export const SLIDE_SWITCH_SPEED_MM = 14;

/**
 * Status-LEDs auf der Unterseite, die auf Taster und Schiebeschalter
 * reagieren. Koordinaten = Mitte der LED in CAD-XY (mm).
 *
 * `button`   : leuchtet, solange dieser Taster eingedrueckt ist
 * `slide`    : leuchtet, solange dieser Schiebeschalter in `position` steht
 */
export const STATUS_LEDS = [
  { id: "LED5", side: "bottom", x: 11.6, y: 28.6, button: "S2" },
  { id: "LED8", side: "bottom", x: 37.6, y: 28.6, button: "S1" },
  { id: "LED6", side: "bottom", x: 15.6, y: 58.6, slide: "S3", position: "+5V" },
];

/** Leuchtfarbe der Status-LEDs - gruen wie D2..D4 auf der Platine. */
export const STATUS_LED_COLOR = 0x2bff4f;

/** CAD-Material der LED-Linse; nur sie leuchtet, Gehaeuse und Pads nicht. */
export const STATUS_LED_LENS_MATERIAL = "M217184184";

/**
 * Mausrad-Baugruppe (XENSIV_Mouse_with_wheel.glb).
 *
 * `pcbNode`   : Unterbaugruppe der Platine - ihre Lage wird beim Laden
 *               rueckgaengig gemacht (siehe alignToPcb in model-loader.js).
 * `assembly`  : Unterbaugruppe des Mausrads.
 * `rotating`  : Teile, die sich mitdrehen (Rad, Nabe, Achse); der Rest -
 *               die Halterung - steht fest.
 * `axisMm`    : Drehachse (parallel zu CAD-x) durch y/z in mm.
 * `degreesPerStep` : Drehung je Raster des echten Mausrads (Mausrad-Event).
 */
export const MOUSE_WHEEL = {
  id: "MOUSEWHEEL",
  /** Eigene Kennung fuer die drehenden Teile - blenden getrennt aus. */
  rotorId: "MOUSEWHEEL_ROTOR",
  pcbNode: "XENSIV_Mouse1",
  assembly: "Wheel_Assembly1",
  rotating: ["wheel_cover_1055_11", "wheel_1055_11", "axis_22051"],
  /**
   * Drehende Teile, die trotzdem begehbar sind: die runde Achse liegt oben im
   * Schlitz der Halterung - ohne sie fiele man dort ins Langloch. Ihre Form
   * aendert sich beim Drehen nicht.
   */
  walkableRotating: ["axis_22051"],
  /**
   * Zeichenreihenfolge der drehenden Teile von innen nach aussen. Ihre
   * Geometrie ist eingebacken, alle liegen im selben Ursprung - beim
   * Durchscheinen koennte Three.js sie sonst nicht nach Tiefe sortieren, und
   * der Magnet erschiene ueber dem Radkranz.
   */
  rotorDrawOrder: ["axis_22051", "wheel_1055_11", "wheel_cover_1055_11"],
  axisMm: { y: 84.4, z: 8.35 },
  degreesPerStep: 15,
  /** Wie schnell das Rad der Eingabe nachdreht (1/Sekunde). */
  followRate: 18,
  /**
   * Mausrad-Klick: Rad, Nabe und Achse gleiten im Langloch der Halterung um
   * diesen Hub (mm) nach unten - Wert aus dem CAD der Maus.
   */
  clickTravelMm: 1.592,
  /**
   * IC6 und IC14 liegen unter Halterung und Radkranz. Kommt die Figur einem
   * der beiden so nah (mm), wird die Baugruppe durchscheinend, und die Kamera
   * ignoriert sie.
   */
  revealSensors: ["IC6", "IC14"],
  revealRadiusMm: 9,
  revealOpacity: 0.22,
  /**
   * Nur unten auf der Platine (bzw. auf flachen Bauteilen) - wer oben auf der
   * Halterung steht, soll nicht auf etwas Durchsichtigem laufen.
   */
  revealMaxHeightMm: 4,
  /**
   * Steht das Rad zwischen Figur und Kamera, wird es so durchscheinend,
   * statt die Kamera an die Figur heranzuziehen.
   */
  occludeOpacity: 0.3,
  /**
   * Steht dieser Schiebeschalter in `position` (und ist dort angekommen),
   * blendet die ganze Mausrad-Baugruppe aus - samt Kollision und begehbarer
   * Halterung. Zurueckgeschaltet erscheint sie wieder.
   */
  hiddenBySwitch: { slide: "S3", position: "+5V" },
  /** Wie schnell die Baugruppe dabei aus- bzw. einblendet (1/Sekunde). */
  hideFadeRate: 4,
  /**
   * Aussehen je Teil (Name der Unterbaugruppe). Im CAD sind alle Teile
   * gleich grau - hier: Gummi-Rad, Stahlachse, Halterung in hellem Kunststoff
   * wie die Steckverbinder.
   *
   * Der hohle Zylinder in der Radmitte ist der Magnet, den IC6/IC14 abtasten.
   * Er ist diametral polarisiert: eine Haelfte quer zur Achse Nordpol (rot),
   * die andere Suedpol (gruen). `magnet.splitDeg` dreht die Trennebene in
   * Ruhelage (0 = waagrecht, Nordpol oben).
   */
  looks: {
    wheel_cover_1055_11: { color: 0x2c2e33, roughness: 0.85, metalness: 0 },
    wheel_1055_11: {
      magnet: { north: 0xd7192d, south: 0x2f9e4f, splitDeg: 0 },
      roughness: 0.45,
      metalness: 0.25,
    },
    axis_22051: { color: 0xb9bec6, roughness: 0.3, metalness: 0.75 },
    axis_holder_51: { color: 0xdcdee2, roughness: 0.7, metalness: 0 },
  },
};

/**
 * Bauteile mit begehbarem Innenraum. Statt einer einzigen Hindernis-Box ueber
 * den ganzen Grundriss bekommen sie eine feine Kollision aus der echten
 * Geometrie - Waende, Boden, Kontakte und Dach einzeln. So kann der Chip in
 * die Steckverbinder P1/P2 hineinlaufen (gleiches Bauteil wie J3 im Controller
 * Game, Oeffnung jeweils zur Platinenkante).
 *
 * Rechteck in CAD-XY (mm): alle Meshes, die komplett darin liegen, gehoeren
 * zum Bauteil.
 */
export const ENTERABLE_PARTS = [
  { id: "P1", side: "top", minX: 4.2, maxX: 14, minY: 25.2, maxY: 34 },
  { id: "P2", side: "top", minX: 35.2, maxX: 45, minY: 25.2, maxY: 34 },
];

/** Rasterweite (mm), mit der die Geometrie begehbarer Bauteile abgetastet wird. */
export const ENTERABLE_CELL_MM = 0.25;

/**
 * Mindesthoehe ueber der Platine (mm), ab der ein Mesh zum begehbaren Bauteil
 * gehoert. Die Loetpads darunter (0.04 mm) bleiben normale Platinenteile.
 */
export const ENTERABLE_MIN_HEIGHT_MM = 0.3;

/** Sensor-Daten in Weltkoordinaten, jeweils auf Hoehe ihrer Ebene. */
export function buildSensors() {
  return SENSORS.map((sensor) => ({
    ...sensor,
    button: INPUT_LABELS[sensor.input],
    radius: (sensor.radiusMm ?? SENSOR_RADIUS_MM) * MM,
    position: modelMmToWorld(sensor.x, sensor.y, LEVELS[sensor.side].walkZ, sensor.side),
  }));
}

/**
 * Weitere Infineon-Bauteile fuer den Erkundungsmodus (CAD-XY in mm).
 * `sizeMm` ist die Rahmengroesse, `radiusMm` die Reichweite der Info-Box.
 */
export const COMPONENTS = [
  { id: "IC2", side: "top", info: "ldo", x: 16.0, y: 40.3, sizeMm: 9, radiusMm: 5.5 },
  { id: "IC5", side: "bottom", info: "tmr2d", x: 5.1, y: 91.6, sizeMm: 4, radiusMm: 3.5 },
  { id: "U1", side: "bottom", info: "usb", x: 35.6, y: 90.5, sizeMm: 5.5, radiusMm: 4.5 },
  { id: "MD1", side: "bottom", info: "psoc", x: 24.6, y: 14.6, sizeMm: 20, radiusMm: 10 },
];

/** Bauteil-Daten in Weltkoordinaten. */
export function buildComponents() {
  return COMPONENTS.map((part) => ({
    ...part,
    radius: part.radiusMm * MM,
    position: modelMmToWorld(part.x, part.y, LEVELS[part.side].walkZ, part.side),
  }));
}

/**
 * Farbkorrekturen, damit Platine und Bauteile zum Controller Game passen.
 *
 * `name` ist der CAD-Materialname aus der GLB ("M" + RGB, z. B. M00160 =
 * RGB 0/0/160), `color` die sRGB-Farbe des passenden Bauteils auf der
 * Controller-Platine. `opacity` < 1 macht das Material transparent, 1 opak.
 */
export const MATERIAL_OVERRIDES = [
  // Platine: opaker schwarzer Loetstopplack + schwarzes Substrat. Der
  // Bestueckungsdruck liegt koplanar auf dem Lack und wird wie beim Controller
  // halbtransparent gezeichnet, damit er nach dem Lack gerendert wird.
  { name: "M525252", color: 0x000000, opacity: 1 },
  { name: "M149149149", color: 0x000000 },
  { name: "M251251251", color: 0xffffff, opacity: 0.55 },
  // Loetpads: silbern wie beim Controller statt gold.
  { name: "M2182050", color: 0xbcbcbc },

  // Stecker P1/P2 (baugleich mit dem Stecker auf der Controller-Unterseite).
  { name: "M00160", color: 0xf5f5f5 },
  // Keramikkondensatoren.
  { name: "M170170127", color: 0x8e7e49 },
  // LED-Linsen: opak wie die RGB-LED auf dem Controller statt rosa-transparent.
  { name: "M217184184", color: 0xcad1ee, opacity: 1 },
];

/** Trennhoehe zwischen Ober- und Unterseite in Weltkoordinaten (ungekippt). */
export const BOARD_MID_Y = BOARD.midZ * MM;

/** Baut die Weltkoordinaten-Variante einer Ebene (beruecksichtigt die Kippung). */
export function buildLevel(side) {
  return {
    side,
    /** Y-Hoehe in Weltunits, auf der der Charakter steht. */
    y: modelMmToWorld(0, 0, LEVELS[side].walkZ, side).y,
  };
}

/** Startposition des Charakters auf der angegebenen Ebene, in Weltkoordinaten. */
export function buildSpawn(side) {
  return modelMmToWorld(SPAWN_MM.x, SPAWN_MM.y, LEVELS[side].walkZ, side);
}

/** Portal-Daten in Weltkoordinaten, jeweils auf Hoehe der zugehoerigen Ebene. */
export function buildPortals() {
  const radius = PORTAL.radiusMm * MM;
  return {
    top: {
      position: modelMmToWorld(PORTAL.top.x, PORTAL.top.y, LEVELS.top.walkZ, "top"),
      radius,
    },
    bottom: {
      position: modelMmToWorld(PORTAL.bottom.x, PORTAL.bottom.y, LEVELS.bottom.walkZ, "bottom"),
      radius,
    },
  };
}
