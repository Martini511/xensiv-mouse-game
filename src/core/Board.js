import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  BOARD,
  BOARD_CENTER_MM,
  BOARD_MID_Y,
  CHARACTER_HEIGHT,
  ENTERABLE_CELL_MM,
  ENTERABLE_MIN_HEIGHT_MM,
  ENTERABLE_PARTS,
  MAX_GROUND_HEIGHT_MM,
  MODEL_ROTATION_X,
  MOUSE_WHEEL,
  OBSTACLE_HEIGHT_MM,
  PUSH_BUTTONS,
  PUSH_BUTTON_CAP_MM,
  PUSH_BUTTON_TRAVEL_MM,
  SCALE_FACTOR,
  SIDE_FLIP_Z,
  SLIDE_SWITCHES,
  STATUS_LEDS,
  STATUS_LED_COLOR,
  STATUS_LED_LENS_MATERIAL,
  WORLD_PER_MM,
  buildLevel,
} from "./level-config.js";

/** Attribute, die fuer die Darstellung gebraucht werden - der Rest fliegt raus. */
const KEPT_ATTRIBUTES = ["position", "normal", "uv"];

/** Kantenlaenge einer Zelle des Hoehenrasters (0.5 mm in Weltunits). */
export const HEIGHT_CELL_SIZE = WORLD_PER_MM * 0.5;

/**
 * So viele uebereinanderliegende Flaechen merkt sich eine Rasterzelle. Ohne
 * diese Schichten waere unter dem Display dessen Oberseite der "Boden" - man
 * koennte nicht darunter hindurchlaufen.
 */
const MAX_LAYERS = 6;

/** Flaechen, die dichter beieinander liegen, zaehlen als eine Schicht. */
const LAYER_MERGE = WORLD_PER_MM * 0.6;

/**
 * Kapselt das geladene Platinen-Modell:
 *  - bringt es in Weltkoordinaten (CAD Z-up, Meter -> Three.js Y-up, skaliert)
 *  - sortiert jedes Mesh nach Ober-/Unterseite
 *  - fasst alle Meshes je Seite und Material zu wenigen Batches zusammen
 *  - kippt die Platine um 180 Grad, wenn die Unterseite begangen wird
 *  - leitet aus der Geometrie Hindernisse und ein Hoehenraster ab
 *
 * Das Zusammenfassen (Merging) ist der entscheidende Performance-Hebel: das
 * CAD-Modell besteht aus Hunderten Einzel-Meshes, was pro Frame genauso viele
 * Draw-Calls bedeutet. Nach dem Merge bleibt pro Seite nur noch ein Batch je
 * Material uebrig. Die jeweils abgewandte Seite wird zusaetzlich komplett
 * ausgeblendet, damit sie weder gezeichnet noch fuer den Shadow-Pass
 * durchlaufen wird.
 */
