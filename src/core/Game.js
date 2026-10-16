import * as THREE from "three";
import { createRenderer } from "./createRenderer.js";
import { createScene } from "./createScene.js";
import { ThirdPersonCamera } from "./ThirdPersonCamera.js";
import { Board, HEIGHT_CELL_SIZE } from "./Board.js";
import { IntroSequence } from "./IntroSequence.js";
import {
  PLATINE_BYTES,
  PLATINE_URL,
  PLAYER_URL,
  alignToPcb,
  analyzeHierarchy,
  applyMaterialOverrides,
  loadGLTF,
  normalizeMaterials,
} from "./model-loader.js";
import {
  CHARACTER_HEIGHT,
  CONTROLS,
  FALL_COMMIT_MM,
  FALL_DEATH_Y,
  GAMEPAD_CONTROLS,
  MATERIAL_OVERRIDES,
  MOUSE_SENSITIVITY,
  MOUSE_WHEEL,
  OBSTACLE_HEIGHT_MM,
  OPPOSITE_SIDE,
  PORTAL,
  SLIDE_SWITCH_SPEED_MM,
  SPAWN_CAMERA_YAW_DEG,
  WORLD_PER_MM,
  buildComponents,
  buildLevel,
  buildPortals,
  buildSensors,
  buildSpawn,
} from "./level-config.js";
import { clampDistanceToBoxes, resolveBoxVsBoxes } from "./collision.js";
import { Character } from "../entities/Character.js";
import { ChipModel } from "../entities/ChipModel.js";
import { PortalMarker } from "../entities/PortalMarker.js";
import { SensorMarker } from "../entities/SensorMarker.js";
import { KeyboardMouseInput, keyLabel } from "../input/KeyboardMouseInput.js";
import { BUTTON_LABELS, GamepadManager } from "../input/GamepadManager.js";
import { DebugOverlay } from "../input/DebugOverlay.js";
import { FadeOverlay, LoadingOverlay } from "../ui/overlays.js";
import {
  GamepadHint,
  InfoBox,
  MessageOverlay,
  MissionHud,
  Prompt,
  TitleScreen,
} from "../ui/hud.js";
import { addScore, formatTime, loadScores } from "./leaderboard.js";
import {
  BRIEFING,
  BRIEFING_START,
  COMPONENT_INFO,
  EXPLORE,
  EXPLORE_MENU,
  FAILURE,
  RESET_CONFIRM,
  SWITCH_INFO,
  TITLE,
  VICTORY,
} from "./mission-texts.js";

const MAX_DELTA = 0.1; // Sekunden - verhindert Riesenspruenge nach Tab-Wechsel

/** Wie schnell der Charakter auf eine neue Bodenhoehe nachzieht (1/Sekunde). */
const GROUND_DAMPING = 16;

/** Fallbeschleunigung und Absprunggeschwindigkeit; Sprunghoehe = 2.4 Units = 6 mm. */
const GRAVITY = -30;
const JUMP_SPEED = 12;

/** Rasterpunkte je Achse, mit denen der Boden unter dem Grundriss abgetastet wird. */
const GROUND_SAMPLES = 5;

/** Anteil der Rasterpunkte, die Boden brauchen, damit die Figur stehen bleibt. */
const MIN_SUPPORT_RATIO = 0.5;

/** Maximale Stufe, die im Gehen genommen wird - hoeher geht nur per Sprung. */
const STEP_UP_LIMIT = OBSTACLE_HEIGHT_MM * WORLD_PER_MM;

/**
 * Hoehenunterschied, den Oberflaechendetails (Beschriftung, Markierungen) auf
 * einem Bauteil haben duerfen, ohne dass es fuer die darauf stehende Figur zur
 * Wand wird. Bewusst klein: verdeckte Zwischenschichten im Bauteil (z.B. die
 * Traegerplatte unter IC9, 0.6 mm ueber der Platine) duerfen keine Treppe sein.
 */
const SURFACE_TOLERANCE = WORLD_PER_MM * 0.1;

/** Fallhoehe unter der Laufebene, ab der der Sturz nicht mehr zu retten ist. */
const FALL_COMMIT_DEPTH = FALL_COMMIT_MM * WORLD_PER_MM;

/** Wie schnell eine Tasterkappe ein- bzw. zurueckfedert (1/Sekunde). */
const BUTTON_PRESS_RATE = 30;
const BUTTON_RELEASE_RATE = 18;
/** Wie weit die Fuesse unter der eingedrueckten Kappe liegen duerfen (Weltunits). */
const BUTTON_CONTACT_TOLERANCE = 0.08;

/** Spielraum, ab dem eine Quader-Unterkante ueber dem Kopf als Decke zaehlt. */
const CEILING_TOLERANCE = WORLD_PER_MM * 0.05;

/** So nah muss der Chip am Schalterhebel sein, damit Laufen dagegen ihn schiebt. */
const LEVER_CONTACT_MARGIN = WORLD_PER_MM * 0.15;
/** So weit darf der Chip unter dem Hebelfuss stehen und ihn trotzdem schieben (Abdeckung). */
const LEVER_STAND_TOLERANCE = WORLD_PER_MM * 0.3;

/** Wie schnell eine Status-LED auf- bzw. abblendet (1/Sekunde). */
const LED_ON_RATE = 40;
const LED_OFF_RATE = 12;

/** Deckkraft eines begehbaren Bauteils, solange der Chip darin steht. */
const PART_INSIDE_OPACITY = 0.3;
/** Wie schnell es ein- und ausblendet (1/Sekunde). */
const PART_FADE_RATE = 10;

const NO_INPUT = { x: 0, y: 0 };

/**
 * Tastenname einer Aktion fuer Prompts. Wer gerade mit dem Controller spielt,
 * bekommt die Controller-Taste, dahinter in Klammern die Maus-/Tastaturtaste -
 * spiegelbildlich zum Controller Game.
 */
function inputLabel(action, device) {
  const keyboard = keyLabel(CONTROLS.actions[action][0]);
  const pad = GAMEPAD_CONTROLS.actions[action]?.map((button) => BUTTON_LABELS[button]);
  if (device !== "gamepad" || !pad?.length) return keyboard;
  return `${pad.slice(0, 2).join("/")} (${keyboard})`;
}

/**
 * Zentrale Klasse: haelt Szene, Kamera, Input und Entities zusammen und
 * betreibt die Game-Loop (Input -> Update -> Render).
 *
 * Ablauf und Spielregeln entsprechen dem Controller Game; gesteuert wird mit
 * Maus und Tastatur, im Notfall parallel auch mit einem Controller.
 *
 * Ablauf: `new Game(container)` -> `await game.load()` -> `game.start()`.
 * Die Loop startet erst, wenn das Platinen-Modell vollstaendig geladen ist.
 */
