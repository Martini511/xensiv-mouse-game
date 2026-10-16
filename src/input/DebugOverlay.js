import { keyLabel } from "./KeyboardMouseInput.js";

/**
 * Einfaches HTML-Overlay zur Live-Kontrolle der Tastatur- und Mauseingaben.
 * Ist bewusst unabhaengig von Three.js, damit es auch ohne laufende Szene
 * nutzbar bleibt.
 */
export class DebugOverlay {
  constructor(parent = document.body) {
    this.element = document.createElement("div");
    this.element.id = "debug-overlay";
    parent.appendChild(this.element);
    this._lastMarkup = "";
  }

  /**
   * @param {object} inputState State-Objekt von KeyboardMouseInput
   * @param {object} extra Zusaetzliche Werte (FPS, Seite, ...)
   */
  update(inputState, extra = {}) {
    const lines = [];

    if (inputState.pointerLocked) {
      lines.push(`<span class="status-connected">● Maus gefangen</span>`);
      lines.push(`  Esc gibt die Maus frei.`);
    } else if (inputState.lockAvailable) {
      lines.push(`<span class="status-disconnected">● Maus frei</span>`);
      lines.push(`  Ins Spiel klicken,`);
      lines.push(`  um mit der Maus zu schauen.`);
    } else {
      lines.push(`<span class="status-disconnected">● Kein Pointer Lock</span>`);
      lines.push(`  Zum Umsehen mit gedrueckter`);
      lines.push(`  linker Maustaste ziehen.`);
    }
    lines.push(
      inputState.gamepadConnected
        ? `<span class="status-connected">● Controller verbunden</span> (Notfall)`
        : `  Notfall: Controller anstecken,`
    );
    if (!inputState.gamepadConnected) lines.push(`  eine Taste druecken.`);

    lines.push("");
    lines.push(`Bewegung x ${fmt(inputState.move.x)}  y ${fmt(inputState.move.y)}`);
    lines.push(`Maus     x ${fmt(inputState.look.x)}  y ${fmt(inputState.look.y)}`);
    lines.push(`R-Stick  x ${fmt(inputState.stick.x)}  y ${fmt(inputState.stick.y)}`);
    lines.push(`Tasten   ${escapeHtml(inputState.keys.map(keyLabel).join(", ") || "-")}`);

    for (const [key, value] of Object.entries(extra)) {
      lines.push(`${key.padEnd(8)} ${value}`);
    }

    const markup = lines.join("\n");
    if (markup !== this._lastMarkup) {
      this.element.innerHTML = markup;
      this._lastMarkup = markup;
    }
  }

  dispose() {
    this.element.remove();
  }
}

function fmt(value) {
  const fixed = value.toFixed(2);
  return (value >= 0 ? " " : "") + fixed;
}

// Tastencodes landen in innerHTML.
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
  });
}