export class Board {
  constructor(gltfScene) {
    this.object3D = new THREE.Group();
    this.object3D.name = "Platine";

    // Hilfs-Root, der die CAD->Welt-Transformation traegt. Sie wird beim Merge
    // in die Geometrien eingebacken, danach wird dieser Root verworfen.
    const source = new THREE.Group();
    source.rotation.x = MODEL_ROTATION_X;
    source.scale.setScalar(SCALE_FACTOR);
    // GLB ist in Metern, die Platinenmitte liegt nicht im CAD-Ursprung.
    const centered = new THREE.Group();
    centered.position.set(-BOARD_CENTER_MM.x / 1000, -BOARD_CENTER_MM.y / 1000, 0);
    centered.add(gltfScene);
    source.add(centered);
    source.updateMatrixWorld(true);

    const buckets = { top: new Map(), bottom: new Map(), shared: new Map() };
    const collision = {
      top: { obstacles: [], blockers: [], walkY: buildLevel("top").y },
      bottom: { obstacles: [], blockers: [], walkY: buildLevel("bottom").y },
    };
    // Die Unterseite wird beim Begehen um 180 Grad um Z gekippt - die
    // Kollisionsdaten muessen in derselben Orientierung vorliegen.
    const flip = new THREE.Matrix4().makeRotationZ(SIDE_FLIP_Z.bottom);
    const sideMatrix = new THREE.Matrix4();
    const obstacleHeight = OBSTACLE_HEIGHT_MM * WORLD_PER_MM;

    const worldBox = new THREE.Box3();
    const sideBox = new THREE.Box3();
    let sourceMeshes = 0;
    /** Kappen der Taster - beweglich, deshalb weder gebatcht noch im Hoehenraster. */
    const capParts = new Map();
    /** Hebel der Schiebeschalter - ebenso beweglich. */
    const leverParts = new Map();
    /** Meshes begehbarer Bauteile - bekommen statt der Box eine feine Kollision. */
    const enterableParts = new Map();
    /** Linsen der Status-LEDs: Konfiguration -> { material, box }. */
    const ledLenses = new Map();
    /** Meshes der Mausrad-Baugruppe: { object, rotating }. */
    const wheelParts = [];

    const processMesh = (object) => {
      worldBox.setFromObject(object);

      // LED-Linsen bekommen ein eigenes Material, damit nur diese LED leuchtet.
      // Sie bleiben im Batch (je LED einer) und damit im Hoehenraster.
      const led = matchStatusLedLens(object, worldBox);
      if (led) {
        if (!ledLenses.has(led)) {
          ledLenses.set(led, { material: object.material.clone(), box: new THREE.Box3() });
        }
        const lens = ledLenses.get(led);
        object.material = lens.material;
        lens.box.union(worldBox);
      }

      const button = matchPushButtonCap(worldBox);
      if (button) {
        if (!capParts.has(button)) capParts.set(button, []);
        capParts.get(button).push({ object, box: worldBox.clone() });
        return;
      }

      const enterable = matchEnterablePart(worldBox);
      if (enterable) {
        // Eigene Meshes statt Batch: das Bauteil wird transparent, wenn der
        // Chip drin steht, und hat keine grobe Hindernis-Box.
        if (!enterableParts.has(enterable)) enterableParts.set(enterable, []);
        enterableParts.get(enterable).push(object);
        return;
      }

      const side =
        worldBox.min.y >= BOARD_MID_Y
          ? "top"
          : worldBox.max.y <= BOARD_MID_Y
            ? "bottom"
            : "shared";

      // Mausrad-Baugruppe: Kollision wie jedes Bauteil, aber eigene Meshes,
      // weil sich das Rad dreht und alles ausblendet, wenn man an die
      // Sensoren darunter will.
      const wheelPart = mouseWheelPartOf(object);
      const partId = wheelPart ? MOUSE_WHEEL.id : undefined;

      // Bauteile, die das Substrat durchstossen, sind auf beiden Seiten da.
      for (const target of side === "shared" ? ["top", "bottom"] : [side]) {
        sideBox.copy(worldBox);
        if (target === "bottom") sideBox.applyMatrix4(flip);

        const footprint = {
          minX: sideBox.min.x,
          maxX: sideBox.max.x,
          minZ: sideBox.min.z,
          maxZ: sideBox.max.z,
          top: sideBox.max.y,
        };
        const bucket = collision[target];

        if (footprint.top <= bucket.walkY + obstacleHeight) continue;

        // Hoch genug, um die Kamera zu verdecken - auch reine Ueberhaenge wie
        // der ueberstehende Joystick-Kopf. Das Mausrad bekommt auf der
        // Oberseite feine Quader aus der Geometrie (siehe unten) - eine Box
        // ueber Halterung oder Rad schloesse den Blickpunkt ein, sobald die
        // Figur auf der Halterung steht.
        if (!(wheelPart && target === "top")) {
          bucket.blockers.push({
            id: partId,
            minX: footprint.minX,
            maxX: footprint.maxX,
            minZ: footprint.minZ,
            maxZ: footprint.maxZ,
            minY: sideBox.min.y,
            maxY: sideBox.max.y,
          });
        }

        // Ragt in Kopfhoehe hinein -> blockiert. Sonst schwebt es ueber dem
        // Kopf (z.B. der Joystick-Kopf) und wird ignoriert.
        if (sideBox.min.y >= bucket.walkY + CHARACTER_HEIGHT) continue;

        // Nur der Teil zaehlt, an dem der Chip wirklich anstoesst: hoeher als
        // die Stufengrenze (darunter steigt er hinauf) und nicht hoeher als
        // sein Kopf (darueber - etwa der Joystick-Kopf - laeuft er hindurch).
        sideMatrix.copy(object.matrixWorld);
        if (target === "bottom") sideMatrix.premultiply(flip);

        const blocking = bandFootprint(
          object,
          sideMatrix,
          bucket.walkY + obstacleHeight,
          bucket.walkY + obstacleHeight + CHARACTER_HEIGHT
        );
        if (blocking && !wheelPart?.static) {
          blocking.top = footprint.top;
          blocking.id = partId;
          bucket.obstacles.push(blocking);
        }
      }

      if (wheelPart) {
        wheelParts.push({ object, ...wheelPart });
        return;
      }

      // Mehrmaterial-Meshes haben Geometry-Groups und lassen sich nicht sinnvoll
      // batchen - die werden einzeln uebernommen.
      if (Array.isArray(object.material)) {
        buckets[side].set(`single_${sourceMeshes}`, {
          material: object.material,
          geometries: [bakeGeometry(object, false)],
        });
        return;
      }

      const geometry = bakeGeometry(object, true);
      const key = `${object.material.uuid}|${geometrySignature(geometry)}`;
      const existing = buckets[side].get(key);
      if (existing) {
        existing.geometries.push(geometry);
      } else {
        buckets[side].set(key, { material: object.material, geometries: [geometry] });
      }
    };

    source.traverse((object) => {
      if (!object.isMesh || !object.geometry) return;
      sourceMeshes++;

      // Taster aus einem einzigen Mesh (S1/S2 der Maus): die Kappe wird
      // abgetrennt, das Gehaeuse laeuft normal weiter.
      const split = splitPushButtonMesh(object);
      if (split) {
        if (!capParts.has(split.button)) capParts.set(split.button, []);
        capParts.get(split.button).push(split.cap);
        if (split.rest) processMesh(split.rest);
        return;
      }

      // Schiebeschalter: der Hebel wird abgetrennt und beweglich.
      const slide = splitSlideSwitchMesh(object);
      if (slide) {
        if (!leverParts.has(slide.config)) leverParts.set(slide.config, []);
        leverParts.get(slide.config).push(slide.lever);
        if (slide.rest) processMesh(slide.rest);
        return;
      }

      processMesh(object);
    });

    this.groups = {
      top: mergeBucket(buckets.top, "Oberseite"),
      bottom: mergeBucket(buckets.bottom, "Unterseite"),
      shared: mergeBucket(buckets.shared, "Durchgehend"),
    };
    this.object3D.add(this.groups.top, this.groups.bottom, this.groups.shared);

    /** Eigene Gruppen je Seite: das Hoehenraster liest nur die Batches oben. */
    this.buttonGroups = { top: new THREE.Group(), bottom: new THREE.Group() };
    this.buttonGroups.top.name = "Taster Oberseite";
    this.buttonGroups.bottom.name = "Taster Unterseite";
    this.object3D.add(this.buttonGroups.top, this.buttonGroups.bottom);
    this.pushButtons = buildPushButtons(capParts, this.buttonGroups, flip);
    this.slideSwitches = buildSlideSwitches(leverParts, this.buttonGroups, flip);
    this.statusLeds = buildStatusLeds(ledLenses, this.buttonGroups);

    /**
     * Mausrad: immer sichtbar, weil es durch den Ausschnitt auf beide Seiten
     * ragt. Ohne Hoehenraster - begehbar ist darauf nichts.
     */
    this.mouseWheel = buildMouseWheel(wheelParts);
    if (this.mouseWheel) this.object3D.add(this.mouseWheel.object3D);

    /**
     * Feine Kollision der begehbaren Bauteile: Quader mit Unter- und
     * Oberkante. Ein Quader ist nur dann Wand, wenn er die Figur auf ihrer
     * aktuellen Hoehe trifft - darunter hindurch und darauf geht.
     */
    this.solids = buildSolids(enterableParts, flip, collision);
    // Die Halterung des Mausrads ist eine Stufe: vorne eine flache Platte,
    // hinten zwei hohe Tuerme. Eine einzige Box ueber alles waere ueberall
    // so hoch wie die Tuerme - deshalb dieselbe feine Kollision wie P1/P2.
    const holderMeshes = wheelParts
      .filter((part) => part.static || MOUSE_WHEEL.walkableRotating?.includes(part.name))
      .map((part) => part.object);
    if (holderMeshes.length) {
      const holder = buildSolids(
        new Map([[{ id: MOUSE_WHEEL.id, side: "top" }, holderMeshes]]),
        flip,
        collision
      );
      this.solids.top.push(...holder.top);
    }
    // Rad und Nabe: dieselben feinen Quader - als Wand fuer die Figur (das
    // grobe Hindernis gilt nur auf Platinenhoehe, oben auf der Halterung ragt
    // das runde Rad weiter vor) und als Kamera-Blocker. Sie sind rund, die
    // Lage in Ruhe genuegt auch beim Drehen.
    const wheelMeshes = wheelParts
      .filter((part) => part.rotating && !MOUSE_WHEEL.walkableRotating?.includes(part.name))
      .map((part) => part.object);
    if (wheelMeshes.length) {
      const wheel = buildSolids(
        new Map([[{ id: MOUSE_WHEEL.rotorId, side: "top" }, wheelMeshes]]),
        flip,
        collision
      );
      this.solids.top.push(...wheel.top);
    }
    for (const side of ["top", "bottom"]) {
      computeHeadroom(this.solids[side]);
      for (const box of this.solids[side]) {
        if (box.top > collision[side].walkY + obstacleHeight) {
          collision[side].blockers.push({ ...box, minY: box.bottom, maxY: box.top });
        }
      }
    }

    /** Begehbare Bauteile als eigene Meshes - gehen ins Hoehenraster mit ein. */
    this.enterableGroups = { top: new THREE.Group(), bottom: new THREE.Group() };
    this.enterableGroups.top.name = "Begehbar Oberseite";
    this.enterableGroups.bottom.name = "Begehbar Unterseite";
    this.object3D.add(this.enterableGroups.top, this.enterableGroups.bottom);
    /** id -> eigene Materialien, damit nur dieses Bauteil ausgeblendet wird. */
    this.enterableMaterials = new Map();
    for (const [part, meshes] of enterableParts) {
      const materials = new Map();
      for (const mesh of meshes) {
        const own = Array.isArray(mesh.material)
          ? mesh.material.map((m) => cloneOnce(materials, m))
          : cloneOnce(materials, mesh.material);
        this.enterableGroups[part.side].add(createBatch(bakeGeometry(mesh, false), own));
      }
      this.enterableMaterials.set(part.id, [...materials.values()]);
    }
    // Das Mausrad blendet ueber denselben Weg aus wie die begehbaren Bauteile -
    // Halterung und drehende Teile getrennt.
    if (this.mouseWheel) {
      this.enterableMaterials.set(MOUSE_WHEEL.id, this.mouseWheel.holderMaterials);
      this.enterableMaterials.set(MOUSE_WHEEL.rotorId, this.mouseWheel.rotorMaterials);
    }

    disposeSource(source);

    this.boundingBox = new THREE.Box3().setFromObject(this.object3D);
    this.size = this.boundingBox.getSize(new THREE.Vector3());

    // Zwei Fassungen der Kollision: mit und ohne Mausrad-Baugruppe (die
    // verschwindet je nach Schalterstellung). Getrennt ausgeduennt, weil eine
    // Mausrad-Box sonst kleinere Boxen darin "verschluckt" haette.
    const isWheelBox = (box) => box.id === MOUSE_WHEEL.id || box.id === MOUSE_WHEEL.rotorId;
    const withoutWheel = (boxes) => boxes.filter((box) => !isWheelBox(box));
    this._collisionSets = {
      withWheel: {
        obstacles: {
          top: dropContained(collision.top.obstacles),
          bottom: dropContained(collision.bottom.obstacles),
        },
        cameraBlockers: {
          top: dropContained3D(collision.top.blockers),
          bottom: dropContained3D(collision.bottom.blockers),
        },
        solids: this.solids,
      },
      withoutWheel: {
        obstacles: {
          top: dropContained(withoutWheel(collision.top.obstacles)),
          bottom: dropContained(withoutWheel(collision.bottom.obstacles)),
        },
        cameraBlockers: {
          top: dropContained3D(withoutWheel(collision.top.blockers)),
          bottom: dropContained3D(withoutWheel(collision.bottom.blockers)),
        },
        solids: { top: withoutWheel(this.solids.top), bottom: withoutWheel(this.solids.bottom) },
      },
    };
    this.setMouseWheelVisible(true);

    this.heightFields = {
      top: buildHeightField(
        [this.groups.top, this.groups.shared, this.enterableGroups.top],
        new THREE.Matrix4(),
        this.boundingBox,
        collision.top.walkY
      ),
      bottom: buildHeightField(
        [this.groups.bottom, this.groups.shared, this.enterableGroups.bottom],
        flip,
        this.boundingBox,
        collision.bottom.walkY
      ),
    };
    // Die Halterung des Mausrads ist begehbar (Dach und Bruecke), sie steht
    // auf der Oberseite. Das drehende Rad bleibt ein reines Hindernis. Eigenes
    // Raster, damit sie samt Baugruppe verschwinden kann.
    this.wheelHeightField = this.mouseWheel
      ? buildHeightField(
          [this.mouseWheel.holder],
          new THREE.Matrix4(),
          geometryBounds(this.mouseWheel.holder),
          collision.top.walkY
        )
      : null;

    console.log(
      `[Platine] ${sourceMeshes} Meshes zu ${this.drawCallCount} Batches zusammengefasst ` +
        `(Oberseite ${this.groups.top.children.length}, Unterseite ${this.groups.bottom.children.length}, ` +
        `durchgehend ${this.groups.shared.children.length}).`
    );
    console.log(
      `[Platine] Hindernisse ab ${OBSTACLE_HEIGHT_MM} mm Hoehe - ` +
        `Oberseite ${this.obstacles.top.length}, Unterseite ${this.obstacles.bottom.length} Boxen; ` +
        `Kamera-Blocker ${this.cameraBlockers.top.length} / ${this.cameraBlockers.bottom.length}.`
    );
  }