export class Game {
  constructor(container) {
    const { renderer, camera, dispose } = createRenderer(container);
    this.renderer = renderer;
    this.camera = camera;
    this._disposeRenderer = dispose;

    const { scene, fitToBounds, focusShadow } = createScene({ worldSize: 20 });
    this.scene = scene;
    this._fitToBounds = fitToBounds;
    this._focusShadow = focusShadow;

    /** Begehbare Ebenen und Portalpositionen in Weltkoordinaten. */
    this.levels = { top: buildLevel("top"), bottom: buildLevel("bottom") };
    this.portals = buildPortals();
    /** "top" | "bottom" */
    this.currentSide = "top";

    this.character = new Character({ moveSpeed: 6 });
    this.character.position.copy(buildSpawn("top"));
    this.scene.add(this.character.object3D);

    this.cameraRig = new ThirdPersonCamera(this.camera, this.character, {
      distance: 6,
      height: 1.5,
      lookAtHeight: 0.5,
      yaw: THREE.MathUtils.degToRad(SPAWN_CAMERA_YAW_DEG),
      mouseSensitivity: MOUSE_SENSITIVITY,
      rotationSpeed: GAMEPAD_CONTROLS.cameraSpeed,
      collider: (origin, direction, distance) =>
        this.board ? this._cameraDistance(origin, direction, distance) : distance,
    });
    this._faceSpawnDirection();

    // Notfall-Steuerung: ein Controller laeuft immer parallel zu Maus und Tastatur.
    this.input = new KeyboardMouseInput(renderer.domElement, CONTROLS, {
      gamepad: new GamepadManager({ deadzone: GAMEPAD_CONTROLS.deadzone }),
      gamepadBindings: GAMEPAD_CONTROLS,
    });
    this.debugOverlay = new DebugOverlay(document.body);
    this.loadingOverlay = new LoadingOverlay(document.body);
    this.fadeOverlay = new FadeOverlay(document.body, PORTAL.fadeDurationMs);
    this.missionHud = new MissionHud(document.body);
    this.prompt = new Prompt(document.body);
    this.infoBox = new InfoBox(document.body);
    this.message = new MessageOverlay(document.body);
    this.gamepadHint = new GamepadHint(document.body);
    this.titleScreen = null;

    /** "intro" | "briefing" | "playing" | "falling" | "failed" | "won" | "confirm" */
    this.state = "intro";
    this.sensors = buildSensors().map((sensor) => ({
      ...sensor,
      label: COMPONENT_INFO[sensor.info].used.name.replace(/^XENSIV\u2122\s*/, ""),
      marked: false,
      marker: null,
    }));
    /** Weitere Bauteile; `marked` heisst hier "im Erkundungsmodus entdeckt". */
    this.components = buildComponents().map((part) => ({ ...part, marked: false, marker: null }));
    /** "mission" bis zum Sieg, danach optional "explore". */
    this.mode = "mission";
    this._results = null;
    /** Nur auf dem Start-Briefing kann man die Jagd ueberspringen. */
    this._atStart = false;
    /** Laufzeit in Sekunden; laeuft nur waehrend des aktiven Spiels. */
    this.runTime = 0;

    this.board = null;
    this.portalMarker = null;
    this.intro = null;
    this._inPortalZone = false;
    this._nearSensor = null;
    this._isTransitioning = false;
    this._verticalVelocity = 0;
    this._isGrounded = true;
    /** id des begehbaren Bauteils, in dem der Chip gerade steht. */
    this._insidePart = null;
    this._cameraBlockers = null;
    this._partOpacity = new Map();
    /** Sensoren unter dem Mausrad in Reichweite - Mausrad durchscheinend. */
    this._wheelRevealed = false;
    /** Das Mausrad steht zwischen Figur und Kamera - Rad durchscheinend. */
    this._wheelOccluding = false;
    /** S3 steht auf "+5V" - die Mausrad-Baugruppe ist weg (MOUSE_WHEEL.hiddenBySwitch). */
    this._wheelHidden = false;
    /** Rahmen von IC6/IC14 - bei durchscheinendem Mausrad ohne Tiefentest. */
    this._revealMarkerMaterials = [];
    /** Zielwinkel des Mausrads (Radiant), dem es weich nachdreht. */
    this._wheelTarget = 0;

    this._clock = new THREE.Clock();
    this._frameId = null;
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._moveDirection = new THREE.Vector3();
    this._fps = 0;

    this._tick = this._tick.bind(this);
  }

  /** Laedt Maus-Platine und Spielermodell und baut beide in die Szene ein. */
  async load() {
    try {
      const [gltf, player] = await Promise.all([
        loadGLTF(PLATINE_URL, (progress) => this.loadingOverlay.setProgress(progress), PLATINE_BYTES),
        loadGLTF(PLAYER_URL),
      ]);

      // Platine in den Ursprung ihrer CAD-Koordinaten, Mausrad wandert mit.
      alignToPcb(gltf.scene, MOUSE_WHEEL.pcbNode);

      // Analyse VOR der Transformation: Werte in CAD-Koordinaten (mm, Z-up).
      analyzeHierarchy(gltf.scene, {
        label: "Maus-Platine",
        unitScale: 1000,
        unitLabel: "mm (CAD, Z-up)",
      });

      normalizeMaterials(gltf.scene);
      normalizeMaterials(player.scene);
      applyMaterialOverrides(gltf.scene, MATERIAL_OVERRIDES);

      const chip = new ChipModel(player.scene);
      this.character.setModel(chip.object3D, chip);
      this.character.halfExtents.copy(chip.halfExtents);

      this.board = new Board(gltf.scene);
      this.scene.add(this.board.object3D);
      this._fitToBounds(this.board.boundingBox);

      this._createPortalMarker();
      this._createSensorMarkers();
      this._createComponentMarkers();
      this._setSide("top");
      this.cameraRig.snapToTarget();
      this.missionHud.update(this.sensors);
      this.loadingOverlay.hide();
    } catch (error) {
      this.loadingOverlay.setError(error.message);
      throw error;
    }
  }

  start() {
    this.input.start();
    // Ausgangslage der Kamera - die Intro-Fahrt endet dort, auch nach einem Reset.
    this._cameraHome = {
      pitch: this.cameraRig.pitch,
      yaw: this.cameraRig.yaw,
      distance: this.cameraRig.distance,
    };
    this.intro = new IntroSequence(this.cameraRig);
    this.titleScreen = new TitleScreen(TITLE, document.body);
    this._clock.start();
    this._frameId = requestAnimationFrame(this._tick);
  }

  stop() {
    if (this._frameId !== null) {
      cancelAnimationFrame(this._frameId);
      this._frameId = null;
    }
    this.input.stop();
  }


  dispose() {
    this.stop();
    this.debugOverlay.dispose();
    this.fadeOverlay.dispose();
    this.gamepadHint.dispose();
    this._disposeRenderer();
  }

  _tick() {
    this._frameId = requestAnimationFrame(this._tick);

    const deltaTime = Math.min(this._clock.getDelta(), MAX_DELTA);
    if (deltaTime > 0) {
      this._fps = this._fps * 0.9 + (1 / deltaTime) * 0.1;
    }

    // 1. Eingaben dieses Frames einsammeln
    const input = this.input.update();
    const actions = input.actions;

    const introRunning = this.state === "intro";
    // Wie D-Pad links + rechts im Controller Game: beide gehalten, einer davon
    // gerade neu - sonst feuert es jeden Frame.
    const resetCombo =
      actions.resetLeft.pressed &&
      actions.resetRight.pressed &&
      (actions.resetLeft.justPressed || actions.resetRight.justPressed);
    const resetRequested = resetCombo || actions.reset.justPressed;

    if (this.state === "confirm") {
      if (actions.action.justPressed) this._backToIntro();
      else if (actions.jump.justPressed) this._cancelReset();
    } else if (resetRequested && !introRunning && !this._isTransitioning) {
      this._askReset();
    } else if (introRunning) {
      // Beide Aktionstasten ueberspringen die Kamerafahrt
      if (actions.action.justPressed || actions.jump.justPressed) this.intro.finish();
    } else if (this.state === "playing") {
      if (actions.info.justPressed) {
        if (this.mode === "explore") this._showResults();
        else this._openInfo();
      }
    } else if (this.state !== "falling") {
      // Pfeil hoch/runter wechselt zwischen den Reitern des Infobildschirms
      if (actions.tabInfo.justPressed) this.message.openTab("info");
      else if (actions.tabControls.justPressed) this.message.openTab("controls");

      // Briefing, Sieg und Absturz warten alle auf die Aktionstaste
      if (actions.action.justPressed) this._confirmMessage();
      else if (actions.explore.justPressed && (this.state === "won" || this._atStart)) {
        this._startExplore();
      }
    }

    // Waehrend Intro, Ueberblendung, Infobildschirm und Endbildschirm ist die
    // Steuerung gesperrt.
    const locked =
      this._isTransitioning ||
      introRunning ||
      this.state === "briefing" ||
      this.state === "confirm" ||
      this.isGameOver;

    // Die Uhr laeuft nur im aktiven Spiel - Infobildschirm pausiert sie.
    if (this.mode === "mission" && (this.state === "playing" || this.state === "falling")) {
      this.runTime += deltaTime;
    }

    // 2. Kamera aus der Maus bzw. dem rechten Controller-Stick
    if (!locked) {
      this.cameraRig.look(input.look.x, input.look.y);
      this.cameraRig.rotate(input.stick.x, input.stick.y, deltaTime);
    }

    // 3. Bewegung aus WASD bzw. linkem Stick - relativ zur Kamera-Ausrichtung.
    // Wer stuerzt, hat die Kontrolle verloren - der Fall ist nicht zu retten.
    const steerable = !locked && this.state !== "falling";
    this._applyMovementInput(steerable ? input.move : NO_INPUT);
    if (steerable && actions.jump.justPressed) this._jump();

    // 4. Entities updaten, danach auf die aktuelle Ebene zwingen
    this.character.update(deltaTime);
    this._resolveCollisions();
    this._updateGrounding(deltaTime);
    this._updatePushButtons(deltaTime);
    this._updateSlideSwitches(deltaTime);
    this._updateStatusLeds(deltaTime);
    this._updateMouseWheel(input, deltaTime);
    this._updateEnterableParts(deltaTime);

    // 5. Interaktionen auswerten
    this._updatePortal(input, locked);
    this._updateSensors(input, locked);
    this._updateInfo(locked);
    this.portalMarker?.update(this._clock.elapsedTime);

    if (introRunning) {
      this.intro.update(deltaTime);
      if (this.intro.done) this._endIntro();
    } else {
      this.cameraRig.update(deltaTime);
    }
    this._focusShadow(this.character.position);

    // 6. Anzeigen + Rendern
    this.prompt.set(this._promptText(input));
    this.gamepadHint.update(input.lastDevice === "gamepad");
    if (this.mode === "explore") {
      const points = [...this.sensors, ...this.components];
      const found = points.filter((point) => point.marked).length;
      this.missionHud.showExplore(found, points.length);
    } else {
      this.missionHud.update(this.sensors, formatTime(this.runTime));
    }
    this.debugOverlay.update(input, {
      fps: this._fps.toFixed(0),
      seite: this.currentSide,
      pos: formatPosition(this.character.position),
      schalter: this.board?.slideSwitches.map((lever) => `${lever.id} ${lever.target.label}`).join(", ") ?? "-",
      eingabe: input.lastDevice === "gamepad" ? "Controller" : "Maus/Tastatur",
    });
    this.renderer.render(this.scene, this.camera);
  }

  get isGameOver() {
    return this.state === "failed" || this.state === "won";
  }

  /** Text der Kontextanzeige am unteren Bildrand. */
  _promptText(input) {
    const device = input.lastDevice;
    if (this.state === "intro") return `Press ${inputLabel("jump", device)} to skip the intro`;
    if (this.state !== "playing" || this._isTransitioning) return null;
    if (this._nearSensor) {
      const how = device === "gamepad" ? inputLabel(this._nearSensor.input, device) : this._nearSensor.button;
      return `Sensor ${this._nearSensor.id} - ${how} to mark it`;
    }
    if (this._inPortalZone) return `Press ${inputLabel("action", device)} to switch sides`;
    // Mit dem Controller braucht es keinen Mausfang.
    if (device !== "gamepad" && !input.pointerLocked) {
      return input.lockAvailable
        ? "Click into the game to look around with the mouse"
        : "Drag with the left mouse button to look around";
    }
    return null;
  }

  /** Kamerafahrt vorbei: Titel ausblenden, Briefing zeigen. */
  _endIntro() {
    this.state = "briefing";
    this.titleScreen?.hide();
    this.titleScreen = null;
    this.runTime = 0;
    this._atStart = true;
    this.message.show({ ...BRIEFING_START, scores: loadScores() });
  }

  /** Infobildschirm im laufenden Spiel erneut oeffnen - die Uhr pausiert dabei. */
  _openInfo() {
    this.state = "briefing";
    this.message.show({ ...BRIEFING, scores: loadScores() });
  }

  /** Aktionstaste auf Briefing / Endbildschirm. */
  _confirmMessage() {
    this.message.hide();
    this._atStart = false;
    if (this.state === "briefing") {
      this.state = "playing";
      return;
    }
    this._restart();
  }

  /**
   * Rechnet WASD in eine kamerarelative Weltrichtung um:
   * W = weg von der Kamera, D = rechts im Bild.
   */
  _applyMovementInput(move) {
    const yaw = this.cameraRig.yaw;

    this._forward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this._right.set(Math.cos(yaw), 0, -Math.sin(yaw));

    this._moveDirection
      .copy(this._forward)
      .multiplyScalar(move.y)
      .addScaledVector(this._right, move.x);

    const intensity = Math.min(Math.hypot(move.x, move.y), 1);
    this.character.setMoveDirection(this._moveDirection.x, this._moveDirection.z, intensity);
  }

  /** Haelt den Charakter aus hohen Bauteilen heraus. */
  _resolveCollisions() {
    if (!this.board || this.state === "falling") return;

    const position = this.character.position;
    // Bauteile, auf deren Oberseite man steht, sind keine Wand - auch wenn die
    // Box-Oberkante knapp darueber liegt (z.B. die aufgedruckte Beschriftung
    // auf IC9). Sonst wird die Figur am Rand heruntergeschoben.
    resolveBoxVsBoxes(
      position,
      this.character.halfExtents,
      this.character.object3D.rotation.y,
      this.board.obstacles[this.currentSide],
      position.y + SURFACE_TOLERANCE
    );
    this._resolveLeverCollisions();
    // Feine Kollision begehbarer Bauteile (P1/P2): nur was auf Koerperhoehe liegt.
    resolveBoxVsBoxes(
      position,
      this.character.halfExtents,
      this.character.object3D.rotation.y,
      this._solidWalls(),
      -Infinity
    );
  }