  get drawCallCount() {
    return (
      this.groups.top.children.length +
      this.groups.bottom.children.length +
      this.groups.shared.children.length
    );
  }

  /**
   * Hoechste begehbare Flaeche an dieser Stelle, die nicht ueber `maxY` liegt.
   * Die Grenze waehlt zwischen den Schichten: unter dem Display liefert sie
   * die Platine, oben darauf die Display-Oberseite. NaN, wenn nichts passt.
   */
  sampleHeight(side, x, z, maxY = Infinity) {
    const base = cellBase(this.heightFields[side], x, z);
    if (base < 0) return NaN;

    let height = NaN;
    const consider = (value) => {
      if (Number.isNaN(value) || value > maxY) return;
      if (Number.isNaN(height) || value > height) height = value;
    };

    const data = this.heightFields[side].data;
    for (let k = 0; k < MAX_LAYERS; k++) consider(data[base + k]);

    const wheelField = this._wheelFieldFor(side);
    const wheelBase = wheelField ? cellBase(wheelField, x, z) : -1;
    if (wheelBase >= 0) {
      for (let k = 0; k < MAX_LAYERS; k++) consider(wheelField.data[wheelBase + k]);
    }

    // Tasterkappen stehen nicht im Raster - ihre Hoehe haengt vom Druck ab.
    const button = this.pushButtonAt(side, x, z);
    if (button) {
      const value = button.top - button.depth;
      if (value <= maxY && (Number.isNaN(height) || value > height)) height = value;
    }

    // Ebenso die Hebel der Schiebeschalter - sie liegen je nach Stellung woanders.
    // Unter dem ganzen Verfahrweg liegt der Schlitzboden; sonst bliebe dort,
    // wo der Hebel vorher stand, ein Loch bis zur Platine.
    for (const lever of this.slideSwitches) {
      if (lever.side !== side) continue;
      const slot = lever.slot;
      if (x >= slot.minX && x <= slot.maxX && z >= slot.minZ && z <= slot.maxZ) {
        if (lever.bottom <= maxY && (Number.isNaN(height) || lever.bottom > height)) height = lever.bottom;
      }
      const box = this.slideSwitchBox(lever);
      if (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ) continue;
      if (box.top <= maxY && (Number.isNaN(height) || box.top > height)) height = box.top;
    }

    return height;
  }

  /**
   * Grundriss und Oberkante eines Schalterhebels in seiner aktuellen Stellung,
   * in der Orientierung seiner Seite - wie die Hindernis-Boxen.
   */
  slideSwitchBox(lever) {
    const shift = lever.offsetMm * WORLD_PER_MM * lever.sideSign;
    return {
      id: lever.id,
      minX: lever.minX + shift,
      maxX: lever.maxX + shift,
      minZ: lever.minZ,
      maxZ: lever.maxZ,
      top: lever.top,
      bottom: lever.bottom,
    };
  }

  /** Schiebt einen Schalterhebel auf `offsetMm` (CAD-x) gegenueber der Ausgangslage. */
  setSlideSwitchOffset(lever, offsetMm) {
    lever.offsetMm = offsetMm;
    // Im ungekippten Modell laeuft CAD-x in Welt-x - unabhaengig von der Seite.
    lever.object3D.position.x = offsetMm * WORLD_PER_MM;
  }

  /** Helligkeit einer Status-LED, 0 = aus, 1 = voll. */
  setStatusLedLevel(led, level) {
    if (led.level === level) return;
    led.level = level;
    led.material.color.copy(led.offColor).lerp(led.onColor, level);
    led.material.emissiveIntensity = level * 1.6;
    led.glow.material.opacity = level * 0.7;
    led.glow.visible = level > 0.01;
  }

  /** Tasterkappe, die an dieser Stelle liegt - oder null. */
  pushButtonAt(side, x, z) {
    for (const button of this.pushButtons) {
      if (
        button.side === side &&
        x >= button.minX &&
        x <= button.maxX &&
        z >= button.minZ &&
        z <= button.maxZ
      ) {
        return button;
      }
    }
    return null;
  }

  /** Drueckt eine Tasterkappe um `depth` Weltunits ein (0 = Ruhelage). */
  setPushButtonDepth(button, depth) {
    button.depth = depth;
    // Im ungekippten Modell zeigt die Unterseite nach -Y: Eindruecken heisst
    // dort +Y, also Richtung Platine.
    button.object3D.position.y = button.side === "bottom" ? depth : -depth;
  }

  /**
   * Ob hier ueberhaupt Platine liegt - unabhaengig von der Hoehe. Nur wo das
   * nicht gilt, faellt der Charakter herunter.
   */
  hasGround(side, x, z) {
    // Schichten werden luckenlos von unten aufgefuellt: Slot 0 leer = Zelle leer.
    const base = cellBase(this.heightFields[side], x, z);
    if (base >= 0 && !Number.isNaN(this.heightFields[side].data[base])) return true;
    const wheelField = this._wheelFieldFor(side);
    const wheelBase = wheelField ? cellBase(wheelField, x, z) : -1;
    return wheelBase >= 0 && !Number.isNaN(wheelField.data[wheelBase]);
  }

  /** Raster der Mausrad-Halterung - nur oben und nur, solange sie da ist. */
  _wheelFieldFor(side) {
    return side === "top" && this.mouseWheelVisible ? this.wheelHeightField : null;
  }

  /**
   * Blendet die Mausrad-Baugruppe aus der Kollision aus bzw. wieder ein:
   * Hindernisse, Kamera-Blocker, feine Quader und die begehbare Halterung.
   * Das sichtbare Ein-/Ausblenden regelt Game ueber setPartOpacity().
   */
  setMouseWheelVisible(visible) {
    this.mouseWheelVisible = visible;
    const set = visible ? this._collisionSets.withWheel : this._collisionSets.withoutWheel;
    this.obstacles = set.obstacles;
    this.cameraBlockers = set.cameraBlockers;
    this.solids = set.solids;
  }

  /** Blendet die abgewandte Seite aus und kippt die Platine passend. */
  setVisibleSide(side) {
    this.groups.top.visible = side === "top";
    this.groups.bottom.visible = side === "bottom";
    this.buttonGroups.top.visible = side === "top";
    this.buttonGroups.bottom.visible = side === "bottom";
    this.enterableGroups.top.visible = side === "top";
    this.enterableGroups.bottom.visible = side === "bottom";
    this.object3D.rotation.z = SIDE_FLIP_Z[side];
  }

  /** Deckkraft eines begehbaren Bauteils (1 = normal). */
  setPartOpacity(id, opacity) {
    for (const material of this.enterableMaterials.get(id) ?? []) {
      const transparent = opacity < 0.999;
      if (material.transparent !== transparent) {
        material.transparent = transparent;
        // Durchscheinend darf es nichts dahinter aus dem Tiefenpuffer verdraengen.
        material.depthWrite = !transparent;
        material.needsUpdate = true;
      }
      material.opacity = opacity;
    }
  }

  /** Dreht das Mausrad auf `angle` (Radiant, um CAD-x). */
  setMouseWheelAngle(angle) {
    if (!this.mouseWheel) return;
    this.mouseWheel.angle = angle;
    this.mouseWheel.pivot.rotation.x = angle;
  }

  /** Drueckt Rad, Nabe und Achse um `depthMm` nach unten (Mausrad-Klick). */
  setMouseWheelDepth(depthMm) {
    if (!this.mouseWheel) return;
    this.mouseWheel.depth = depthMm;
    // Ungekippt zeigt CAD-z nach Welt +y: nach unten = zur Platine = -y.
    this.mouseWheel.press.position.y = -depthMm * WORLD_PER_MM;
  }
}

/** Klont ein Material nur einmal je Bauteil. */
function cloneOnce(cache, material) {
  if (!cache.has(material)) cache.set(material, material.clone());
  return cache.get(material);
}

/** Index der ersten Schicht einer Zelle im Raster, oder -1 ausserhalb. */
function cellBase(field, x, z) {
  const col = Math.floor((x - field.minX) / HEIGHT_CELL_SIZE);
  const row = Math.floor((z - field.minZ) / HEIGHT_CELL_SIZE);
  if (col < 0 || row < 0 || col >= field.cols || row >= field.rows) return -1;
  return (row * field.cols + col) * MAX_LAYERS;
}

/** Huelle der (bereits in Weltkoordinaten gebackenen) Geometrien einer Gruppe. */
function geometryBounds(group) {
  const bounds = new THREE.Box3();
  for (const mesh of group.children) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    bounds.union(mesh.geometry.boundingBox);
  }
  return bounds;
}

/** CAD-mm -> ungekippte Welt (Platine auf BOARD_CENTER_MM zentriert). */
const worldX = (xMm) => (xMm - BOARD_CENTER_MM.x) * WORLD_PER_MM;
const worldZ = (yMm) => -(yMm - BOARD_CENTER_MM.y) * WORLD_PER_MM;

/** Abstand zur Platinenoberflaeche der Seite, auf der der Taster sitzt (Weltunits). */
const distanceFromBoard = (side, y) =>
  side === "bottom" ? BOARD.bottomSurfaceZ * WORLD_PER_MM - y : y - BOARD.topSurfaceZ * WORLD_PER_MM;

/** Taster, ueber dessen Mitte die Box liegt - oder null. */
function pushButtonUnder(box) {
  const tolerance = 0.8 * WORLD_PER_MM;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;

  return (
    PUSH_BUTTONS.find(
      (button) =>
        Math.abs(centerX - worldX(button.x)) <= tolerance &&
        Math.abs(centerZ - worldZ(button.y)) <= tolerance
    ) ?? null
  );
}

/**
 * Ordnet ein Mesh einem Taster aus PUSH_BUTTONS zu, wenn es dessen Kappe ist:
 * Mitte ueber dem Taster, mit Abstand zur Platine und weit herausragend - das
 * Gehaeuse samt Deckblechen bleibt Teil des Batches.
 * Gerechnet wird im ungekippten Modell (Welt = CAD (x - cx, z, cy - y) * Massstab).
 */
function matchPushButtonCap(box) {
  const button = pushButtonUnder(box);
  if (!button) return null;

  // Abstand der Innen- und Aussenseite des Teils zur Platinenoberflaeche
  const [inner, outer] =
    button.side === "bottom"
      ? [distanceFromBoard("bottom", box.max.y), distanceFromBoard("bottom", box.min.y)]
      : [distanceFromBoard("top", box.min.y), distanceFromBoard("top", box.max.y)];
  return inner >= PUSH_BUTTON_CAP_MM.gap * WORLD_PER_MM &&
    outer >= PUSH_BUTTON_CAP_MM.top * WORLD_PER_MM
    ? button
    : null;
}

/**
 * Taster, deren Gehaeuse und Kappe im CAD ein einziges Mesh sind (S1/S2 der
 * Maus): alle Dreiecke, die ueber PUSH_BUTTON_CAP_MM.gap hinausragen, bilden
 * die Kappe - auch ihre Seitenwaende, die direkt am Gehaeusedeckel ansetzen.
 * Der Rest (Gehaeuse, Abstandshalter an den Ecken) bleibt stehen.
 *
 * @returns {{button, cap: {object, box}, rest: THREE.Mesh|null}|null}
 */
function splitPushButtonMesh(object) {
  if (Array.isArray(object.material)) return null;

  const box = new THREE.Box3().setFromObject(object);
  const button = pushButtonUnder(box);
  if (!button) return null;

  const outer = Math.max(
    distanceFromBoard(button.side, box.min.y),
    distanceFromBoard(button.side, box.max.y)
  );
  const inner = Math.min(
    distanceFromBoard(button.side, box.min.y),
    distanceFromBoard(button.side, box.max.y)
  );
  // Reine Kappe oder gar kein Taster-Mesh: das regelt matchPushButtonCap().
  if (outer < PUSH_BUTTON_CAP_MM.top * WORLD_PER_MM || inner >= PUSH_BUTTON_CAP_MM.gap * WORLD_PER_MM) {
    return null;
  }

  const split = splitMeshAbove(object, button.side, PUSH_BUTTON_CAP_MM.gap);
  return split && { button, cap: split.upper, rest: split.lower };
}

/**
 * Schiebeschalter (S3): der Hebel ist im CAD Teil des Gehaeuse-Meshes und
 * wird hier abgetrennt - alles, was ueber `leverMm` hinausragt.
 *
 * @returns {{config, lever: {object, box}, rest: THREE.Mesh|null}|null}
 */
function splitSlideSwitchMesh(object) {
  if (Array.isArray(object.material)) return null;

  const box = new THREE.Box3().setFromObject(object);
  const tolerance = 1.5 * WORLD_PER_MM;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;
  const config = SLIDE_SWITCHES.find(
    (entry) =>
      Math.abs(centerX - worldX(entry.x)) <= tolerance &&
      Math.abs(centerZ - worldZ(entry.y)) <= tolerance
  );
  if (!config) return null;

  const split = splitMeshAbove(object, config.side, config.leverMm);
  return split && { config, lever: split.upper, rest: split.lower };
}

/**
 * Teilt ein Mesh in die Dreiecke, die weiter als `thresholdMm` ueber die
 * Platine ragen (`upper`), und den Rest (`lower`). Beide werden zu eigenen
 * Meshes mit der Welt-Matrix des Originals. null, wenn nichts so weit ragt.
 */
function splitMeshAbove(object, side, thresholdMm) {
  const threshold = thresholdMm * WORLD_PER_MM;
  const source = object.geometry.index ? object.geometry.toNonIndexed() : object.geometry;
  const position = source.attributes.position;
  const vertex = new THREE.Vector3();
  const upperTriangles = [];
  const lowerTriangles = [];

  for (let i = 0; i < position.count; i += 3) {
    let isUpper = false;
    for (let k = 0; k < 3; k++) {
      vertex.fromBufferAttribute(position, i + k).applyMatrix4(object.matrixWorld);
      if (distanceFromBoard(side, vertex.y) > threshold) isUpper = true;
    }
    (isUpper ? upperTriangles : lowerTriangles).push(i);
  }
  if (upperTriangles.length === 0) {
    if (source !== object.geometry) source.dispose();
    return null;
  }

  const toMesh = (triangles) => {
    const geometry = new THREE.BufferGeometry();
    for (const name of KEPT_ATTRIBUTES) {
      const attribute = source.attributes[name];
      if (!attribute) continue;
      const size = attribute.itemSize;
      const array = new Float32Array(triangles.length * 3 * size);
      triangles.forEach((start, t) => {
        for (let k = 0; k < 3; k++) {
          for (let c = 0; c < size; c++) {
            array[(t * 3 + k) * size + c] = attribute.getComponent(start + k, c);
          }
        }
      });
      geometry.setAttribute(name, new THREE.BufferAttribute(array, size));
    }

    const mesh = new THREE.Mesh(geometry, object.material);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(object.matrixWorld);
    mesh.matrixWorld.copy(object.matrixWorld);
    return mesh;
  };

  const upper = toMesh(upperTriangles);
  const lower = lowerTriangles.length ? toMesh(lowerTriangles) : null;
  if (source !== object.geometry) source.dispose();
  return { upper: { object: upper, box: new THREE.Box3().setFromObject(upper) }, lower };
}

/**
 * Ordnet ein Mesh einem begehbaren Bauteil zu, wenn es komplett in dessen
 * CAD-Rechteck liegt und merklich ueber die Platine ragt. Flache Loetpads
 * bleiben Teil der Platine - durchscheinend wuerden sie mit der
 * Platinenoberflaeche flackern.
 */
function matchEnterablePart(box) {
  for (const part of ENTERABLE_PARTS) {
    const onSide = part.side === "bottom" ? box.max.y <= BOARD_MID_Y : box.min.y >= BOARD_MID_Y;
    const height =
      part.side === "bottom"
        ? BOARD.bottomSurfaceZ * WORLD_PER_MM - box.min.y
        : box.max.y - BOARD.topSurfaceZ * WORLD_PER_MM;
    if (
      onSide &&
      height >= ENTERABLE_MIN_HEIGHT_MM * WORLD_PER_MM &&
      box.min.x >= worldX(part.minX) &&
      box.max.x <= worldX(part.maxX) &&
      box.min.z >= worldZ(part.maxY) &&
      box.max.z <= worldZ(part.minY)
    ) {
      return part;
    }
  }
  return null;
}

/**
 * Zerlegt begehbare Bauteile in Quader. Je Rasterzelle wird ein senkrechter
 * Strahl durch jedes Mesh geschickt; die Schnitthoehen paarweise ergeben die
 * Abschnitte, in denen Material ist (geschlossene CAD-Solids vorausgesetzt).
 * Benachbarte Zellen mit gleichen Abschnitten werden zu Rechtecken vereint.
 *
 * Ergebnis in der Orientierung der jeweiligen Seite (+Y = weg von der Platine).
 */