  /**
   * Quader begehbarer Bauteile, die auf der aktuellen Hoehe eine Wand sind:
   * auf Koerperhoehe und zu hoch zum Hinaufsteigen - oder ohne Platz fuer den
   * Chip ueber ihrer Oberseite. Unter den Kontakten im Steckverbinder laeuft
   * man hindurch, auf dem Quader, auf dem man steht, sowieso.
   */
  _solidWalls() {
    const feet = this.character.position.y;
    return this.board.solids[this.currentSide].filter(
      (box) =>
        box.bottom < feet + CHARACTER_HEIGHT &&
        box.top > feet + SURFACE_TOLERANCE &&
        (box.top > feet + STEP_UP_LIMIT || box.headroom < CHARACTER_HEIGHT)
    );
  }

  /**
   * Niedrigste Unterkante eines Quaders ueber dem Kopf, sonst Infinity. Ohne
   * diese Decke sprange der Chip im Steckverbinder durchs Dach.
   */
  _ceilingHeight(headY) {
    return this._ceilingBox(headY)?.bottom ?? Infinity;
  }

  /** Der Quader, der direkt ueber dem Kopf die Decke bildet - oder null. */
  _ceilingBox(headY) {
    const position = this.character.position;
    const { extentX, extentZ } = this._footprintExtents();

    let ceiling = null;
    for (const box of this.board.solids[this.currentSide]) {
      if (box.bottom < headY - CEILING_TOLERANCE) continue;
      if (ceiling && box.bottom >= ceiling.bottom) continue;
      if (
        position.x + extentX > box.minX &&
        position.x - extentX < box.maxX &&
        position.z + extentZ > box.minZ &&
        position.z - extentZ < box.maxZ
      ) {
        ceiling = box;
      }
    }
    return ceiling;
  }

  /**
   * Steht der Chip unter dem Dach eines begehbaren Bauteils, wird es
   * durchscheinend, und die Kamera ignoriert es - sonst klebte sie im
   * Steckverbinder direkt hinter dem Chip. Dasselbe gilt fuer das Mausrad,
   * sobald die Figur an die Sensoren darunter (IC6, IC14) herankommt. Steht
   * S3 auf "+5V", blendet die Mausrad-Baugruppe ganz aus.
   */
  _updateEnterableParts(deltaTime) {
    if (!this.board) return;

    const wheelHidden = this._isWheelHiddenBySwitch();
    if (wheelHidden !== this._wheelHidden) {
      this._wheelHidden = wheelHidden;
      this.board.setMouseWheelVisible(!wheelHidden);
      this._cameraBlockers = null;
      this._rotorBlockers = null;
      this._placeSensorMarkers();
      console.log(`[Mausrad] ${wheelHidden ? "ausgeblendet" : "wieder da"}`);
    }

    const head = this.character.position.y + CHARACTER_HEIGHT;
    const inside = this.state === "falling" ? null : this._ceilingBox(head)?.id ?? null;
    const wheelRevealed = this._isNearWheelSensors();
    if (inside !== this._insidePart || wheelRevealed !== this._wheelRevealed) {
      this._insidePart = inside;
      this._wheelRevealed = wheelRevealed;
      this._cameraBlockers = null;
      for (const material of this._revealMarkerMaterials) material.depthTest = !wheelRevealed;
    }

    for (const id of this.board.enterableMaterials.keys()) {
      const isWheel = id === MOUSE_WHEEL.id || id === MOUSE_WHEEL.rotorId;
      let target = id === inside ? PART_INSIDE_OPACITY : 1;
      if (id === MOUSE_WHEEL.id && wheelRevealed) target = MOUSE_WHEEL.revealOpacity;
      if (id === MOUSE_WHEEL.rotorId) {
        if (this._wheelOccluding) target = Math.min(target, MOUSE_WHEEL.occludeOpacity);
        if (wheelRevealed) target = Math.min(target, MOUSE_WHEEL.revealOpacity);
      }
      if (isWheel && wheelHidden) target = 0;
      const rate = isWheel && wheelHidden ? MOUSE_WHEEL.hideFadeRate : PART_FADE_RATE;
      const alpha = 1 - Math.exp(-rate * deltaTime);
      const current = this._partOpacity.get(id) ?? 1;
      const next = Math.abs(target - current) < 0.01 ? target : current + (target - current) * alpha;
      if (next !== current) {
        this._partOpacity.set(id, next);
        this.board.setPartOpacity(id, next);
      }
    }

    // Ganz ausgeblendet: gar nicht mehr zeichnen.
    if (this.board.mouseWheel) {
      this.board.mouseWheel.object3D.visible =
        (this._partOpacity.get(MOUSE_WHEEL.id) ?? 1) > 0 ||
        (this._partOpacity.get(MOUSE_WHEEL.rotorId) ?? 1) > 0;
    }
  }

  /** Steht der Schalter aus MOUSE_WHEEL.hiddenBySwitch in seiner Stellung (und ist dort angekommen)? */
  _isWheelHiddenBySwitch() {
    const rule = MOUSE_WHEEL.hiddenBySwitch;
    if (!rule || !this.board?.mouseWheel) return false;
    const lever = this.board.slideSwitches.find((entry) => entry.id === rule.slide);
    return Boolean(
      lever && lever.target.label === rule.position && lever.offsetMm === lever.target.offsetMm
    );
  }

  /** Ist die Figur unten auf der Platine nah an einem der Sensoren unter dem Mausrad? */
  _isNearWheelSensors() {
    if (!this.board?.mouseWheel || this._wheelHidden || this.state === "intro") return false;
    const radius = MOUSE_WHEEL.revealRadiusMm * WORLD_PER_MM;
    const position = this.character.position;
    const heightAboveBoard = (position.y - this.levels[this.currentSide].y) / WORLD_PER_MM;
    if (heightAboveBoard > MOUSE_WHEEL.revealMaxHeightMm) return false;
    return this.sensors.some(
      (sensor) =>
        MOUSE_WHEEL.revealSensors.includes(sensor.id) &&
        sensor.side === this.currentSide &&
        Math.hypot(position.x - sensor.position.x, position.z - sensor.position.z) <= radius
    );
  }

  /**
   * Kamera-Blocker der aktuellen Seite - ohne das Bauteil, in dem der Chip
   * steht, ohne das Mausrad, solange es durchscheinend ist, und ohne die
   * drehenden Teile des Mausrads (die prueft _cameraDistance getrennt).
   */
  _activeCameraBlockers() {
    if (!this._cameraBlockers || this._cameraBlockersSide !== this.currentSide) {
      this._cameraBlockers = this.board.cameraBlockers[this.currentSide].filter(
        (box) =>
          box.id !== MOUSE_WHEEL.rotorId &&
          (!this._insidePart || box.id !== this._insidePart) &&
          !(this._wheelRevealed && box.id === MOUSE_WHEEL.id)
      );
      this._cameraBlockersSide = this.currentSide;
    }
    return this._cameraBlockers;
  }