function buildSolids(enterableParts, flip, collision) {
  const solids = { top: [], bottom: [] };
  const cell = ENTERABLE_CELL_MM * WORLD_PER_MM;
  // Abschnitte duenner als das zaehlen nicht - Rundungsrauschen.
  const minThickness = WORLD_PER_MM * 0.05;
  const quantum = WORLD_PER_MM * 0.02;

  const matrix = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  for (const [part, meshes] of enterableParts) {
    const walkY = collision[part.side].walkY;
    /** Zellschluessel -> Liste [unten, oben] ueber alle Meshes. */
    const cells = new Map();

    for (const mesh of meshes) {
      matrix.copy(mesh.matrixWorld);
      if (part.side === "bottom") matrix.premultiply(flip);

      const position = mesh.geometry.attributes.position;
      const index = mesh.geometry.index;
      const count = index ? index.count : position.count;
      const hits = new Map();

      for (let i = 0; i < count; i += 3) {
        a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
        b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix);
        c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix);

        const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
        if (Math.abs(area) < 1e-12) continue;

        const col0 = Math.floor(Math.min(a.x, b.x, c.x) / cell);
        const col1 = Math.floor(Math.max(a.x, b.x, c.x) / cell);
        const row0 = Math.floor(Math.min(a.z, b.z, c.z) / cell);
        const row1 = Math.floor(Math.max(a.z, b.z, c.z) / cell);

        for (let col = col0; col <= col1; col++) {
          // Kleiner Versatz, damit kein Strahl genau eine Dreieckskante trifft.
          const px = (col + 0.5) * cell + 1.3e-6;
          for (let row = row0; row <= row1; row++) {
            const pz = (row + 0.5) * cell + 0.7e-6;
            const w0 = ((b.x - px) * (c.z - pz) - (c.x - px) * (b.z - pz)) / area;
            if (w0 < 0 || w0 > 1) continue;
            const w1 = ((c.x - px) * (a.z - pz) - (a.x - px) * (c.z - pz)) / area;
            if (w1 < 0 || w1 > 1) continue;
            const w2 = 1 - w0 - w1;
            if (w2 < 0) continue;

            const key = `${col},${row}`;
            if (!hits.has(key)) hits.set(key, []);
            hits.get(key).push(w0 * a.y + w1 * b.y + w2 * c.y);
          }
        }
      }

      for (const [key, heights] of hits) {
        heights.sort((u, v) => u - v);
        if (!cells.has(key)) cells.set(key, []);
        for (let k = 0; k + 1 < heights.length; k += 2) {
          const bottom = Math.max(heights[k], walkY);
          const top = heights[k + 1];
          if (top - bottom >= minThickness) cells.get(key).push([bottom, top]);
        }
      }
    }

    // Gleiche (gerundete) Abschnitte sammeln und je Abschnitt zu Rechtecken mergen.
    const byInterval = new Map();
    for (const [key, intervals] of cells) {
      const [col, row] = key.split(",").map(Number);
      for (const [bottom, top] of mergeIntervals(intervals)) {
        const id = `${Math.round(bottom / quantum)}|${Math.round(top / quantum)}`;
        if (!byInterval.has(id)) byInterval.set(id, { bottom, top, cells: [] });
        const entry = byInterval.get(id);
        entry.bottom = Math.min(entry.bottom, bottom);
        entry.top = Math.max(entry.top, top);
        entry.cells.push([col, row]);
      }
    }

    let boxCount = 0;
    for (const { bottom, top, cells: list } of byInterval.values()) {
      for (const rect of mergeCellRects(list)) {
        solids[part.side].push({
          id: part.id,
          minX: rect.col0 * cell,
          maxX: (rect.col1 + 1) * cell,
          minZ: rect.row0 * cell,
          maxZ: (rect.row1 + 1) * cell,
          bottom,
          top,
        });
        boxCount++;
      }
    }
    console.log(`[Platine] ${part.id} begehbar: ${meshes.length} Meshes, ${boxCount} Kollisionsquader.`);
  }

  return solids;
}

/**
 * Platz ueber der Oberseite jedes Quaders bis zum naechsten Quader darueber
 * (`headroom`, Infinity = frei). Passt der Chip dort nicht hin, ist die
 * Oberseite keine Stufe, sondern Wand - z.B. die Kante an der Oeffnung von J3
 * direkt unter dem Ueberhang.
 */
function computeHeadroom(boxes) {
  const epsilon = WORLD_PER_MM * 0.02;
  for (const box of boxes) {
    let headroom = Infinity;
    for (const other of boxes) {
      if (other === box || other.bottom < box.top - epsilon) continue;
      if (
        other.minX < box.maxX &&
        other.maxX > box.minX &&
        other.minZ < box.maxZ &&
        other.maxZ > box.minZ
      ) {
        headroom = Math.min(headroom, other.bottom - box.top);
      }
    }
    box.headroom = headroom;
  }
}

/** Vereint ueberlappende Abschnitte [unten, oben]. */
function mergeIntervals(intervals) {
  const sorted = [...intervals].sort((u, v) => u[0] - v[0]);
  const merged = [];
  for (const [bottom, top] of sorted) {
    const last = merged[merged.length - 1];
    if (last && bottom <= last[1]) last[1] = Math.max(last[1], top);
    else merged.push([bottom, top]);
  }
  return merged;
}

/**
 * Fasst Rasterzellen zu moeglichst wenigen Rechtecken zusammen: erst Laeufe
 * je Zeile, dann gleich breite Laeufe uebereinanderliegender Zeilen.
 */
function mergeCellRects(cells) {
  const rows = new Map();
  for (const [col, row] of cells) {
    if (!rows.has(row)) rows.set(row, []);
    rows.get(row).push(col);
  }

  const open = new Map();
  const rects = [];
  for (const row of [...rows.keys()].sort((u, v) => u - v)) {
    const cols = rows.get(row).sort((u, v) => u - v);
    const runs = [];
    let start = cols[0];
    for (let k = 1; k <= cols.length; k++) {
      if (k === cols.length || cols[k] !== cols[k - 1] + 1) {
        runs.push([start, cols[k - 1]]);
        start = cols[k];
      }
    }

    const next = new Map();
    for (const [col0, col1] of runs) {
      const key = `${col0},${col1}`;
      const rect = open.get(key);
      if (rect && rect.row1 === row - 1) {
        rect.row1 = row;
        next.set(key, rect);
        open.delete(key);
      } else {
        const created = { col0, col1, row0: row, row1: row };
        rects.push(created);
        next.set(key, created);
      }
    }
    open.clear();
    for (const [key, rect] of next) open.set(key, rect);
  }
  return rects;
}

/**
 * Baut aus den gefundenen Kappen je Taster ein eigenes, bewegliches Objekt.
 * Grundriss und Oberkante stehen - wie Hindernisse und Hoehenraster - in der
 * Orientierung der jeweiligen Seite.
 */
function buildPushButtons(capParts, groups, flip) {
  const buttons = [];
  const sideBox = new THREE.Box3();

  for (const config of PUSH_BUTTONS) {
    const parts = capParts.get(config);
    if (!parts) {
      console.warn(`[Platine] Kappe von Taster ${config.id} nicht gefunden.`);
      continue;
    }

    const object3D = new THREE.Group();
    object3D.name = `Taster ${config.id}`;
    const footprint = new THREE.Box3();

    for (const { object, box } of parts) {
      object3D.add(createBatch(bakeGeometry(object, false), object.material));
      sideBox.copy(box);
      if (config.side === "bottom") sideBox.applyMatrix4(flip);
      footprint.union(sideBox);
    }

    groups[config.side].add(object3D);
    buttons.push({
      id: config.id,
      label: config.label,
      side: config.side,
      minX: footprint.min.x,
      maxX: footprint.max.x,
      minZ: footprint.min.z,
      maxZ: footprint.max.z,
      /** Oberkante der Kappe in Ruhelage. */
      top: footprint.max.y,
      travel: PUSH_BUTTON_TRAVEL_MM * WORLD_PER_MM,
      depth: 0,
      object3D,
    });
  }

  return buttons;
}

/**
 * Gehoert das Mesh zur Mausrad-Baugruppe? Liefert dann den Namen des Teils
 * (Unterbaugruppe direkt unter der Baugruppe) und ob es sich dreht.
 */
function mouseWheelPartOf(object) {
  let part = null;
  for (let node = object; node; node = node.parent) {
    if (node.parent?.name === MOUSE_WHEEL.assembly) part = node.name;
    if (node.name === MOUSE_WHEEL.assembly) {
      if (!part) return null;
      const rotating = MOUSE_WHEEL.rotating.includes(part);
      return { name: part, rotating, static: !rotating };
    }
  }
  return null;
}

/**
 * Baut das Mausrad: die drehenden Teile haengen an einem Drehpunkt auf der
 * Radachse, die Halterung steht fest. Jedes Teil bekommt ein eigenes
 * Material, damit sich die Baugruppe ausblenden laesst, ohne gleichfarbige
 * Bauteile der Platine mitzunehmen.
 */
function buildMouseWheel(parts) {
  if (!parts.length) return null;

  const object3D = new THREE.Group();
  object3D.name = "Mausrad";

  // Achse parallel zu CAD-x - im ungekippten Modell also parallel zu Welt-x.
  // `press` verschiebt die drehenden Teile beim Mausrad-Klick nach unten.
  const press = new THREE.Group();
  press.name = "Mausrad Klick";
  object3D.add(press);
  const pivot = new THREE.Group();
  pivot.name = "Mausrad drehend";
  pivot.position.set(0, MOUSE_WHEEL.axisMm.z * WORLD_PER_MM, worldZ(MOUSE_WHEEL.axisMm.y));
  const rotating = new THREE.Group();
  rotating.position.copy(pivot.position).negate();
  pivot.add(rotating);
  press.add(pivot);
  // Feste Teile (Halterung) in eigener Gruppe - die geht ins Hoehenraster und
  // ist damit begehbar; das drehende Rad nicht.
  const holder = new THREE.Group();
  holder.name = "Mausrad Halterung";
  object3D.add(holder);

  const materials = new Map();
  const rotorNames = new Set();
  let rotatingCount = 0;
  for (const { object, name, rotating: turns } of parts) {
    if (turns) rotorNames.add(name);
    const material = wheelPartMaterial(materials, name, object.material);
    let geometry = bakeGeometry(object, false);
    const magnet = MOUSE_WHEEL.looks?.[name]?.magnet;
    if (magnet) geometry = paintMagnetPoles(geometry, magnet);
    const mesh = createBatch(geometry, material);
    // Durchscheinend soll man Rad und Halterung trotzdem als Koerper lesen.
    mesh.receiveShadow = false;
    // Innen vor aussen zeichnen (siehe MOUSE_WHEEL.rotorDrawOrder). Unter 1,
    // damit sich gegenueber dem Rest der Szene nichts verschiebt.
    const drawIndex = turns ? MOUSE_WHEEL.rotorDrawOrder?.indexOf(name) ?? -1 : -1;
    if (drawIndex >= 0) mesh.renderOrder = (drawIndex + 1) * 0.1;
    (turns ? rotating : holder).add(mesh);
    if (turns) rotatingCount++;
    // Begehbare drehende Teile (Achse): unsichtbare Kopie in Ruhelage, damit
    // sie im Hoehenraster als Boden auftaucht.
    if (turns && MOUSE_WHEEL.walkableRotating?.includes(name)) {
      const ground = new THREE.Mesh(mesh.geometry, material);
      ground.visible = false;
      holder.add(ground);
    }
  }

  console.log(
    `[Platine] Mausrad: ${parts.length} Meshes, davon ${rotatingCount} drehend ` +
      `(Achse y ${MOUSE_WHEEL.axisMm.y} / z ${MOUSE_WHEEL.axisMm.z} mm).`
  );
  const byPart = (rotor) =>
    [...materials.entries()].filter(([name]) => rotorNames.has(name) === rotor).map(([, m]) => m);
  return {
    object3D,
    pivot,
    press,
    holder,
    holderMaterials: byPart(false),
    rotorMaterials: byPart(true),
    angle: 0,
    depth: 0,
  };
}

/**
 * Faerbt den diametral polarisierten Magneten: Die Trennebene enthaelt die
 * Drehachse (CAD-x); alles auf der einen Seite ist Nordpol, der Rest
 * Suedpol. Gefaerbt wird je Dreieck nach dessen Schwerpunkt, damit die
 * Grenze scharf bleibt statt zu verlaufen. Die Geometrie liegt im
 * ungekippten Modell (Welt-y = CAD-z).
 */
function paintMagnetPoles(source, { north, south, splitDeg = 0 }) {
  const geometry = source.index ? source.toNonIndexed() : source;
  if (geometry !== source) source.dispose();

  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  const northColor = new THREE.Color(north);
  const southColor = new THREE.Color(south);
  const axisY = MOUSE_WHEEL.axisMm.z * WORLD_PER_MM;
  const axisZ = worldZ(MOUSE_WHEEL.axisMm.y);
  // Richtung zum Nordpol in Ruhelage (Welt-y = oben, Welt-z = -CAD-y)
  const angle = THREE.MathUtils.degToRad(splitDeg);
  const towardY = Math.cos(angle);
  const towardZ = Math.sin(angle);

  for (let i = 0; i < position.count; i += 3) {
    let y = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      y += position.getY(i + k) / 3;
      z += position.getZ(i + k) / 3;
    }
    const pole = (y - axisY) * towardY + (z - axisZ) * towardZ >= 0 ? northColor : southColor;
    for (let k = 0; k < 3; k++) pole.toArray(colors, (i + k) * 3);
  }

  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * Eigenes Material je Teil der Mausrad-Baugruppe - im CAD teilen sich alle
 * dasselbe Grau. Aussehen aus MOUSE_WHEEL.looks; ohne Eintrag bleibt die
 * CAD-Farbe.
 */
function wheelPartMaterial(cache, name, source) {
  if (cache.has(name)) return cache.get(name);

  const base = Array.isArray(source) ? source[0] : source;
  const look = MOUSE_WHEEL.looks?.[name];
  const material = new THREE.MeshStandardMaterial({
    name: `Mausrad ${name}`,
    // Magnet: Farbe kommt je Pol aus den Vertex-Farben.
    color: look?.magnet ? 0xffffff : look ? new THREE.Color(look.color) : base.color.clone(),
    vertexColors: Boolean(look?.magnet),
    roughness: look?.roughness ?? base.roughness ?? 0.7,
    metalness: look?.metalness ?? base.metalness ?? 0,
    // CAD-Materialien sind doppelseitig. Durchscheinend wuerden Vorder- und
    // Rueckseiten uebereinander flimmern - die Teile sind geschlossene
    // Koerper, die Vorderseiten genuegen.
    side: THREE.FrontSide,
  });
  cache.set(name, material);
  return material;
}

/**
 * Baut aus den gefundenen Linsen je Status-LED einen Leuchtzustand: eigenes
 * Material (Farbe + Emission) und einen flachen, additiven Lichtschein auf der
 * Platine - ohne echte Lichtquelle, die jeden Shader der Szene verteuern
 * wuerde.
 */
function buildStatusLeds(ledLenses, groups) {
  const leds = [];
  const glowTexture = createGlowTexture();
  const onColor = new THREE.Color(STATUS_LED_COLOR);

  for (const config of STATUS_LEDS) {
    const lens = ledLenses.get(config);
    if (!lens) {
      console.warn(`[Platine] Linse von ${config.id} nicht gefunden.`);
      continue;
    }

    const { material, box } = lens;
    material.emissive = onColor.clone();
    material.emissiveIntensity = 0;

    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: glowTexture,
        color: onColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    // Flacher Lichtschein auf der Platine rund um die LED - ein aufrechter
    // Sprite wuerde zur Haelfte in der Platine stecken und abgeschnitten.
    const size = Math.max(box.max.x - box.min.x, box.max.z - box.min.z) * 3.6;
    glow.scale.set(size, size, 1);
    glow.rotation.x = -Math.PI / 2;
    glow.position.copy(box.getCenter(new THREE.Vector3()));
    glow.position.y =
      config.side === "bottom"
        ? BOARD.bottomSurfaceZ * WORLD_PER_MM - 0.012
        : BOARD.topSurfaceZ * WORLD_PER_MM + 0.012;
    glow.visible = false;
    glow.renderOrder = 2;
    groups[config.side].add(glow);

    leds.push({
      id: config.id,
      side: config.side,
      button: config.button ?? null,
      slide: config.slide ?? null,
      position: config.position ?? null,
      material,
      offColor: material.color.clone(),
      onColor,
      glow,
      level: 0,
    });
  }

  return leds;
}

/** Weicher, radialer Verlauf fuer den Lichtschein der LEDs. */
function createGlowTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d");
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.25, "rgba(255,255,255,0.6)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Status-LED, deren Linse dieses Mesh ist - oder null. */
function matchStatusLedLens(object, box) {
  if (Array.isArray(object.material) || object.material.name !== STATUS_LED_LENS_MATERIAL) return null;

  const tolerance = 0.6 * WORLD_PER_MM;
  const centerX = (box.min.x + box.max.x) / 2;
  const centerZ = (box.min.z + box.max.z) / 2;
  return (
    STATUS_LEDS.find(
      (led) =>
        Math.abs(centerX - worldX(led.x)) <= tolerance && Math.abs(centerZ - worldZ(led.y)) <= tolerance
    ) ?? null
  );
}