  /** Nur die feinen Blocker von Rad und Nabe auf der aktuellen Seite. */
  _rotorCameraBlockers() {
    if (!this._rotorBlockers || this._rotorBlockersSide !== this.currentSide) {
      this._rotorBlockers = this.board.cameraBlockers[this.currentSide].filter(
        (box) => box.id === MOUSE_WHEEL.rotorId
      );
      this._rotorBlockersSide = this.currentSide;
    }
    return this._rotorBlockers;
  }

  /**
   * Erlaubter Kameraabstand. Steht das Mausrad im Weg, rueckt die Kamera
   * nicht heran - das Rad wird stattdessen durchscheinend (siehe
   * _updateEnterableParts). Alle anderen Bauteile kuerzen den Abstand.
   */
  _cameraDistance(origin, direction, distance) {
    const allowed = clampDistanceToBoxes(origin, direction, distance, this._activeCameraBlockers());
    const rotor = this._rotorCameraBlockers();
    this._wheelOccluding =
      rotor.length > 0 && clampDistanceToBoxes(origin, direction, allowed, rotor) < allowed;
    return allowed;
  }

  /**
   * Dreht das Mausrad mit dem echten Mausrad mit - je Raster um
   * MOUSE_WHEEL.degreesPerStep, weich nachgezogen. Nach unten scrollen dreht
   * die Oberkante des Rads zur Figur hin, wie an der echten Maus. Ein Klick
   * aufs Mausrad drueckt Rad, Nabe und Achse nach unten.
   */
  _updateMouseWheel(input, deltaTime) {
    if (!this.board?.mouseWheel) return;

    // Klick: solange gehalten, gleitet das Rad im Langloch nach unten.
    const pressed = input.actions.wheelClick.pressed;
    const depth = this.board.mouseWheel.depth;
    const targetDepth = pressed ? MOUSE_WHEEL.clickTravelMm : 0;
    if (depth !== targetDepth) {
      const rate = pressed ? BUTTON_PRESS_RATE : BUTTON_RELEASE_RATE;
      const next = depth + (targetDepth - depth) * (1 - Math.exp(-rate * deltaTime));
      this.board.setMouseWheelDepth(Math.abs(targetDepth - next) < 1e-3 ? targetDepth : next);
    }

    this._wheelTarget += input.wheel * THREE.MathUtils.degToRad(MOUSE_WHEEL.degreesPerStep);
    const current = this.board.mouseWheel.angle;
    const remaining = this._wheelTarget - current;
    if (Math.abs(remaining) < 1e-4) return;
    const alpha = 1 - Math.exp(-MOUSE_WHEEL.followRate * deltaTime);
    this.board.setMouseWheelAngle(current + remaining * alpha);
  }

  /**
   * Haelt den Charakter auf der Oberflaeche. Gibt es unter ihm keine Platine
   * mehr (Hoehenraster liefert NaN), faellt er - und die Runde ist vorbei.
   */
  _updateGrounding(deltaTime) {
    const position = this.character.position;
    // Ein begonnener Sturz kennt keinen Boden mehr.
    const groundY = this.state === "falling" ? NaN : this._groundHeight();
    const overVoid = Number.isNaN(groundY);

    if (this._isGrounded && !overVoid) {
      position.y += (groundY - position.y) * (1 - Math.exp(-GROUND_DAMPING * deltaTime));
      return;
    }

    if (this._isGrounded) {
      this._isGrounded = false;
      this._verticalVelocity = 0;
    }

    const headBefore = position.y + CHARACTER_HEIGHT;
    this._verticalVelocity += GRAVITY * deltaTime;
    position.y += this._verticalVelocity * deltaTime;

    if (this._verticalVelocity > 0 && this.board) {
      const ceiling = this._ceilingHeight(headBefore);
      if (position.y + CHARACTER_HEIGHT > ceiling) {
        position.y = ceiling - CHARACTER_HEIGHT;
        this._verticalVelocity = 0;
      }
    }

    if (!overVoid && position.y <= groundY) {
      position.y = groundY;
      this._verticalVelocity = 0;
      this._isGrounded = true;
      return;
    }

    // Sackt die Figur merklich unter ihre Laufebene, war es kein Sprung ueber
    // ein Loch mehr, sondern einer hindurch.
    if (
      this.state === "playing" &&
      position.y < this.levels[this.currentSide].y - FALL_COMMIT_DEPTH
    ) {
      this.state = "falling";
    }

    if (position.y < FALL_DEATH_Y && this.state === "falling") {
      if (this.mode === "explore") this._respawn();
      else this._fail();
    }
  }

  _jump() {
    if (!this._isGrounded) return;
    this._verticalVelocity = JUMP_SPEED;
    this._isGrounded = false;
  }

  _groundHeight() {
    if (!this.board) return this.levels[this.currentSide].y;

    const feet = this.character.position.y;
    // Hinauf nur so weit, wie ueber dem Kopf Platz ist. Sonst stiege der Chip
    // im Steckverbinder auf eine Kante unter dem Dach, steckte mit dem Kopf im
    // Material und wuerde seitlich - womoeglich nach aussen - herausgedrueckt.
    const headroom = this._ceilingHeight(feet + CHARACTER_HEIGHT) - CHARACTER_HEIGHT;
    const { height, support } = this._sampleGround(Math.min(feet + STEP_UP_LIMIT, headroom));
    if (support < MIN_SUPPORT_RATIO) return NaN;
    // Zu hohe Flaechen tragen nur, wer schon steht - sonst unsichtbare Plattform.
    if (Number.isNaN(height)) return this._isGrounded ? this.character.position.y : NaN;
    return height;
  }

  /**
   * Setzt die Figur beim Spawn oder Seitenwechsel auf die Oberflaeche unter
   * ihr. Hier gilt weder die Stufengrenze noch der Wandfilter - sonst landete
   * sie beim Wechsel auf die Oberseite nicht auf IC9, sondern darin.
   */
  _snapToGround() {
    if (!this.board) return;

    const { height } = this._sampleGround(Infinity, false);
    if (!Number.isNaN(height)) this.character.position.y = height;
  }

  /**
   * Tastet den Boden ueber den gesamten - mitgedrehten - Grundriss ab.
   * Massgeblich ist der hoechste Treffer unterhalb von `stepLimit`.
   */
  _sampleGround(stepLimit, skipWalls = true) {
    const side = this.currentSide;

    // Bauteile, die auf dieser Hoehe eine Wand sind, liefern keinen Boden.
    // Sonst klettert die Figur an ihnen hoch bzw. rutscht an ihnen herunter:
    // Das Raster reicht bis zu einer Zelle ueber den Bauteilrand hinaus, und
    // verdeckte Zwischenschichten (Traegerplatte unter IC9, Steckverbinder
    // P1/P2) wirken als Treppenstufen.
    const wallTop = this.character.position.y + SURFACE_TOLERANCE;
    const walls = skipWalls
      ? [...this._obstacles().filter((box) => box.top > wallTop), ...this._solidWalls()]
      : [];

    let height = NaN;
    let supported = 0;
    let total = 0;

    this._forEachFootprintSample((sampleX, sampleZ) => {
      total++;
      if (!this.board.hasGround(side, sampleX, sampleZ)) return;
      supported++;

      if (walls.some((box) => insideBox(box, sampleX, sampleZ, HEIGHT_CELL_SIZE))) return;

      const sample = this.board.sampleHeight(side, sampleX, sampleZ, stepLimit);
      if (Number.isNaN(sample)) return;
      if (Number.isNaN(height) || sample > height) height = sample;
    });

    return { height, support: supported / total };
  }