/**
 * Baut aus den abgetrennten Hebeln je Schiebeschalter ein bewegliches Objekt.
 * Die beiden Endstellungen ergeben sich aus dem Schlitz: Der Hebel hat an
 * beiden Enden denselben Abstand zur Schlitzkante wie in der CAD-Lage.
 */
function buildSlideSwitches(leverParts, groups, flip) {
  const switches = [];
  const sideBox = new THREE.Box3();

  for (const config of SLIDE_SWITCHES) {
    const parts = leverParts.get(config);
    if (!parts) {
      console.warn(`[Platine] Hebel von Schiebeschalter ${config.id} nicht gefunden.`);
      continue;
    }

    const object3D = new THREE.Group();
    object3D.name = `Schiebeschalter ${config.id}`;
    const footprint = new THREE.Box3();
    const model = new THREE.Box3();

    for (const { object, box } of parts) {
      object3D.add(createBatch(bakeGeometry(object, false), object.material));
      model.union(box);
      sideBox.copy(box);
      if (config.side === "bottom") sideBox.applyMatrix4(flip);
      footprint.union(sideBox);
    }
    groups[config.side].add(object3D, createLeverSocketCap(model, config.side, parts[0].object.material));

    // Lage des Hebels in CAD-x und daraus die zweite Endstellung
    const leverMin = model.min.x / WORLD_PER_MM + BOARD_CENTER_MM.x;
    const leverMax = model.max.x / WORLD_PER_MM + BOARD_CENTER_MM.x;
    const { min: slotMin, max: slotMax } = config.slotMm;
    const atMax = slotMax - leverMax < leverMin - slotMin;
    const margin = atMax ? slotMax - leverMax : leverMin - slotMin;
    const otherOffset = atMax ? slotMin + margin - leverMin : slotMax - margin - leverMax;
    const positions = atMax
      ? [
          { offsetMm: otherOffset, label: config.labels.min },
          { offsetMm: 0, label: config.labels.max },
        ]
      : [
          { offsetMm: 0, label: config.labels.min },
          { offsetMm: otherOffset, label: config.labels.max },
        ];

    // Die Unterseite ist um Z gekippt: CAD-x laeuft dort gegen die Welt-x.
    const sideSign = config.side === "bottom" ? -1 : 1;
    const footprintBottom = Math.min(footprint.min.y, footprint.max.y);
    // Verfahrweg des Hebels in Seitenkoordinaten (beide Endstellungen umfasst)
    const shifts = positions.map((entry) => entry.offsetMm * WORLD_PER_MM * sideSign);
    const slot = {
      minX: footprint.min.x + Math.min(...shifts),
      maxX: footprint.max.x + Math.max(...shifts),
      minZ: footprint.min.z,
      maxZ: footprint.max.z,
    };
    switches.push({
      id: config.id,
      side: config.side,
      sideSign,
      minX: footprint.min.x,
      maxX: footprint.max.x,
      minZ: footprint.min.z,
      maxZ: footprint.max.z,
      top: footprint.max.y,
      bottom: footprintBottom,
      slot,
      /** Info-Box-Zone um die Schaltermitte, in Seitenkoordinaten wie die Figur. */
      info: {
        x: (slot.minX + slot.maxX) / 2,
        z: (slot.minZ + slot.maxZ) / 2,
        radius: (config.infoRadiusMm ?? 0) * WORLD_PER_MM,
      },
      /** Endstellungen in CAD-x, aufsteigend. */
      positions,
      offsetMm: 0,
      target: positions.find((entry) => entry.offsetMm === 0),
      object3D,
    });
    console.log(
      `[Platine] Schiebeschalter ${config.id}: Hebel ${leverMin.toFixed(2)}..${leverMax.toFixed(2)} mm, ` +
        `Weg ${Math.abs(otherOffset).toFixed(2)} mm, Stellung ${atMax ? config.labels.max : config.labels.min}`
    );
  }

  return switches;
}

/**
 * Im CAD hat der Schlitzboden unter dem Hebel eine Aussparung, und der Hebel
 * selbst ist unten offen. Rutscht er weg, bliebe dort ein Loch ins leere
 * Schaltergehaeuse - dieser feste Deckel auf Hoehe des Schlitzbodens schliesst
 * es. Steht der Hebel darueber, liegt der Deckel unsichtbar in ihm.
 *
 * @param {THREE.Box3} leverBox Hebel in Weltkoordinaten (Ausgangsstellung)
 */
function createLeverSocketCap(leverBox, side, material) {
  const geometry = new THREE.PlaneGeometry(
    leverBox.max.x - leverBox.min.x,
    leverBox.max.z - leverBox.min.z
  );
  // Normale weg von der Platine: auf der Unterseite zeigt sie nach unten.
  const awayFromBoard = side === "bottom" ? -1 : 1;
  geometry.rotateX((-Math.PI / 2) * awayFromBoard);
  geometry.translate(
    (leverBox.min.x + leverBox.max.x) / 2,
    side === "bottom" ? leverBox.max.y : leverBox.min.y,
    (leverBox.min.z + leverBox.max.z) / 2
  );

  const cap = createBatch(geometry, material);
  cap.name = "Schiebeschalter Deckel";
  return cap;
}

/**
 * Rastert die Dreiecke der sichtbaren Geometrie in ein Hoehengitter.
 *
 * Bewusst dreiecksgenau statt ueber Bounding-Boxen: nur so folgt die begehbare
 * Flaeche der echten Platinenkontur (die Platine ist controller-foermig, nicht
 * rechteckig) und nur so entsteht ausserhalb ein echtes Loch, in das der
 * Charakter faellt. Zellen ohne Treffer bleiben NaN.
 *
 * Jede Zelle haelt mehrere Schichten, damit ueberdeckte Flaechen - die Platine
 * unter dem Display - nicht von der Flaeche darueber verdeckt werden.
 *
 * Zu hohe Flaechen werden uebersprungen, sonst waere die Oberkante des
 * Joystick-Kopfes der "Boden" unter ihm.
 */
function buildHeightField(groups, matrix, bounds, walkY) {
  const minX = bounds.min.x - HEIGHT_CELL_SIZE;
  const minZ = bounds.min.z - HEIGHT_CELL_SIZE;
  const cols = Math.ceil((bounds.max.x - minX) / HEIGHT_CELL_SIZE) + 1;
  const rows = Math.ceil((bounds.max.z - minZ) / HEIGHT_CELL_SIZE) + 1;
  const data = new Float32Array(cols * rows * MAX_LAYERS).fill(NaN);
  const field = { data, cols, rows, minX, minZ, baseY: walkY };
  const limitY = walkY + MAX_GROUND_HEIGHT_MM * WORLD_PER_MM;

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (const group of groups) {
    for (const mesh of group.children) {
      const position = mesh.geometry.attributes.position;
      const normals = mesh.geometry.attributes.normal;
      const index = mesh.geometry.index;
      const count = index ? index.count : position.count;

      for (let i = 0; i < count; i += 3) {
        const i0 = index ? index.getX(i) : i;
        const i1 = index ? index.getX(i + 1) : i + 1;
        const i2 = index ? index.getX(i + 2) : i + 2;

        a.fromBufferAttribute(position, i0).applyMatrix4(matrix);
        b.fromBufferAttribute(position, i1).applyMatrix4(matrix);
        c.fromBufferAttribute(position, i2).applyMatrix4(matrix);

        // Komplette Dreiecke verwerfen, die ueber das Limit reichen - sonst
        // entstuenden an den Flanken hoher Bauteile Plateaus auf Limit-Hoehe.
        if (Math.max(a.y, b.y, c.y) > limitY) continue;

        // Nach unten zeigende Flaechen sind Decken, kein Boden. Ohne diesen
        // Filter waere die Unterseite des Displays eine begehbare Schicht.
        normal
          .set(
            normals.getX(i0) + normals.getX(i1) + normals.getX(i2),
            normals.getY(i0) + normals.getY(i1) + normals.getY(i2),
            normals.getZ(i0) + normals.getZ(i1) + normals.getZ(i2)
          )
          .transformDirection(matrix);
        if (normal.y <= 0) continue;

        rasterizeTriangle(a, b, c, field);
      }
    }
  }

  return field;
}

/**
 * Legt eine Flaechenhoehe in einer Zelle ab. Dicht beieinander liegende
 * Flaechen werden zu einer Schicht zusammengefasst.
 */
function insertLayer(data, base, height) {
  let free = -1;

  for (let k = 0; k < MAX_LAYERS; k++) {
    const value = data[base + k];

    if (Number.isNaN(value)) {
      if (free < 0) free = k;
      continue;
    }

    if (Math.abs(value - height) <= LAYER_MERGE) {
      if (height > value) data[base + k] = height;
      return;
    }
  }

  if (free >= 0) {
    data[base + free] = height;
    return;
  }

  collapseClosest(data, base, height);
}