  /** Ruft `callback(x, z)` fuer jeden Rasterpunkt des - mitgedrehten - Grundrisses. */
  _forEachFootprintSample(callback) {
    const position = this.character.position;
    const angle = this.character.object3D.rotation.y;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const { x: halfX, y: halfZ } = this.character.halfExtents;

    for (let i = 0; i < GROUND_SAMPLES; i++) {
      const localX = ((i / (GROUND_SAMPLES - 1)) * 2 - 1) * halfX;

      for (let j = 0; j < GROUND_SAMPLES; j++) {
        const localZ = ((j / (GROUND_SAMPLES - 1)) * 2 - 1) * halfZ;
        callback(position.x + localX * cos + localZ * sin, position.z - localX * sin + localZ * cos);
      }
    }
  }

  /**
   * Taster S1/S2: Steht der Chip auf einer Kappe - egal ob hingesprungen oder
   * hinaufgelaufen -, federt sie ein; er sinkt ueber die Bodenhaftung mit.
   * Springt er ab, federt sie zurueck.
   */
  _updatePushButtons(deltaTime) {
    if (!this.board) return;

    const standing = this._isGrounded && this.state !== "falling";
    const feetY = this.character.position.y;
    const pressed = new Set();
    if (standing) {
      this._forEachFootprintSample((x, z) => {
        const button = this.board.pushButtonAt(this.currentSide, x, z);
        if (button && feetY >= button.top - button.travel - BUTTON_CONTACT_TOLERANCE) {
          pressed.add(button);
        }
      });
    }

    for (const button of this.board.pushButtons) {
      const down = pressed.has(button);
      const target = down ? button.travel : 0;
      const rate = down ? BUTTON_PRESS_RATE : BUTTON_RELEASE_RATE;
      const depth = button.depth + (target - button.depth) * (1 - Math.exp(-rate * deltaTime));
      this.board.setPushButtonDepth(button, Math.abs(target - depth) < 1e-4 ? target : depth);

      if (down && !button.isDown && button.depth > button.travel * 0.5) {
        button.isDown = true;
        console.log(`[Taster] ${button.id} (${button.label}) gedrueckt`);
      } else if (!down && button.isDown && button.depth < button.travel * 0.5) {
        button.isDown = false;
      }
    }
  }

  /**
   * Schiebeschalter S3: Steht der Chip auf dem Schaltergehaeuse und laeuft
   * gegen den Hebel, rutscht dieser ans andere Ende des Schlitzes. Er bleibt
   * dort - zurueck geht es nur, indem man ihn von der anderen Seite schiebt.
   */
  _updateSlideSwitches(deltaTime) {
    if (!this.board) return;

    const position = this.character.position;
    const move = this.character.moveDirection;
    const speed = move.length();
    const canPush = this._isGrounded && this.state !== "falling" && speed > 0.2;
    const { extentX, extentZ } = this._footprintExtents();

    for (const lever of this.board.slideSwitches) {
      if (canPush && lever.side === this.currentSide) {
        const box = this.board.slideSwitchBox(lever);
        const feet = position.y;
        const onHousing = feet >= box.bottom - LEVER_STAND_TOLERANCE && feet < box.top - SURFACE_TOLERANCE;
        const touching =
          position.x + extentX > box.minX - LEVER_CONTACT_MARGIN &&
          position.x - extentX < box.maxX + LEVER_CONTACT_MARGIN &&
          position.z + extentZ > box.minZ &&
          position.z - extentZ < box.maxZ;
        // Der Hebel laeuft nur entlang x - geschoben wird, wer ueberwiegend so laeuft.
        const direction = Math.sign((box.minX + box.maxX) / 2 - position.x);
        const pushing = move.x * direction > 0.5 * speed;

        if (onHousing && touching && pushing) {
          // Endstellung, die in Schubrichtung liegt (CAD-x laeuft je Seite anders).
          const target = lever.positions.find(
            (entry) => Math.sign((entry.offsetMm - lever.offsetMm) * lever.sideSign) === direction
          );
          if (target) lever.target = target;
        }
      }

      const remaining = lever.target.offsetMm - lever.offsetMm;
      if (remaining === 0) continue;
      const step = SLIDE_SWITCH_SPEED_MM * deltaTime;
      const next =
        Math.abs(remaining) <= step ? lever.target.offsetMm : lever.offsetMm + Math.sign(remaining) * step;
      this.board.setSlideSwitchOffset(lever, next);
      if (next === lever.target.offsetMm) {
        console.log(`[Schalter] ${lever.id} steht auf ${lever.target.label}`);
      }
    }
  }

  /**
   * LED5/LED8 leuchten, solange PROG bzw. XRES eingedrueckt ist, LED6, solange
   * S3 auf "+5V" steht (und dort angekommen ist).
   */
  _updateStatusLeds(deltaTime) {
    if (!this.board) return;

    for (const led of this.board.statusLeds) {
      let on = false;
      if (led.button) {
        on = Boolean(this.board.pushButtons.find((button) => button.id === led.button)?.isDown);
      } else if (led.slide) {
        const lever = this.board.slideSwitches.find((entry) => entry.id === led.slide);
        on = Boolean(
          lever && lever.target.label === led.position && lever.offsetMm === lever.target.offsetMm
        );
      }

      const target = on ? 1 : 0;
      const rate = on ? LED_ON_RATE : LED_OFF_RATE;
      const level = led.level + (target - led.level) * (1 - Math.exp(-rate * deltaTime));
      this.board.setStatusLedLevel(led, Math.abs(target - level) < 0.005 ? target : level);
    }
  }

  /** Alle Hindernis-Boxen der aktuellen Seite - mit den Schalterhebeln in ihrer Stellung. */
  _obstacles() {
    const levers = this._leverBoxes();
    const obstacles = this.board.obstacles[this.currentSide];
    return levers.length ? [...obstacles, ...levers] : obstacles;
  }

  /** Schalterhebel der aktuellen Seite als Boxen in ihrer aktuellen Stellung. */
  _leverBoxes() {
    return this.board.slideSwitches
      .filter((lever) => lever.side === this.currentSide)
      .map((lever) => this.board.slideSwitchBox(lever));
  }

  /**
   * Schalterhebel halten die Figur nur entlang ihrer Schieberichtung (x) auf.
   * Die allgemeine Box-Kollision wuerde sie ueber die Ecken des schmalen
   * Hebels seitlich wegdruecken - dann rutscht man beim Schieben vorbei und
   * vom Schaltergehaeuse herunter.
   */
  _resolveLeverCollisions() {
    const position = this.character.position;
    const { extentX, extentZ } = this._footprintExtents();

    for (const box of this._leverBoxes()) {
      if (box.top <= position.y + SURFACE_TOLERANCE) continue;
      if (position.z + extentZ <= box.minZ || position.z - extentZ >= box.maxZ) continue;
      if (position.x + extentX <= box.minX || position.x - extentX >= box.maxX) continue;

      position.x = position.x < (box.minX + box.maxX) / 2 ? box.minX - extentX : box.maxX + extentX;
    }
  }

  /** Halbe Ausdehnung des achsenparallelen Rahmens um den gedrehten Grundriss. */
  _footprintExtents() {
    const angle = this.character.object3D.rotation.y;
    const { x: halfX, y: halfZ } = this.character.halfExtents;
    return {
      extentX: Math.abs(Math.cos(angle)) * halfX + Math.abs(Math.sin(angle)) * halfZ,
      extentZ: Math.abs(Math.sin(angle)) * halfX + Math.abs(Math.cos(angle)) * halfZ,
    };
  }

  /** Prueft die Triggerzone auf IC9 bzw. gegenueber und startet ggf. den Wechsel. */
  _updatePortal(input, locked) {
    if (locked || this.state !== "playing") {
      this._inPortalZone = false;
      return;
    }

    const portal = this.portals[this.currentSide];
    const dx = this.character.position.x - portal.position.x;
    const dz = this.character.position.z - portal.position.z;
    this._inPortalZone = Math.hypot(dx, dz) <= portal.radius;

    if (this._inPortalZone && input.actions.action.justPressed) {
      this._switchSide();
    }
  }

  /**
   * Sensoren aktualisieren: naechstgelegenen in Reichweite merken, und jeden
   * Sensor aufleuchten lassen, dessen Eingabe gerade gehalten wird.
   */
  _updateSensors(input, locked) {
    this._nearSensor = null;
    // Im Erkundungsmodus wird nicht markiert - die Rahmen pflegt _updateInfo().
    if (this.mode === "explore") return;
    const active = this.state === "playing" && !locked;

    for (const sensor of this.sensors) {
      const reachable = active && sensor.side === this.currentSide && !sensor.marked;

      const distance = Math.hypot(
        this.character.position.x - sensor.position.x,
        this.character.position.z - sensor.position.z
      );
      const inRange = reachable && distance <= sensor.radius;

      sensor.marker.inRange = inRange;
      sensor.marker.proximity = distance / sensor.radius;
      // Ein markierter Sensor reagiert nicht mehr auf seine Eingabe.
      sensor.marker.highlighted =
        active && !sensor.marked && input.actions[sensor.input].pressed;
      sensor.marker.update(this._clock.elapsedTime);

      if (inRange && (this._nearSensor === null || distance < this._nearSensorDistance)) {
        this._nearSensor = sensor;
        this._nearSensorDistance = distance;
      }
    }

    // Markiert wird mit der Eingabe, die der Sensor in der echten Maus abtastet.
    if (this._nearSensor && input.actions[this._nearSensor.input].justPressed) {
      this._markSensor(this._nearSensor);
    }
  }

  /**
   * Info-Box zum naechstgelegenen Bauteil. Im Auftrag nur die Sensoren, im
   * Erkundungsmodus alle Bauteile - die dabei als entdeckt gelten.
   */
  _updateInfo(locked) {
    const active = this.state === "playing" && !locked;
    const exploring = this.mode === "explore";
    const points = exploring ? [...this.sensors, ...this.components] : this.sensors;

    let nearest = null;
    let nearestDistance = Infinity;

    for (const point of points) {
      if (point.side !== this.currentSide) continue;

      const distance = Math.hypot(
        this.character.position.x - point.position.x,
        this.character.position.z - point.position.z
      );
      const inRange = active && distance <= point.radius;
      if (inRange && distance < nearestDistance) {
        nearest = point;
        nearestDistance = distance;
      }
    }

    if (exploring) {
      if (nearest && !nearest.marked) {
        nearest.marked = true;
        nearest.marker.marked = true;
      }
      for (const point of points) {
        point.marker.inRange = point === nearest;
        point.marker.update(this._clock.elapsedTime);
      }
    }

    // Schiebeschalter: eigene Info-Box mit seiner Funktion, wenn er naeher
    // liegt als jedes Bauteil. Er zaehlt nicht als entdecktes Bauteil.
    let lever = null;
    for (const entry of active ? this.board?.slideSwitches ?? [] : []) {
      if (entry.side !== this.currentSide || !SWITCH_INFO[entry.id]) continue;
      const distance = Math.hypot(
        this.character.position.x - entry.info.x,
        this.character.position.z - entry.info.z
      );
      if (distance <= entry.info.radius && distance < nearestDistance) {
        lever = entry;
        nearestDistance = distance;
      }
    }

    this.infoBox.setProminent(exploring);
    if (lever) {
      this.infoBox.show({ id: lever.id, button: lever.target.label }, this._switchInfo(lever));
    } else {
      this.infoBox.show(nearest, nearest && COMPONENT_INFO[nearest.info]);
    }
  }

  /** Inhalt der Info-Box eines Schiebeschalters - mit seiner aktuellen Stellung. */
  _switchInfo(lever) {
    const text = SWITCH_INFO[lever.id];
    // Erst wenn der Hebel angekommen ist, gilt die neue Stellung.
    const arrived = lever.offsetMm === lever.target.offsetMm;
    const current = arrived ? lever.target.label : null;
    return {
      title: text.title,
      description: text.description,
      stateKey: current ?? "moving",
      sections: [
        {
          label: "Positions",
          rows: lever.positions.map(({ label }) => ({
            name: label,
            type: text.positions[label] ?? "",
            current: label === current,
          })),
        },
        { label: "In this game", lines: text.game },
      ],
    };
  }

  _markSensor(sensor) {
    sensor.marked = true;
    sensor.marker.marked = true;
    this.missionHud.update(this.sensors);
    console.log(`[Mission] Sensor ${sensor.id} markiert`);

    if (this.sensors.every((entry) => entry.marked)) this._win();
  }

  _win() {
    this.state = "won";
    const { scores, rank } = addScore(this.runTime);
    this._results = {
      ...VICTORY,
      body: [...VICTORY.body, `Your time: ${formatTime(this.runTime)}`],
      scores,
      highlight: rank,
    };
    this.message.show(this._results);
  }

  /** Frei herumlaufen und alle Infineon-Bauteile entdecken - nach dem Sieg oder direkt. */
  _startExplore() {
    this._atStart = false;
    if (this.mode === "explore") {
      this.message.hide();
      this.state = "playing";
      return;
    }

    this.mode = "explore";
    for (const point of [...this.sensors, ...this.components]) {
      // Immer voll sichtbar - hier wird entdeckt, nicht gesucht.
      point.marker.proximity = 1;
      point.marker.highlighted = false;
    }
    this._updateMarkerVisibility();
    this.state = "briefing";
    this.message.show(EXPLORE);
  }

  /**
   * Menue im Erkundungsmodus: nach einem Sieg das Ergebnis, sonst eine kurze
   * Auswahl. Beide nutzen die Endbildschirm-Logik: E = neue Jagd, X = weiter.
   */
  _showResults() {
    this.state = "won";
    this.message.show(this._results ?? EXPLORE_MENU);
  }