/** Scratch fuer das Zusammenlegen - spart eine Allokation je Dreieck. */
const layerScratch = new Float64Array(MAX_LAYERS + 1);

/**
 * Zelle ist voll: die beiden dichtesten Schichten verschmelzen. Unterste und
 * oberste Flaeche bleiben dabei immer erhalten.
 */
function collapseClosest(data, base, height) {
  for (let k = 0; k < MAX_LAYERS; k++) layerScratch[k] = data[base + k];
  layerScratch[MAX_LAYERS] = height;
  layerScratch.sort();

  let drop = 0;
  let smallest = Infinity;

  for (let k = 1; k <= MAX_LAYERS; k++) {
    const gap = layerScratch[k] - layerScratch[k - 1];
    if (gap < smallest) {
      smallest = gap;
      drop = k - 1;
    }
  }

  let write = 0;
  for (let k = 0; k <= MAX_LAYERS; k++) {
    if (k !== drop) data[base + write++] = layerScratch[k];
  }
}

/** Scanline-freie Variante: Zellmittelpunkte im Dreiecks-Bounding-Rechteck testen. */
function rasterizeTriangle(a, b, c, field) {
  const { data, cols, rows, minX, minZ } = field;

  const colStart = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - minX) / HEIGHT_CELL_SIZE));
  const colEnd = Math.min(cols - 1, Math.floor((Math.max(a.x, b.x, c.x) - minX) / HEIGHT_CELL_SIZE));
  const rowStart = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - minZ) / HEIGHT_CELL_SIZE));
  const rowEnd = Math.min(rows - 1, Math.floor((Math.max(a.z, b.z, c.z) - minZ) / HEIGHT_CELL_SIZE));
  if (colStart > colEnd || rowStart > rowEnd) return;

  // Flaeche in der XZ-Projektion. Nahezu senkrechte Dreiecke (Bauteilflanken)
  // haben hier fast keine Flaeche und treffen deshalb keine Zellmitte.
  const area = (b.x - a.x) * (c.z - a.z) - (c.x - a.x) * (b.z - a.z);
  if (Math.abs(area) < 1e-9) return;
  const inverseArea = 1 / area;

  for (let row = rowStart; row <= rowEnd; row++) {
    const pz = minZ + (row + 0.5) * HEIGHT_CELL_SIZE;
    const offset = row * cols;

    for (let col = colStart; col <= colEnd; col++) {
      const px = minX + (col + 0.5) * HEIGHT_CELL_SIZE;

      const w0 = ((b.x - px) * (c.z - pz) - (c.x - px) * (b.z - pz)) * inverseArea;
      if (w0 < 0 || w0 > 1) continue;
      const w1 = ((c.x - px) * (a.z - pz) - (a.x - px) * (c.z - pz)) * inverseArea;
      if (w1 < 0 || w1 > 1) continue;
      const w2 = 1 - w0 - w1;
      if (w2 < 0 || w2 > 1) continue;

      const height = w0 * a.y + w1 * b.y + w2 * c.y;
      insertLayer(data, (offset + col) * MAX_LAYERS, height);
    }
  }
}

/**
 * Wirft Hindernis-Rechtecke weg, die vollstaendig in einem anderen liegen. Ein
 * Bauteil besteht im CAD-Modell aus vielen Einzel-Solids, die sich gegenseitig
 * umschliessen - das duennt die Liste deutlich aus, ohne die blockierte
 * Flaeche zu veraendern.
 */
function dropContained(boxes) {
  const sorted = [...boxes].sort((a, b) => area(b) - area(a));
  const kept = [];

  for (const box of sorted) {
    if (!kept.some((other) => contains(other, box))) kept.push(box);
  }

  return kept;
}

const area = (b) => (b.maxX - b.minX) * (b.maxZ - b.minZ);

const contains = (outer, inner) =>
  outer.minX <= inner.minX &&
  outer.maxX >= inner.maxX &&
  outer.minZ <= inner.minZ &&
  outer.maxZ >= inner.maxZ &&
  outer.top >= inner.top;

/** Dieselbe Ausduennung fuer die 3D-Boxen der Kamera-Kollision. */
function dropContained3D(boxes) {
  const sorted = [...boxes].sort((a, b) => volume(b) - volume(a));
  const kept = [];

  for (const box of sorted) {
    if (!kept.some((other) => contains3D(other, box))) kept.push(box);
  }

  return kept;
}

const volume = (b) => (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ);

const contains3D = (outer, inner) =>
  outer.minX <= inner.minX &&
  outer.maxX >= inner.maxX &&
  outer.minY <= inner.minY &&
  outer.maxY >= inner.maxY &&
  outer.minZ <= inner.minZ &&
  outer.maxZ >= inner.maxZ;

/** Scratch fuer den Grundriss-Zuschnitt. */
const edgeA = new THREE.Vector3();
const edgeB = new THREE.Vector3();
const edgeC = new THREE.Vector3();

/**
 * Grundriss der Geometrie im Hoehenband [minY, maxY] - also genau dort, wo der
 * Chip anstoesst. Die Bounding-Box des ganzen Meshes waere viel zu grob: der
 * Joystick-Kopf steht ringsum ueber seinem Sockel, und die Loetpins liegen
 * flach auf der Platine.
 *
 * Dreiecke werden am Band beschnitten, damit auch senkrechte Waende zaehlen,
 * deren Eckpunkte alle ausserhalb liegen.
 */
function bandFootprint(mesh, matrix, minY, maxY) {
  const position = mesh.geometry.attributes.position;
  const index = mesh.geometry.index;
  const count = index ? index.count : position.count;

  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;

  const add = (x, z) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };

  for (let i = 0; i < count; i += 3) {
    edgeA.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
    edgeB.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix);
    edgeC.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix);

    if (Math.min(edgeA.y, edgeB.y, edgeC.y) > maxY) continue;
    if (Math.max(edgeA.y, edgeB.y, edgeC.y) < minY) continue;

    clipEdge(edgeA, edgeB, minY, maxY, add);
    clipEdge(edgeB, edgeC, minY, maxY, add);
    clipEdge(edgeC, edgeA, minY, maxY, add);
  }

  return minX === Infinity ? null : { minX, maxX, minZ, maxZ };
}

/** Uebergibt den Teil der Kante, der im Band liegt. */
function clipEdge(p, q, minY, maxY, add) {
  let t0 = 0;
  let t1 = 1;
  const dy = q.y - p.y;

  if (Math.abs(dy) < 1e-9) {
    if (p.y < minY || p.y > maxY) return;
  } else {
    const ta = (minY - p.y) / dy;
    const tb = (maxY - p.y) / dy;
    t0 = Math.max(t0, Math.min(ta, tb));
    t1 = Math.min(t1, Math.max(ta, tb));
    if (t0 > t1) return;
  }

  add(p.x + (q.x - p.x) * t0, p.z + (q.z - p.z) * t0);
  add(p.x + (q.x - p.x) * t1, p.z + (q.z - p.z) * t1);
}

/** Klont die Geometrie und backt die Welt-Transformation des Meshes ein. */
function bakeGeometry(mesh, stripAttributes) {
  const geometry = mesh.geometry.clone();

  if (stripAttributes) {
    for (const name of Object.keys(geometry.attributes)) {
      if (!KEPT_ATTRIBUTES.includes(name)) geometry.deleteAttribute(name);
    }
    geometry.morphAttributes = {};
    geometry.clearGroups();
  }

  geometry.applyMatrix4(mesh.matrixWorld);
  return geometry;
}

/** mergeGeometries verlangt identische Attribute und gleiche Index-Variante. */
function geometrySignature(geometry) {
  return `${Object.keys(geometry.attributes).sort().join(",")}|${geometry.index ? "i" : "n"}`;
}

function mergeBucket(bucket, name) {
  const group = new THREE.Group();
  group.name = name;

  for (const { material, geometries } of bucket.values()) {
    const merged = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false);

    if (merged) {
      if (merged !== geometries[0]) geometries.forEach((geometry) => geometry.dispose());
      group.add(createBatch(merged, material));
      continue;
    }

    // Sollte nicht vorkommen; falls doch, lieber einzeln rendern als verlieren.
    console.warn(`[Platine] Merge fehlgeschlagen fuer Material "${material.name}"`);
    for (const geometry of geometries) group.add(createBatch(geometry, material));
  }

  return group;
}

function createBatch(geometry, material) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  // Die Platine wirft bewusst keinen Schatten: der Shadow-Pass muesste sonst
  // das komplette Modell ein zweites Mal zeichnen. Schatten wirft nur der
  // Charakter, die Platine faengt ihn auf.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  return mesh;
}

function disposeSource(source) {
  source.traverse((object) => {
    if (object.isMesh) object.geometry.dispose();
  });
  source.clear();
}