  /** ← + → oder Rueckschritt: Rueckfrage, ob es zurueck zum Intro gehen soll. */
  _askReset() {
    this._beforeReset = {
      state: this.state,
      message: this.message.visible ? this.message.content : null,
    };
    this.state = "confirm";
    this.message.show(RESET_CONFIRM);
  }

  _cancelReset() {
    const { state, message } = this._beforeReset;
    this.state = state;
    if (message) this.message.show(message);
    else this.message.hide();
  }

  /** Alles zuruecksetzen und die Kamerafahrt samt Titel erneut abspielen. */
  _backToIntro() {
    this.message.hide();
    this._restart();
    Object.assign(this.cameraRig, this._cameraHome);
    this.cameraRig.snapToTarget();

    this.state = "intro";
    this._atStart = false;
    this.intro = new IntroSequence(this.cameraRig);
    this.titleScreen = new TitleScreen(TITLE, document.body);
  }

  /**
   * Absturz im Erkundungsmodus: zurueck auf die aktuelle Seite - oben auf den
   * Startpunkt, unten auf die Wechselzone.
   */
  _respawn() {
    const side = this.currentSide;
    if (side === "top") {
      this.character.position.copy(buildSpawn("top"));
      this._faceSpawnDirection();
      this.cameraRig.yaw = THREE.MathUtils.degToRad(SPAWN_CAMERA_YAW_DEG);
    } else {
      const { position } = this.portals.bottom;
      this.character.position.set(position.x, this.levels.bottom.y, position.z);
    }
    this.character.setMoveDirection(0, 0, 0);
    this._setSide(side);
    this.cameraRig.snapToTarget();
    this.state = "playing";
  }

  _fail() {
    this.state = "failed";
    this.message.show(FAILURE);
  }

  /** Zuruecksetzen nach Absturz oder Sieg. */
  _restart() {
    for (const point of [...this.sensors, ...this.components]) {
      point.marked = false;
      point.marker.reset();
    }
    this.mode = "mission";
    this._results = null;
    this.missionHud.update(this.sensors);

    this.character.position.copy(buildSpawn("top"));
    this.character.setMoveDirection(0, 0, 0);
    this._faceSpawnDirection();
    this.cameraRig.yaw = THREE.MathUtils.degToRad(SPAWN_CAMERA_YAW_DEG);
    this._verticalVelocity = 0;
    this._isGrounded = true;
    this.runTime = 0;
    this._setSide("top");
    this.cameraRig.snapToTarget();
    this.state = "playing";
  }

  /** Figur schaut beim Start von der Kamera weg - in die Platine hinein. */
  _faceSpawnDirection() {
    const yaw = THREE.MathUtils.degToRad(SPAWN_CAMERA_YAW_DEG) + Math.PI;
    this.character.object3D.rotation.y = yaw;
    this.character._targetYaw = yaw;
  }

  /**
   * Markiert die Wechselzone auf der Unterseite. Auf der Oberseite ist IC9
   * selbst die Markierung.
   */
  _createPortalMarker() {
    const portal = this.portals.bottom;
    this.portalMarker = new PortalMarker({ radius: portal.radius });
    this.portalMarker.object3D.position.set(
      portal.position.x,
      this.board.sampleHeight("bottom", portal.position.x, portal.position.z) + 0.02,
      portal.position.z
    );
    this.scene.add(this.portalMarker.object3D);
  }

  /** Ein Rahmen pro Sensor, direkt auf dem Bauteil. */
  _createSensorMarkers() {
    for (const sensor of this.sensors) {
      const marker = new SensorMarker({ size: sensor.markerMm * WORLD_PER_MM });
      marker.object3D.visible = sensor.side === this.currentSide;
      // Unter dem Mausrad: Rahmen ueber der Baugruppe zeichnen, solange sie
      // durchscheinend ist (umgeschaltet in _updateEnterableParts).
      if (MOUSE_WHEEL.revealSensors.includes(sensor.id)) {
        marker.object3D.traverse((child) => {
          if (!child.isMesh) return;
          child.renderOrder = 3;
          this._revealMarkerMaterials.push(child.material);
        });
      }
      this.scene.add(marker.object3D);
      sensor.marker = marker;
    }
    this._placeSensorMarkers();
  }

  /**
   * Legt die Sensor-Rahmen auf die oberste Flaeche an ihrer Stelle. Haengt
   * davon ab, ob die Mausrad-Halterung da ist - deshalb neu, sobald sie aus-
   * oder wieder eingeblendet wird.
   */
  _placeSensorMarkers() {
    for (const sensor of this.sensors) {
      if (!sensor.marker) continue;
      const ground = this.board.sampleHeight(sensor.side, sensor.position.x, sensor.position.z);
      sensor.marker.object3D.position.set(
        sensor.position.x,
        (Number.isNaN(ground) ? sensor.position.y : ground) + 0.03,
        sensor.position.z
      );
    }
  }

  /** Rahmen fuer die Bauteile des Erkundungsmodus - bis dahin ausgeblendet. */
  _createComponentMarkers() {
    for (const part of this.components) {
      const marker = new SensorMarker({ size: part.sizeMm * WORLD_PER_MM });
      // Auf Platinenhoehe: der Rahmen umschliesst das Bauteil, statt darauf zu liegen.
      marker.object3D.position.set(part.position.x, this.levels[part.side].y + 0.03, part.position.z);
      marker.object3D.visible = false;
      this.scene.add(marker.object3D);
      part.marker = marker;
    }
  }

  _updateMarkerVisibility() {
    for (const sensor of this.sensors) {
      if (sensor.marker) sensor.marker.object3D.visible = sensor.side === this.currentSide;
    }
    for (const part of this.components) {
      if (part.marker) {
        part.marker.object3D.visible = this.mode === "explore" && part.side === this.currentSide;
      }
    }
  }

  /** Fade-to-Black, Teleport auf die andere Seite, Fade zurueck. */
  async _switchSide() {
    const target = OPPOSITE_SIDE[this.currentSide];
    this._isTransitioning = true;
    this._inPortalZone = false;

    await this.fadeOverlay.fadeOut();

    const portal = this.portals[target];
    this.character.position.set(portal.position.x, this.levels[target].y, portal.position.z);
    this.character.setMoveDirection(0, 0, 0);
    this._setSide(target);
    this.cameraRig.snapToTarget();

    await this.fadeOverlay.fadeIn();
    this._isTransitioning = false;
  }

  _setSide(side) {
    this.currentSide = side;
    this.board?.setVisibleSide(side);

    this._snapToGround();
    this._verticalVelocity = 0;
    this._isGrounded = true;

    if (this.portalMarker) this.portalMarker.visible = side === "bottom";
    this._updateMarkerVisibility();
  }
}

const formatPosition = (v) => `${v.x.toFixed(1)} / ${v.z.toFixed(1)}`;

const insideBox = (box, x, z, margin) =>
  x >= box.minX - margin && x <= box.maxX + margin && z >= box.minZ - margin && z <= box.maxZ + margin;
